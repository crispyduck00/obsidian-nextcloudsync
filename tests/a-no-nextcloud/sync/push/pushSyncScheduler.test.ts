import { PushSyncScheduler } from '../../../../src/sync/push/PushSyncScheduler';

const GENERIC_NOTIFICATION = { fileIds: null, raw: 'notify_file' } as const;
const targetedScope = (rootFileId: string | null = 'root-id', rootEtag = 'etag-1') => ({
  kind: 'targeted' as const, rootFileId, rootEtag,
});
const ignoreScope = { kind: 'ignore' as const };
const fullSyncScope = { kind: 'full-sync' as const };
const immediateFullSync = { fullSyncQuietMs: 0, fullSyncMaxDelayMs: 0 } as const;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('PushSyncScheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('debounces a burst into one reconciliation', async () => {
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync, isSyncRunning: () => false, sync, debounceMs: 350 });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(200);
    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(349);
    expect(sync).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('keeps the notification pending while another full sync is running', async () => {
    let running = true;
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync, isSyncRunning: () => running, sync, debounceMs: 0 });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(true);

    running = false;
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('runs one more reconciliation when a push arrives during its own sync', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const sync = jest.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const scheduler = new PushSyncScheduler({ ...immediateFullSync, isSyncRunning: () => false, sync, debounceMs: 0 });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(1);

    scheduler.notify({ fileIds: ['42'], raw: 'notify_file_id [42]' });
    jest.advanceTimersByTime(0);
    expect(sync).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
    await Promise.resolve();
    jest.advanceTimersByTime(0);
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('contains a reconciliation failure instead of leaking an unhandled rejection', async () => {
    const log = jest.fn();
    const sync = jest.fn(async () => { throw new Error('boom'); });
    const scheduler = new PushSyncScheduler({ ...immediateFullSync, isSyncRunning: () => false, sync, debounceMs: 0, log });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reconciliation failed'));
  });

  it('stop cancels a pending reconciliation', () => {
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync, isSyncRunning: () => false, sync, debounceMs: 350 });

    scheduler.notify(GENERIC_NOTIFICATION);
    scheduler.stop();
    jest.advanceTimersByTime(1000);

    expect(sync).not.toHaveBeenCalled();
  });

  it('skips the ordinary sync and activity signal when the scope check proves the vault is unchanged', async () => {
    const shouldSync = jest.fn(async () => false);
    const onReconciliationTriggered = jest.fn();
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false, shouldSync, onReconciliationTriggered, sync, debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['42'], raw: 'notify_file_id [42]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(shouldSync).toHaveBeenCalledTimes(1);
    expect(onReconciliationTriggered).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
    expect(scheduler.getStatus().lastTriggeredSyncAt).toBeNull();
  });

  it('signals activity and falls back to the ordinary sync when the scope check cannot decide', async () => {
    const log = jest.fn();
    const shouldSync = jest.fn(async () => { throw new Error('etag probe failed'); });
    const onReconciliationTriggered = jest.fn();
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false, shouldSync, onReconciliationTriggered, sync, debounceMs: 0, log,
    });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onReconciliationTriggered).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('scope check failed'));
  });

  it('signals activity once when a vault-relevant push triggers reconciliation', async () => {
    const onReconciliationTriggered = jest.fn();
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => true,
      onReconciliationTriggered,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['42'], raw: 'notify_file_id [42]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onReconciliationTriggered).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not lose a newer push that arrives while the scope check is running', async () => {
    let resolveFirst!: (value: boolean) => void;
    const first = new Promise<boolean>((resolve) => { resolveFirst = resolve; });
    const shouldSync = jest.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(true);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false, shouldSync, sync, debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['1'], raw: 'notify_file_id [1]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    expect(shouldSync).toHaveBeenCalledTimes(1);

    scheduler.notify({ fileIds: ['2'], raw: 'notify_file_id [2]' });
    resolveFirst(false);
    await first;
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(shouldSync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('keeps the push pending if a full sync starts during the scope check', async () => {
    let running = false;
    let resolveCheck!: (value: boolean) => void;
    const check = new Promise<boolean>((resolve) => { resolveCheck = resolve; });
    const shouldSync = jest.fn()
      .mockImplementationOnce(() => check)
      .mockResolvedValue(true);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => running, shouldSync, sync, debounceMs: 0,
    });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await Promise.resolve();

    running = true;
    resolveCheck(true);
    await check;
    await Promise.resolve();
    await Promise.resolve();

    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(true);

    jest.advanceTimersByTime(0);
    await Promise.resolve();
    running = false;
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not start a sync after stop while a scope check is in flight', async () => {
    let resolveCheck!: (value: boolean) => void;
    const check = new Promise<boolean>((resolve) => { resolveCheck = resolve; });
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false, shouldSync: () => check, sync, debounceMs: 0,
    });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    scheduler.stop();
    resolveCheck(true);
    await check;
    await Promise.resolve();
    await Promise.resolve();

    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('reconciles known file IDs selectively after the vault scope check passes', async () => {
    const reconcileFileIds = jest.fn(async () => 'done' as const);
    const sync = jest.fn(async () => {});
    const onReconciliationTriggered = jest.fn();
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope(),
      onReconciliationTriggered,
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['42', '42', '43'], raw: 'notify_file_id [42,42,43]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileFileIds).toHaveBeenCalledTimes(1);
    expect(reconcileFileIds).toHaveBeenCalledWith({ fileIds: ['42', '43'], rootFileId: 'root-id' });
    expect(sync).not.toHaveBeenCalled();
    expect(onReconciliationTriggered).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().lastTriggeredSyncAt).not.toBeNull();
  });

  it('keeps generic notify_file on the ordinary full-sync path even when targeted reconcile exists', async () => {
    const reconcileFileIds = jest.fn(async () => 'done' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope(),
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileFileIds).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('falls back to one ordinary sync when targeted reconciliation reports ambiguity', async () => {
    const reconcileFileIds = jest.fn(async () => 'full-sync' as const);
    const sync = jest.fn(async () => {});
    const onReconciliationTriggered = jest.fn();
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope(),
      onReconciliationTriggered,
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['42'], raw: 'notify_file_id [42]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileFileIds).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onReconciliationTriggered).toHaveBeenCalledTimes(1);
  });

  it('restores a targeted batch when the reconciler reports busy', async () => {
    const reconcileFileIds = jest.fn()
      .mockResolvedValueOnce('busy' as const)
      .mockResolvedValueOnce('done' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope(),
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['42'], raw: 'notify_file_id [42]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.getStatus().pending).toBe(true);
    expect(sync).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileFileIds).toHaveBeenCalledTimes(2);
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('does not run targeted reconciliation when the vault scope check proves the push irrelevant', async () => {
    const reconcileFileIds = jest.fn(async () => 'done' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => ignoreScope,
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['42'], raw: 'notify_file_id [42]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileFileIds).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('ignores a generic notification when the scope probe proves the vault is unchanged', async () => {
    const reconcileFileIds = jest.fn(async () => 'done' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => ignoreScope,
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileFileIds).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('uses the ordinary sync when the scope result is uncertain even if file IDs are present', async () => {
    const reconcileFileIds = jest.fn(async () => 'done' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => fullSyncScope,
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['42'], raw: 'notify_file_id [42]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileFileIds).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('falls back to exactly one ordinary sync when targeted reconciliation throws', async () => {
    const log = jest.fn();
    const reconcileFileIds = jest.fn(async () => { throw new Error('targeted boom'); });
    const sync = jest.fn(async () => {});
    const onReconciliationTriggered = jest.fn();
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope(),
      onReconciliationTriggered,
      reconcileFileIds,
      sync,
      log,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['42'], raw: 'notify_file_id [42]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileFileIds).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onReconciliationTriggered).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('targeted reconciliation failed'));
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('keeps a push that arrives while targeted reconciliation is in flight for a second batch', async () => {
    let resolveFirst!: (value: 'done') => void;
    const first = new Promise<'done'>((resolve) => { resolveFirst = resolve; });
    const reconcileFileIds = jest.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue('done' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope(),
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['1'], raw: 'notify_file_id [1]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcileFileIds).toHaveBeenCalledTimes(1);

    scheduler.notify({ fileIds: ['2'], raw: 'notify_file_id [2]' });
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    expect(reconcileFileIds).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().pending).toBe(true);

    resolveFirst('done');
    await first;
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileFileIds).toHaveBeenCalledTimes(2);
    expect(reconcileFileIds.mock.calls[0][0]).toEqual({ fileIds: ['1'], rootFileId: 'root-id' });
    expect(reconcileFileIds.mock.calls[1][0]).toEqual({ fileIds: ['2'], rootFileId: 'root-id' });
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });


  it('checkpoints a successful targeted root ETag and ignores a later all-untracked push at that same root state', async () => {
    const reconcileFileIds = jest.fn()
      .mockResolvedValueOnce('done' as const)
      .mockResolvedValueOnce('untracked' as const);
    const sync = jest.fn(async () => {});
    let rootEtag = 'etag-1';
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', rootEtag),
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['known'], raw: 'notify_file_id [known]' });
    jest.advanceTimersByTime(0);
    await flush();
    expect(reconcileFileIds).toHaveBeenCalledTimes(1);

    scheduler.notify({ fileIds: ['outside'], raw: 'notify_file_id [outside]' });
    jest.advanceTimersByTime(0);
    await flush();

    expect(reconcileFileIds).toHaveBeenCalledTimes(2);
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('turns an all-untracked push at a newer root ETag into one debounced full sync', async () => {
    const reconcileFileIds = jest.fn()
      .mockResolvedValueOnce('done' as const)
      .mockResolvedValue('untracked' as const);
    const sync = jest.fn(async () => {});
    let rootEtag = 'etag-1';
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', rootEtag),
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['known'], raw: 'notify_file_id [known]' });
    jest.advanceTimersByTime(0);
    await flush();

    rootEtag = 'etag-2';
    scheduler.notify({ fileIds: ['new-or-unknown'], raw: 'notify_file_id [new-or-unknown]' });
    jest.advanceTimersByTime(0);
    await flush();
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(true);

    jest.advanceTimersByTime(2999);
    await flush();
    expect(sync).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('uses the observed root checkpoint for generic notify_file noise too', async () => {
    const reconcileFileIds = jest.fn(async () => 'done' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', 'etag-1'),
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['known'], raw: 'notify_file_id [known]' });
    jest.advanceTimersByTime(0);
    await flush();

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await flush();

    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('still reconciles concrete IDs when a coalesced generic hint adds no new root state', async () => {
    const reconcileFileIds = jest.fn(async (_batch: unknown) => 'done' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', 'etag-1'),
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['known-a'], raw: 'notify_file_id [known-a]' });
    jest.advanceTimersByTime(0);
    await flush();

    scheduler.notify(GENERIC_NOTIFICATION);
    scheduler.notify({ fileIds: ['known-b'], raw: 'notify_file_id [known-b]' });
    jest.advanceTimersByTime(0);
    await flush();

    expect(reconcileFileIds).toHaveBeenCalledTimes(2);
    expect(reconcileFileIds.mock.calls[1][0]).toEqual({ fileIds: ['known-b'], rootFileId: 'root-id' });
    expect(sync).not.toHaveBeenCalled();
  });

  it('never lets the observed ETag suppress a known structural ambiguity', async () => {
    const reconcileFileIds = jest.fn()
      .mockResolvedValueOnce('done' as const)
      .mockResolvedValueOnce('full-sync' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', 'etag-1'),
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['known'], raw: 'notify_file_id [known]' });
    jest.advanceTimersByTime(0);
    await flush();

    scheduler.notify({ fileIds: ['known-rename'], raw: 'notify_file_id [known-rename]' });
    jest.advanceTimersByTime(0);
    await flush();
    expect(sync).not.toHaveBeenCalled();

    jest.advanceTimersByTime(3000);
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not advance the observed root checkpoint for deferred or unresolved targeted work', async () => {
    const reconcileFileIds = jest.fn()
      .mockResolvedValueOnce('deferred' as const)
      .mockResolvedValueOnce('untracked' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', 'etag-1'),
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['known'], raw: 'notify_file_id [known]' });
    jest.advanceTimersByTime(0);
    await flush();

    scheduler.notify({ fileIds: ['unknown'], raw: 'notify_file_id [unknown]' });
    jest.advanceTimersByTime(0);
    await flush();
    expect(scheduler.getStatus().pending).toBe(true);

    jest.advanceTimersByTime(3000);
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('resets the full-sync quiet window on a structural burst but never moves the max deadline', async () => {
    const reconcileFileIds = jest.fn(async () => 'untracked' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', 'etag-new'),
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['new-1'], raw: 'notify_file_id [new-1]' });
    jest.advanceTimersByTime(0);
    await flush();
    expect(scheduler.getStatus().pending).toBe(true);

    jest.advanceTimersByTime(2000);
    scheduler.notify({ fileIds: ['new-2'], raw: 'notify_file_id [new-2]' });
    jest.advanceTimersByTime(2500);
    await flush();
    expect(sync).not.toHaveBeenCalled(); // quiet deadline moved from 3s to 5s

    jest.advanceTimersByTime(500);
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('forces a full sync at max wait even if structural pushes never go quiet', async () => {
    const reconcileFileIds = jest.fn(async () => 'untracked' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', 'etag-new'),
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['new-1'], raw: 'notify_file_id [new-1]' });
    jest.advanceTimersByTime(0);
    await flush();

    for (const advance of [2000, 2000, 2000, 1500]) {
      jest.advanceTimersByTime(advance);
      scheduler.notify({ fileIds: [`noise-${advance}-${Date.now()}`], raw: 'notify_file_id' });
    }
    expect(sync).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500); // exactly 8s from the first structural requirement
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not start targeted work while a debounced full reconciliation is already pending', async () => {
    const reconcileFileIds = jest.fn()
      .mockResolvedValueOnce('untracked' as const)
      .mockResolvedValue('done' as const);
    const sync = jest.fn(async () => {});
    let rootEtag = 'etag-1';
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', rootEtag),
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['unknown'], raw: 'notify_file_id [unknown]' });
    jest.advanceTimersByTime(0);
    await flush();
    expect(reconcileFileIds).toHaveBeenCalledTimes(1);

    rootEtag = 'etag-2';
    jest.advanceTimersByTime(1000);
    scheduler.notify({ fileIds: ['known'], raw: 'notify_file_id [known]' });
    expect(reconcileFileIds).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(3000);
    await flush();
    expect(reconcileFileIds).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending fallback when an intervening authoritative sync has already caught up', async () => {
    const reconcileFileIds = jest.fn(async () => 'untracked' as const);
    const sync = jest.fn(async () => {});
    let scope: ReturnType<typeof targetedScope> | typeof ignoreScope = targetedScope('root-id', 'etag-new');
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false,
      shouldSync: async () => scope,
      reconcileFileIds,
      sync,
      debounceMs: 0,
      fullSyncQuietMs: 3000,
      fullSyncMaxDelayMs: 8000,
    });

    scheduler.notify({ fileIds: ['unknown'], raw: 'notify_file_id [unknown]' });
    jest.advanceTimersByTime(0);
    await flush();
    expect(scheduler.getStatus().pending).toBe(true);

    scope = ignoreScope;
    jest.advanceTimersByTime(3000);
    await flush();

    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('keeps a push-driven full reconciliation pending when the authoritative sync asks for retry', async () => {
    const sync = jest.fn()
      .mockResolvedValueOnce('retry' as const)
      .mockResolvedValueOnce('completed' as const);
    const scheduler = new PushSyncScheduler({
      ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => fullSyncScope,
      sync,
      debounceMs: 0,
    });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await flush();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().pending).toBe(true);

    jest.advanceTimersByTime(0);
    await flush();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('coalesces repeated remote catch-up requests into one root probe', async () => {
    const shouldSync = jest.fn(async () => ignoreScope);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync,
      sync,
      debounceMs: 0,
    });

    scheduler.requestRemoteCatchUp('foreground');
    scheduler.requestRemoteCatchUp('foreground duplicate');
    jest.advanceTimersByTime(0);
    await flush();

    expect(shouldSync).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('uses the observed push root checkpoint to dismiss a catch-up with no newer remote state', async () => {
    const reconcileFileIds = jest.fn(async () => 'done' as const);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', 'etag-1'),
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['known'], raw: 'notify_file_id [known]' });
    jest.advanceTimersByTime(0);
    await flush();
    expect(reconcileFileIds).toHaveBeenCalledTimes(1);

    scheduler.requestRemoteCatchUp('foreground');
    jest.advanceTimersByTime(0);
    await flush();

    expect(reconcileFileIds).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('falls back to an authoritative sync when catch-up sees a newer unexplained root state', async () => {
    const reconcileFileIds = jest.fn(async () => 'done' as const);
    const sync = jest.fn(async () => {});
    let rootEtag = 'etag-1';
    const scheduler = new PushSyncScheduler({
      ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', rootEtag),
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['known'], raw: 'notify_file_id [known]' });
    jest.advanceTimersByTime(0);
    await flush();

    rootEtag = 'etag-2';
    scheduler.requestRemoteCatchUp('foreground');
    jest.advanceTimersByTime(0);
    await flush();

    expect(reconcileFileIds).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('does not trust fresh file IDs to explain a newer root state discovered across a catch-up gap', async () => {
    const reconcileFileIds = jest.fn(async () => 'done' as const);
    const sync = jest.fn(async () => {});
    let rootEtag = 'etag-1';
    const scheduler = new PushSyncScheduler({
      ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync: async () => targetedScope('root-id', rootEtag),
      reconcileFileIds,
      sync,
      debounceMs: 0,
    });

    scheduler.notify({ fileIds: ['known-before-gap'], raw: 'notify_file_id [known-before-gap]' });
    jest.advanceTimersByTime(0);
    await flush();

    rootEtag = 'etag-2';
    scheduler.requestRemoteCatchUp('WebSocket reconnected');
    scheduler.notify({ fileIds: ['fresh-after-gap'], raw: 'notify_file_id [fresh-after-gap]' });
    jest.advanceTimersByTime(0);
    await flush();

    // The new concrete ID cannot prove that no other notification was missed while disconnected.
    expect(reconcileFileIds).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('keeps catch-up pending while an ordinary full sync is running and re-checks afterwards', async () => {
    let running = true;
    const shouldSync = jest.fn(async () => ignoreScope);
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      ...immediateFullSync,
      isSyncRunning: () => running,
      shouldSync,
      sync,
      debounceMs: 0,
    });

    scheduler.requestRemoteCatchUp('foreground');
    jest.advanceTimersByTime(0);
    await flush();
    expect(shouldSync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(true);

    running = false;
    jest.advanceTimersByTime(500);
    await flush();

    expect(shouldSync).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });

  it('stop cancels a pending remote catch-up', async () => {
    const shouldSync = jest.fn(async () => targetedScope('root-id', 'etag-new'));
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
      ...immediateFullSync,
      isSyncRunning: () => false,
      shouldSync,
      sync,
      debounceMs: 0,
    });

    scheduler.requestRemoteCatchUp('foreground');
    scheduler.stop();
    jest.advanceTimersByTime(0);
    await flush();

    expect(shouldSync).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
  });

});

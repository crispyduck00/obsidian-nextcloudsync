import { PushSyncScheduler } from '../../../../src/sync/push/PushSyncScheduler';

const GENERIC_NOTIFICATION = { fileIds: null, raw: 'notify_file' } as const;

describe('PushSyncScheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('debounces a burst into one reconciliation', async () => {
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ isSyncRunning: () => false, sync, debounceMs: 350 });

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
    const scheduler = new PushSyncScheduler({ isSyncRunning: () => running, sync, debounceMs: 0 });

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
    const scheduler = new PushSyncScheduler({ isSyncRunning: () => false, sync, debounceMs: 0 });

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
    const scheduler = new PushSyncScheduler({ isSyncRunning: () => false, sync, debounceMs: 0, log });

    scheduler.notify(GENERIC_NOTIFICATION);
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reconciliation failed'));
  });

  it('stop cancels a pending reconciliation', () => {
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({ isSyncRunning: () => false, sync, debounceMs: 350 });

    scheduler.notify(GENERIC_NOTIFICATION);
    scheduler.stop();
    jest.advanceTimersByTime(1000);

    expect(sync).not.toHaveBeenCalled();
  });

  it('skips the ordinary sync and activity signal when the scope check proves the vault is unchanged', async () => {
    const shouldSync = jest.fn(async () => false);
    const onReconciliationTriggered = jest.fn();
    const sync = jest.fn(async () => {});
    const scheduler = new PushSyncScheduler({
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
    const scheduler = new PushSyncScheduler({
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
    const scheduler = new PushSyncScheduler({
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
    const scheduler = new PushSyncScheduler({
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
    const scheduler = new PushSyncScheduler({
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
    const scheduler = new PushSyncScheduler({
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
});

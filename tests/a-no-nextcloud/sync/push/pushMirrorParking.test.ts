import { PushSyncScheduler } from '../../../../src/sync/push/PushSyncScheduler';

const changed = { kind: 'targeted' as const, rootEtag: 'changed', rootFileId: 'root' };

describe('Push scheduler exclusive-operation parking', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('parks an already classified full fallback without a timer until the host wakes it', async () => {
    let allowed = true;
    const sync = jest.fn(async () => 'completed' as const);
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false, canSync: () => allowed,
      shouldSync: async () => ({ kind: 'full-sync' }), sync,
    });
    try {
      scheduler.notify({ fileIds: null, raw: 'notify_file' });
      await jest.advanceTimersByTimeAsync(350);
      expect(scheduler.getStatus().pending).toBe(true);
      allowed = false;
      scheduler.onNetworkChanged();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(600000);
      expect(sync).not.toHaveBeenCalled();
      allowed = true;
      scheduler.onNetworkChanged();
      await jest.advanceTimersByTimeAsync(10000);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(scheduler.getStatus().pending).toBe(false);
    } finally { scheduler.stop(); }
  });

  test('rechecks a file batch if the host pauses while its operation is active', async () => {
    let allowed = true, finish!: () => void;
    const reconcile = jest.fn(async () => 'done' as const);
    reconcile.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve('done');
    }));
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false, canSync: () => allowed,
      shouldSync: async () => changed, reconcileFileIds: reconcile, sync: async () => {},
    });
    try {
      scheduler.notify({ fileIds: ['note'], raw: 'notify_file_id [note]' });
      await jest.advanceTimersByTimeAsync(350);
      allowed = false;
      finish();
      await jest.advanceTimersByTimeAsync(10000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(scheduler.getStatus().pending).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
      allowed = true;
      scheduler.onNetworkChanged();
      await jest.advanceTimersByTimeAsync(1000);
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(scheduler.getStatus().pending).toBe(false);
    } finally { scheduler.stop(); }
  });
});

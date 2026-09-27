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
});

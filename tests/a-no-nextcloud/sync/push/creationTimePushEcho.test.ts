import { CreationTimeAligner } from '../../../../src/sync/ctime/CreationTimeAligner';
import { PushSyncScheduler } from '../../../../src/sync/push/PushSyncScheduler';
import { remoteOf } from '../../support/engineHarness';

const path = 'note.md';
const OLD_TIME = Date.UTC(2020, 0, 1);
const NEW_TIME = Date.UTC(2025, 0, 1);

describe('creation-time changes and the existing conservative push scheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test.each([false, true])('a ctime echo settles without repeated PROPPATCH (root changes=%s)', async (changeRoot) => {
    let root = 'before';
    let storedRoot: string | null = 'before';
    let remoteCtime = NEW_TIME;
    let state: Record<string, unknown> = { path, remoteFileId: 'fid', localHash: 'body', remoteId: 'body', isConflicted: false };
    let busy = true;
    const local = { stat: async () => ({ size: 4, mtime: OLD_TIME, ctime: OLD_TIME }), creationTimeSupport: async () => 'settable', setCreationTime: jest.fn() };
    const db = { getFile: () => state, setFile: (v: Record<string, unknown>) => { state = v; }, setRemoteRootEtag: (v: string | null) => { storedRoot = v; } };
    let scheduler!: PushSyncScheduler;
    const client = { setCreationTime: jest.fn(async (_path: string, seconds: number) => {
      remoteCtime = seconds * 1000;
      if (changeRoot) root = 'after';
      scheduler.notify({ fileIds: null, raw: 'notify_file' });
      return 'applied' as const;
    }) };
    const aligner = new CreationTimeAligner({ localAdapter: local, stateDB: db, isBeingEdited: () => false } as never);
    const align = () => aligner.align(client as never, remoteOf(path, 'body', { creationTime: remoteCtime }));
    const fullSync = jest.fn(async () => { await align(); storedRoot = root; return 'completed' as const; });
    scheduler = new PushSyncScheduler({
      isSyncRunning: () => busy, sync: fullSync, debounceMs: 0, fullSyncQuietMs: 0, fullSyncMaxDelayMs: 0,
      shouldSync: async () => root === storedRoot ? { kind: 'ignore' } : { kind: 'targeted', rootEtag: root, rootFileId: 'root' },
    });
    await align();
    busy = false;
    await jest.runOnlyPendingTimersAsync();
    expect(client.setCreationTime).toHaveBeenCalledTimes(1);
    expect(fullSync).toHaveBeenCalledTimes(changeRoot ? 1 : 0);
    for (let i = 0; i < 4; i++) await align();
    expect(client.setCreationTime).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().pending).toBe(false);
    scheduler.stop();
  });
});

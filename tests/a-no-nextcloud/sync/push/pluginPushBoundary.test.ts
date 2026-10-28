import { PushSyncScheduler } from '../../../../src/sync/push/PushSyncScheduler';
import { RemotePushReconciler } from '../../../../src/sync/push/RemotePushReconciler';
import { buildEngine, makeLocalAdapter } from '../../support/engineHarness';
import type { FileState, DirState } from '../../../../src/types';

const pluginPath = '.obsidian/plugins/example/data.json';
const file = (path: string, id: string): FileState => ({ path, remoteFileId: id, localHash: 'h', remoteId: 'r', idType: 'etag', size: 1, mtime: 1, isConflicted: false });
function fixture() {
  const files = new Map([['plugin', file(pluginPath, 'plugin')], ['note', file('notes/n.md', 'note')]]);
  const dirs: DirState[] = [{ path: '.obsidian', remoteFileId: 'config' }, { path: '.obsidian/plugins', remoteFileId: 'plugins' }, { path: '.obsidian/plugins/example', remoteFileId: 'bundle' }, { path: 'notes', remoteFileId: 'notes' }];
  const reconcileFile = jest.fn(async () => 'done' as const);
  const reconciler = new RemotePushReconciler({
    stateDB: { getFileByRemoteId: (id) => files.get(id), getAllDirs: () => dirs },
    isFullSyncRunning: () => false,
    isPluginPath: (p) => p.startsWith('.obsidian/plugins/'), reconcileFile,
  });
  return { reconciler, reconcileFile };
}

it('defers known plugin bundles with positively identified ancestor/root propagation', async () => {
  const h = fixture();
  await expect(h.reconciler.reconcileFileIds({ fileIds: ['root', 'config', 'plugins', 'bundle', 'plugin'], rootFileId: 'root' })).resolves.toBe('plugin-pending');
  expect(h.reconcileFile).not.toHaveBeenCalled();
});

it('still processes known notes in a mixed known batch without certifying the pending bundle', async () => {
  const h = fixture();
  await expect(h.reconciler.reconcileFileIds({ fileIds: ['plugin', 'note', 'root'], rootFileId: 'root' })).resolves.toBe('plugin-pending');
  expect(h.reconcileFile).toHaveBeenCalledWith('notes/n.md', 'note');
});

it.each([['plugin', 'unknown'], ['plugin', 'notes'], ['root'], ['bundle']])('retains the structural/unknown fallback for %j', async (...fileIds) => {
  const h = fixture();
  await expect(h.reconciler.reconcileFileIds({ fileIds, rootFileId: 'root' })).resolves.toBe('full-sync');
  expect(h.reconcileFile).not.toHaveBeenCalled();
});

it('wires the engine plugin predicate before the ordinary out-of-session exclusion gate', async () => {
  const { engine, stateDB } = await buildEngine(makeLocalAdapter({}), {});
  stateDB.setFile(file(pluginPath, 'plugin'));
  await expect(engine.reconcileRemoteFileIds({ fileIds: ['plugin'], rootFileId: null })).resolves.toBe('plugin-pending');
});

describe('plugin noise and the scheduler root checkpoint', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not create immediate syncs or a retry loop for repeated known plugin writes', async () => {
    const h = fixture();
    const sync = jest.fn(async () => 'completed' as const);
    let root = 0;
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false, sync, debounceMs: 0, fullSyncQuietMs: 0, fullSyncMaxDelayMs: 0,
      shouldSync: async () => ({ kind: 'targeted', rootEtag: `r${root}`, rootFileId: 'root' }),
      reconcileFileIds: (b) => h.reconciler.reconcileFileIds(b),
    });
    for (root = 1; root <= 30; root++) {
      scheduler.notify({ fileIds: ['plugin', 'root'], raw: 'notify_file_id' });
      await jest.runOnlyPendingTimersAsync();
    }
    expect(sync).not.toHaveBeenCalled();
    expect(h.reconcileFile).not.toHaveBeenCalled();
    expect(scheduler.getStatus().pending).toBe(false);
    scheduler.stop();
  });

  it('does not let a deferred plugin certify a later generic notification at the same root', async () => {
    const h = fixture();
    const sync = jest.fn(async () => 'completed' as const);
    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => false, sync, debounceMs: 0, fullSyncQuietMs: 0, fullSyncMaxDelayMs: 0,
      shouldSync: async () => ({ kind: 'targeted', rootEtag: 'new', rootFileId: 'root' }),
      reconcileFileIds: (b) => h.reconciler.reconcileFileIds(b),
    });
    // An earlier note batch may have certified this same root before a delayed plugin ID arrives.
    scheduler.notify({ fileIds: ['note'], raw: 'notify_file_id' });
    await jest.runOnlyPendingTimersAsync();
    scheduler.notify({ fileIds: ['plugin'], raw: 'notify_file_id' });
    await jest.runOnlyPendingTimersAsync();
    expect(sync).not.toHaveBeenCalled();
    scheduler.notify({ fileIds: null, raw: 'notify_file' });
    await jest.runOnlyPendingTimersAsync();
    expect(sync).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});

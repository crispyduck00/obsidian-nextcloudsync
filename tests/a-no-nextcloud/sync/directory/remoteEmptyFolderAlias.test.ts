import { DirectoryReconciler } from '../../../../src/sync/directory/DirectoryReconciler';
import { StateDB } from '../../../../src/data/StateDB';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { FakeVault } from '../../../b1-nextcloud-headless/support/fakeVault';
import type { SyncSessionSummary } from '../../../../src/types';

const summary = (): SyncSessionSummary => ({
  startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
  mergedCount: 0, conflictedCount: 0, errorCount: 0, errors: [], retriedFiles: [],
  pluginsNeedingRestart: [], oversizeSkippedPaths: new Set(),
});

it('does not trash and then remotely delete an aliased empty-folder rename over two reconciliations', async () => {
  const vault = new FakeVault();
  const old = 'Projects';
  const next = 'projects';
  vault.seedFolder(old);
  const rawStat = vault.adapter.stat.bind(vault.adapter);
  vault.adapter.stat = async path => vault.folderExists(path.toLowerCase() === 'projects' ? old : path)
    ? { type: 'folder', size: 0, mtime: 1, ctime: 1 } : rawStat(path);
  const mkdir = vault.adapter.mkdir.bind(vault.adapter);
  vault.adapter.mkdir = async path => mkdir(path.toLowerCase() === 'projects' && vault.folderExists(old) ? old : path);
  const state = new StateDB(vault.adapter, '.obsidian/plugins/unit', 'unit');
  await state.load();
  state.setDir({ path: old, remoteFileId: 'same-folder' });
  let present = true;
  const client = {
    getDirectories: async () => present ? [{ path: next, fileId: 'same-folder', etag: 'e', lastModified: 1 }] : [],
    remoteExists: async (path: string) => present && path === next,
    createDirectory: jest.fn(), isRemoteDirEmpty: async () => true,
    deleteCollection: jest.fn(async () => { present = false; }),
  };
  const trash = jest.spyOn(vault.app.fileManager, 'trashFile');
  const reconciler = new DirectoryReconciler({
    app: vault.app, stateDB: state, journal: new SyncJournal({}),
    transfer: { acquireLock: async () => null, releaseLock: async () => undefined },
    mergeBase: { drop: () => undefined }, dropCleanSnapshot: () => undefined,
    markOwnEvent: () => undefined, isSystemExcluded: () => false,
    massDeleteLimit: () => -1, isCancelled: () => false,
  } as never);
  for (let i = 0; i < 2; i++) {
    try { await reconciler.reconcileDirectories(client as never, summary()); } catch (err) {
      expect((err as Error).message).toContain('Sync stopped');
    }
  }
  expect(present).toBe(true);
  expect(vault.folderExists(old)).toBe(true);
  expect(trash).not.toHaveBeenCalled();
  expect(client.deleteCollection).not.toHaveBeenCalled();
  expect(state.getDir(old)?.remoteFileId).toBe('same-folder');
  await state.flush();
});

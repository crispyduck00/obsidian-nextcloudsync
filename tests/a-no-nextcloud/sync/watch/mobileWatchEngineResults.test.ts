import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../../src/types';

function makeHarness() {
  const files = new Map<string, { path: string }>();
  const dirs = new Set<string>();
  const stat = jest.fn(async (_path: string) => null as { mtime: number; size: number } | null);

  const stateDB = {
    getFile: (path: string) => files.get(path),
    getDir: (path: string) => dirs.has(path) ? { path } : undefined,
  };
  const localAdapter = { stat };

  const engine = new SyncEngine({
    app: {},
    settings: { ...DEFAULT_SETTINGS },
    localAdapter,
    stateDB,
    statusBar: {},
    webdavFactory: {},
    pluginDir: '',
    configDir: '.obsidian',
  } as never);

  const watch = {
    syncSingleFile: jest.fn(async (_path: string) => undefined),
    deleteSingleFile: jest.fn(async (_path: string) => undefined),
    renameSingleFile: jest.fn(async (_oldPath: string, _newPath: string) => undefined),
    createSingleFolder: jest.fn(async (_path: string) => undefined),
    deleteSingleFolder: jest.fn(async (_path: string) => undefined),
    renameSingleFolder: jest.fn(async (_oldPath: string, _newPath: string) => undefined),
  };

  const internals = engine as unknown as {
    watch: typeof watch;
    retryQueue: string[];
  };
  internals.watch = watch;
  internals.retryQueue = [];

  return { engine, internals, watch, files, dirs, stat };
}

describe('SyncEngine mobile watch convergence wrappers', () => {
  it('detects retry work only for the same watched path', async () => {
    const h = makeHarness();
    h.watch.syncSingleFile.mockImplementationOnce(async () => {
      h.internals.retryQueue.push('other.md');
    });

    await expect(h.engine.syncSingleFileForMobileWatch('target.md')).resolves.toBe(true);

    h.watch.syncSingleFile.mockImplementationOnce(async () => {
      h.internals.retryQueue.push('target.md');
    });
    await expect(h.engine.syncSingleFileForMobileWatch('target.md')).resolves.toBe(false);
  });

  it('treats an existing retry entry as old work when the new attempt adds no duplicate', async () => {
    const h = makeHarness();
    h.internals.retryQueue.push('target.md');

    await expect(h.engine.syncSingleFileForMobileWatch('target.md')).resolves.toBe(true);
  });

  it('recognizes a tracked file rename only when StateDB identity moved to the new path', async () => {
    const h = makeHarness();
    h.files.set('old.md', { path: 'old.md' });

    await expect(h.engine.renameSingleFileForMobileWatch('old.md', 'new.md')).resolves.toBe(false);

    h.watch.renameSingleFile.mockImplementationOnce(async (oldPath, newPath) => {
      h.files.delete(oldPath);
      h.files.set(newPath, { path: newPath });
    });
    await expect(h.engine.renameSingleFileForMobileWatch('old.md', 'new.md')).resolves.toBe(true);
  });

  it('treats a restored local file as a converged guarded delete outcome', async () => {
    const h = makeHarness();
    h.files.set('note.md', { path: 'note.md' });
    h.stat.mockResolvedValueOnce({ mtime: 1, size: 1 });

    await expect(h.engine.deleteSingleFileForMobileWatch('note.md')).resolves.toBe(true);
  });

  it('requires recovery when a tracked delete left state behind and the local path is still absent', async () => {
    const h = makeHarness();
    h.files.set('note.md', { path: 'note.md' });
    h.stat.mockResolvedValueOnce(null);

    await expect(h.engine.deleteSingleFileForMobileWatch('note.md')).resolves.toBe(false);
  });

  it('recognizes folder create/delete/rename from the existing directory state', async () => {
    const h = makeHarness();

    h.watch.createSingleFolder.mockImplementationOnce(async (path) => { h.dirs.add(path); });
    await expect(h.engine.createSingleFolderForMobileWatch('Folder')).resolves.toBe(true);

    h.dirs.add('DeleteMe');
    h.watch.deleteSingleFolder.mockImplementationOnce(async (path) => { h.dirs.delete(path); });
    await expect(h.engine.deleteSingleFolderForMobileWatch('DeleteMe')).resolves.toBe(true);

    h.dirs.add('OldFolder');
    h.watch.renameSingleFolder.mockImplementationOnce(async (oldPath, newPath) => {
      h.dirs.delete(oldPath);
      h.dirs.add(newPath);
    });
    await expect(h.engine.renameSingleFolderForMobileWatch('OldFolder', 'NewFolder')).resolves.toBe(true);
  });
});

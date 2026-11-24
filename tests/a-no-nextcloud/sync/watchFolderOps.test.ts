// [SPEC:WF-1] Watch-mode single-folder ops: create (MKCOL, idempotent), delete (retain the remote collection),
// rename (MOVE). Exclusions honored; status bar shows activity. Mirrors the file-side
// syncSingleFile/deleteSingleFile/renameSingleFile behavior.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DavSyncSettings, DirState, PendingFolderMove } from '../../../src/types';

const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

function settings(over: Partial<DavSyncSettings> = {}): DavSyncSettings {
  return {
    configDir: CONFIG_DIR, syncConfigFolder: false, excludedFolders: [], maxFileSizeMB: 0,
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
    ...over,
  } as unknown as DavSyncSettings;
}

function makeEngine(opts: { tracked?: DirState[]; settings?: DavSyncSettings } = {}) {
  const dirs = new Map<string, DirState>((opts.tracked ?? []).map((d) => [d.path, d]));
  const client = {
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    moveFile: jest.fn(async () => undefined),
    getFiles: jest.fn(async () => []),
    getDirectories: jest.fn(async () => []),
  };
  const features = { isNextcloud: true, version: '30', hasChecksums: true, hasFilesLocking: false, hasBulkUpload: false, hasAccountDav: true, syncToken: null };
  const statusBar = { setStatus: jest.fn(), setProgress: jest.fn(), setSyncComplete: jest.fn(), setErrorCount: jest.fn() };
  let moves: PendingFolderMove[] = [];
  const stateDB = {
    getDir: (p: string) => dirs.get(p),
    setDir: (d: DirState) => { dirs.set(d.path, d); },
    deleteDir: (p: string) => { dirs.delete(p); },
    getAllDirs: () => [...dirs.values()],
    requestSave: jest.fn(),
    getAllFiles: () => [],
    getPendingFolderMoves: () => moves,
    setPendingFolderMoves: (replacement: PendingFolderMove[]) => { moves = replacement; },
    save: jest.fn(async () => undefined),
  };
  const engine = new SyncEngine({
    app: { vault: { adapter: {} }, fileManager: {} }, settings: opts.settings ?? settings(),
    localAdapter: {}, stateDB, statusBar,
    webdavFactory: { createClient: jest.fn(async () => ({ client, features })) },
    onFeatures: jest.fn(), pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
  } as never);
  const full = jest.spyOn(engine as unknown as { syncManualWithResult(): Promise<boolean> }, 'syncManualWithResult')
    .mockResolvedValue(true);
  return { engine, client, statusBar, dirs, stateDB, full };
}

const dirState = (path: string): DirState => ({ path, remoteFileId: null });

describe('[SPEC:WF-1] SyncEngine.createSingleFolder', () => {
  it('creates the folder on the remote (MKCOL) and tracks it', async () => {
    const { engine, client, dirs } = makeEngine();
    await engine.createSingleFolder('Notes/2026');
    expect(client.createDirectory).toHaveBeenCalledWith('Notes/2026');
    expect(dirs.has('Notes/2026')).toBe(true);
  });

  it('is idempotent: a failing MKCOL (already exists) is swallowed, not thrown', async () => {
    const { engine, client } = makeEngine();
    client.createDirectory.mockRejectedValueOnce(new Error('405 Method Not Allowed'));
    await expect(engine.createSingleFolder('Existing')).resolves.toBeUndefined();
  });

  it('is a no-op for a system-excluded path', async () => {
    const { engine, client } = makeEngine();
    await engine.createSingleFolder('.obsidian/plugins/x');
    expect(client.createDirectory).not.toHaveBeenCalled();
  });

  it('shows status-bar activity while propagating', async () => {
    const { engine, statusBar } = makeEngine();
    await engine.createSingleFolder('New');
    expect(statusBar.setStatus).toHaveBeenCalledWith('syncing', { automatic: true });
    expect(statusBar.setStatus).toHaveBeenLastCalledWith('idle');
  });
});

describe('[SPEC:WF-2] SyncEngine.deleteSingleFolder', () => {
  it('retains a TRACKED folder on the remote and keeps tracking', async () => {
    const { engine, client, dirs } = makeEngine({ tracked: [dirState('Old')] });
    await engine.deleteSingleFolder('Old');
    expect(client.deleteCollection).not.toHaveBeenCalled();
    expect(dirs.has('Old')).toBe(true);
  });

  it('is a no-op for an UNTRACKED folder (never on the server)', async () => {
    const { engine, client } = makeEngine({ tracked: [] });
    await engine.deleteSingleFolder('NeverSynced');
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('is a no-op for a system-excluded path', async () => {
    const { engine, client } = makeEngine({ tracked: [dirState('.obsidian/x')] });
    await engine.deleteSingleFolder('.obsidian/x');
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('keeps a tracked remote folder when it is not empty anymore', async () => {
    const { engine, client, dirs } = makeEngine({ tracked: [dirState('Shared')] });
    client.isRemoteDirEmpty.mockResolvedValueOnce(false);
    await engine.deleteSingleFolder('Shared');
    expect(client.deleteCollection).not.toHaveBeenCalled();
    expect(dirs.has('Shared')).toBe(true);
  });
});

describe('[SPEC:WF-3] SyncEngine.renameSingleFolder', () => {
  it('records the original folder ID and delegates MOVE to a full sync', async () => {
    const { engine, client, dirs, stateDB, full } = makeEngine({ tracked: [{ path: 'A', remoteFileId: 'original' }] });
    await engine.renameSingleFolder('A', 'B');
    expect(stateDB.getPendingFolderMoves()).toEqual([expect.objectContaining({ source: 'A', destination: 'B', fileId: 'original' })]);
    expect(full).toHaveBeenCalledTimes(1);
    expect(client.moveFile).not.toHaveBeenCalled();
    expect(dirs.has('A')).toBe(true);
  });

  it.each([['.obsidian/a', 'B'], ['A', '.obsidian/b'], ['.obsidian/a', '.obsidian/b']])('keeps %s → %s local across excluded roots', async (source, destination) => {
    const { engine, client } = makeEngine();
    await engine.renameSingleFolder(source, destination);
    expect(client.moveFile).not.toHaveBeenCalled();
  });
});

describe('Watch folder renames with nested scope exclusions', () => {
  it.each(['A/private', 'B/private'])('blocks a collection MOVE containing %s', async (excluded) => {
    const { engine, client, dirs } = makeEngine({ tracked: [dirState('A')], settings: settings({ excludedFolders: [excluded] }) });
    await engine.renameSingleFolder('A', 'B');
    expect(client.moveFile).not.toHaveBeenCalled();
    expect(dirs.get('A')).toBeDefined();
  });
});

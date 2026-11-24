import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, RemoteFileInfo } from '../../../src/types';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';

function makeStateAdapter(): DataAdapter {
  const store: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (f: string, t: string) => { store[t] = store[f]; delete store[f]; }),
    stat: jest.fn(), list: jest.fn(), readBinary: jest.fn(), writeBinary: jest.fn(),
  } as unknown as DataAdapter;
}

// In-memory local vault used only for the watch-mode single-file calls. `listVaultFiles` (the full sync's own
// scan) always reports empty so the full sync completes with an empty plan: the point is the exclusivity
// gate, not full-sync classification.
function makeLocalAdapter(files: Record<string, string>) {
  return {
    files,
    listVaultFiles: jest.fn(() => Object.entries(files).map(([path, text]) => ({ path, size: enc.encode(text).length, mtime: 1_000 }))),
    stat: jest.fn(async (p: string) =>
      (p in files ? { size: enc.encode(files[p]).length, mtime: 1_000 } : null)),
    exists: jest.fn(async (p: string) => p in files),
    list: jest.fn(async () => ({ files: Object.keys(files), folders: [] })),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

// Builds a real SyncEngine wired to a real StateDB and a WebDAV client whose `getFiles` (the first network
// call of the empty-state full sync) stays pending until `releaseFullSync()` is invoked, giving a
// deterministic window in which the engine's private `running` flag is true.
async function buildEngine(files: Record<string, string> = {}) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const localAdapter = makeLocalAdapter(files);

  let releaseFullSync!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFullSync = resolve; });
  const getFiles = jest.fn(async (): Promise<RemoteFileInfo[]> => { await gate; return []; });
  const getSyncToken = jest.fn(async (): Promise<string | null> => null);
  const statFile = jest.fn(async (): Promise<RemoteFileInfo | null> => null);
  const uploadFile = jest.fn(async () => undefined);
  const deleteFile = jest.fn(async () => undefined);
  const client = { getFiles, getSyncToken, statFile, uploadFile, deleteFile, getDirectories: jest.fn(async () => []) };
  const createClient = jest.fn(async () => ({ client, features: { isNextcloud: false } }));
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };

  const engine = new SyncEngine({
    app: { vault: { getAllFolders: () => [] } }, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false, newItemDelaySeconds: 10 },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient },
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  return { engine, stateDB, localAdapter, client, releaseFullSync };
}

describe('New item first-upload grace on the real engine', () => {
  beforeEach(() => { (globalThis as { navigator?: unknown }).navigator ??= {}; });
  afterEach(() => jest.restoreAllMocks());

  test('automatic startup waits for an observed creation, then uploads after its original deadline', async () => {
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { engine, stateDB, client, releaseFullSync } = await buildEngine({ 'Draft.md': 'new draft' });
    engine.rememberLocalCreation('Draft.md', false);
    releaseFullSync();
    await engine.syncManual();
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(stateDB.getFile('Draft.md')).toBeUndefined();
    now = 11000;
    await engine.syncManual();
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    expect(stateDB.getFile('Draft.md')).toBeDefined();
    await stateDB.flush();
  });

  test('explicit Sync now flushes the observed creation without waiting for its deadline', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const { engine, stateDB, client, releaseFullSync } = await buildEngine({ 'Draft.md': 'ready now' });
    engine.rememberLocalCreation('Draft.md', false);
    releaseFullSync();
    await engine.syncManual({ manual: true });
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    expect(stateDB.getFile('Draft.md')).toBeDefined();
    await stateDB.flush();
  });

  test('a new parent holds the renamed note and all descendants until the parent deadline', async () => {
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { engine, stateDB, localAdapter, client, releaseFullSync } = await buildEngine({ 'Untitled/Untitled.md': 'draft' });
    engine.rememberLocalCreation('Untitled', true);
    engine.rememberLocalCreation('Untitled/Untitled.md', false);
    expect(engine.retargetLocalCreation('Untitled', 'Project', true)).toBe(true);
    localAdapter.files['Project/Project.md'] = localAdapter.files['Untitled/Untitled.md'];
    delete localAdapter.files['Untitled/Untitled.md'];
    expect(engine.retargetLocalCreation('Project/Untitled.md', 'Project/Project.md', false)).toBe(true);
    releaseFullSync();
    await engine.syncSingleFile('Project/Project.md');
    await engine.syncManual();
    expect(client.uploadFile).not.toHaveBeenCalled();
    now = 11000;
    await engine.syncManual();
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    expect(stateDB.getFile('Project/Project.md')).toBeDefined();
    await stateDB.flush();
  });
});

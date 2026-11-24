import { SyncEngine } from '../../../src/sync/SyncEngine';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { StateDB } from '../../../src/data/StateDB';
import { MergeBaseStore } from '../../../src/data/MergeBaseStore';
import { CleanSideStore } from '../../../src/data/CleanSideStore';
import { DEFAULT_SETTINGS, type RemoteFileInfo } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { FakeVault } from '../../b1-nextcloud-headless/support/fakeVault';

const PLUGIN = '.obsidian/plugins/nextcloud-sync';
const body = '# Note\n\nCASE-ALIAS-UNIQUE-PAYLOAD\n';
const buffer = () => new TextEncoder().encode(body).buffer as ArrayBuffer;

// Model NTFS-style name lookup, while preserving the actual directory entry
// spelling. Explicit rename changes that spelling, read/stat/exists do not.
function caseAliasing(vault: FakeVault): void {
  const files = () => (vault as unknown as { store: Map<string, unknown> }).store;
  const folders = () => (vault as unknown as { explicitFolders: Set<string> }).explicitFolders;
  const canonical = (path: string) => [...files().keys(), ...folders()]
    .find(p => p.toLowerCase() === path.toLowerCase()) ?? path;
  const adapter = vault.adapter as unknown as Record<string, (...args: any[]) => Promise<any>>;
  const stat = adapter.stat.bind(adapter);
  adapter.stat = async (path: string) => folders().has(path)
    ? { type: 'folder', size: 0, mtime: 1, ctime: 1 } : stat(path);
  for (const name of ['read', 'readBinary', 'stat', 'exists', 'remove', 'append', 'write', 'writeBinary', 'list', 'mkdir']) {
    const original = adapter[name].bind(adapter);
    adapter[name] = (path: string, ...args: unknown[]) => original(canonical(path), ...args);
  }
  const originalRename = adapter.rename.bind(adapter);
  adapter.rename = async (source: string, destination: string) => {
    const actual = canonical(source);
    if (actual !== destination) await originalRename(actual, destination);
  };
}

it('keeps an empty-folder alias stopped across public full syncs, without a stale root checkpoint', async () => {
  const vault = new FakeVault();
  caseAliasing(vault);
  vault.seedFolder(PLUGIN);
  const local = new LocalAdapter(vault.adapter, vault.vault);
  const state = new StateDB(vault.adapter, PLUGIN, 'folder-device');
  await state.load();
  const checksum = await sha256(buffer());
  let path = 'Projects';
  let root = 'root-1';
  const file = { path: 'keep.md', fileId: 'keep-id', checksum, etag: 'body-etag', size: buffer().byteLength, lastModified: 1000 };
  const client = {
    getRootEtag: async () => root, getFiles: async () => [file],
    getDirectories: async () => [{ path, fileId: 'folder-id', etag: root, lastModified: 1000 }],
    getSyncToken: async () => null,
    remoteExists: async (p: string) => p === path || p === file.path,
    statFile: async (p: string) => p === file.path ? file : null,
    downloadFile: async () => buffer(), recalcChecksum: async () => checksum,
    createDirectory: jest.fn(), isRemoteDirEmpty: async () => true,
    deleteCollection: jest.fn(), deleteFile: jest.fn(),
    uploadFile: jest.fn(),
  };
  const trash = jest.spyOn(vault.app.fileManager, 'trashFile');
  const engine = new SyncEngine({
    app: vault.app, localAdapter: local, stateDB: state,
    settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    statusBar: { setStatus: jest.fn(), setProgress: jest.fn(), setSyncComplete: jest.fn() },
    webdavFactory: { createClient: async () => ({ client, features: { isNextcloud: true } }) },
    pluginDir: PLUGIN, configDir: '.obsidian',
  } as never);
  try {
    await engine.syncManual({ manual: true });
    expect(vault.folderExists('Projects')).toBe(true);
    expect(state.getDir('Projects')?.remoteFileId).toBe('folder-id');
    path = 'projects'; root = 'root-2';
    for (let i = 0; i < 2; i++) {
      await engine.syncManual({ manual: true });
      expect(engine.getLastSessionSummary()?.errorCount).toBe(1);
      expect(state.getRemoteRootEtag()).toBeNull();
      expect(vault.folderExists('Projects')).toBe(true);
    }
    expect(trash).not.toHaveBeenCalled();
    expect(client.deleteCollection).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
  } finally {
    await state.flush();
    local.dispose();
  }
});

beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { jest.restoreAllMocks(); });

for (const [kind, oldName, newName] of [['case', 'note.md', 'Note.md'], ['unicode', 'Cafe\u0301.md', 'Café.md']] as const) {
for (const token of [false, true]) {
for (const insensitive of kind === 'unicode' ? [false] : [false, true]) {
  for (const secondRefresh of [false, true]) {
    it(`remote ${kind} rename preserves data (token=${token}, caseInsensitive=${insensitive}, secondRefresh=${secondRefresh})`, async () => {
      const vault = new FakeVault();
      if (insensitive) caseAliasing(vault);
      vault.seedFolder(PLUGIN);
      const local = new LocalAdapter(vault.adapter, vault.vault, undefined, async () => 'untrusted');
      const state = new StateDB(vault.adapter, PLUGIN, 'case-device');
      const baseStore = new MergeBaseStore(vault.adapter, PLUGIN, 'case-device');
      const cleanSideStore = new CleanSideStore(vault.adapter, PLUGIN, 'case-device');
      await state.load(); await baseStore.load(); await cleanSideStore.load();
      let path: string = oldName;
      let rootEtag = 'root-1';
      const checksum = await sha256(buffer());
      const remoteInfo = (): RemoteFileInfo => ({
        path, fileId: 'file-1', checksum, etag: 'body-etag', size: buffer().byteLength,
        lastModified: 1_000,
      });
      let present = true;
      const deleteCalls: unknown[][] = [];
      const trashCalls: string[] = [];
      const originalTrash = vault.app.fileManager.trashFile.bind(vault.app.fileManager);
      vault.app.fileManager.trashFile = async file => {
        trashCalls.push(file.path);
        await originalTrash(file);
      };
      const client = {
        getRootEtag: async () => rootEtag,
        getFiles: async () => present ? [remoteInfo()] : [],
        getDirectories: async () => [],
        getSyncToken: async () => token ? 'sync-token' : null,
        getChanges: async () => ({ modified: present ? [remoteInfo()] : [], deleted: [oldName], newSyncToken: 'next-token' }),
        remoteExists: async (p: string) => present && p === path,
        statFile: async (p: string) => present && p === path ? remoteInfo() : null,
        downloadFile: async (p: string) => {
          if (!present || p !== path) throw new Error('404');
          return buffer();
        },
        recalcChecksum: async (p: string) => present && p === path ? checksum : null,
        createDirectory: async () => undefined,
        isRemoteDirEmpty: async () => true,
        setCreationTime: async () => 'rejected',
        deleteFile: async (...args: unknown[]) => {
          deleteCalls.push(args);
          if (args[1] !== checksum) throw new Error('412 invalid delete precondition');
          if (args[0] === path) { present = false; rootEtag = 'root-3'; }
        },
        uploadFile: async () => { throw new Error('Unexpected upload'); },
      };
      const settings = {
        ...DEFAULT_SETTINGS, deviceId: 'case-device', serverUrl: 'https://unit.invalid',
        username: 'unit', watchOnChangeEnabled: false,
      };
      const engine = new SyncEngine({
        app: vault.app, settings, localAdapter: local, stateDB: state, baseStore, cleanSideStore,
        statusBar: { setStatus() {}, setProgress() {}, setConflictCount() {}, setErrorCount() {}, setSyncComplete() {} },
        webdavFactory: { createClient: async () => ({ client, features: {
          isNextcloud: true, version: '35.0.2.2', hasChecksums: true, hasFilesLocking: false,
          hasBulkUpload: false, hasAccountDav: true, syncToken: null,
        } }) },
        pluginDir: PLUGIN, configDir: '.obsidian',
      } as never);
      try {
        state.setRemoteRootEtag(null);
        await engine.syncManual({ manual: true });
        expect(vault.readLocal(oldName)).toBe(body);
        expect(engine.getLastSessionSummary()?.errorCount).toBe(0);
        expect(state.getFile(oldName)?.remoteFileId).toBe('file-1');
        // A different device changed only filename case. Body, mtime and ID stay constant;
        // the parent root revision changes exactly as it does in Nextcloud.
        path = newName; rootEtag = 'root-2';
        state.setRemoteRootEtag(null);
        await engine.syncManual({ manual: true });
        if (secondRefresh) state.setRemoteRootEtag(null);
        await engine.syncManual({ manual: true });
        expect(present).toBe(true);
        const held = insensitive || kind === 'unicode';
        expect(await vault.adapter.read(held ? oldName : newName)).toBe(body);
        expect(engine.getLastSessionSummary()?.errorCount).toBe(held ? 1 : 0);
        if (held) {
          expect(trashCalls).toEqual([]);
          expect(state.getFile(oldName)?.remoteFileId).toBe('file-1');
          expect(state.getFile(newName)).toBeUndefined();
        }
        expect(deleteCalls).toEqual([]);
        if (kind === 'unicode') {
          await vault.adapter.rename(oldName, newName); // Explicit user correction.
          await engine.syncManual({ manual: true });
          expect(engine.getLastSessionSummary()?.errorCount).toBe(0);
          expect(state.getFile(oldName)).toBeUndefined();
          expect(state.getFile(newName)?.remoteFileId).toBe('file-1');
          expect(await vault.adapter.read(newName)).toBe(body);
          expect(deleteCalls).toEqual([]);
        }
      } finally {
        await engine.flushState();
        local.dispose();
      }
    });
  }
}
}
}

import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, NetworkError, RemoteFileInfo } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';

const enc = new TextEncoder();
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';

function stateAdapter(): DataAdapter {
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

async function build() {
  const body = 'same body';
  const hash = await sha256(enc.encode(body).buffer);
  const localFiles: Record<string, string> = { 'B/note.md': body };
  const remote = new Map<string, RemoteFileInfo>([
    ['A/note.md', {
      path: 'A/note.md', fileId: 'fid-1', checksum: hash, etag: '"e1"',
      size: enc.encode(body).byteLength, lastModified: 1000,
    }],
  ]);

  const stateDB = new StateDB(stateAdapter(), PLUGIN_DIR, 'dev-rmr');
  await stateDB.load();
  const tracked: FileState = {
    path: 'A/note.md', localHash: hash, remoteId: hash, idType: 'sha256',
    size: enc.encode(body).byteLength, mtime: 1000, remoteFileId: 'fid-1', isConflicted: false,
  };
  stateDB.setFile(tracked);
  stateDB.rememberPendingRename({
    oldPath: 'A/note.md', newPath: 'B/note.md', kind: 'file', recordedAt: 1,
  });
  await stateDB.save();

  const localAdapter = {
    listVaultFiles: jest.fn(() =>
      Object.entries(localFiles).map(([path, text]) => ({ path, size: enc.encode(text).byteLength, mtime: 1000 }))),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async (p: string) =>
      (p in localFiles ? { size: enc.encode(localFiles[p]).byteLength, mtime: 1000 } : null)),
    exists: jest.fn(async (p: string) => p in localFiles),
    read: jest.fn(async (p: string) => localFiles[p] ?? ''),
    readBinary: jest.fn(async (p: string) => enc.encode(localFiles[p] ?? '').buffer),
    atomicWrite: jest.fn(async (p: string, text: string) => { localFiles[p] = text; }),
    atomicWriteBinary: jest.fn(async (p: string, data: ArrayBuffer) => {
      localFiles[p] = new TextDecoder().decode(data);
    }),
    writeBinary: jest.fn(),
    setMtime: jest.fn(),
    remove: jest.fn(async (p: string) => { delete localFiles[p]; }),
    ignore: jest.fn(),
  };

  let blockMove = true;
  const moveFile = jest.fn(async (oldPath: string, newPath: string) => {
    if (blockMove) throw new NetworkError(423, '', 'MOVE');
    const entry = remote.get(oldPath);
    if (!entry) throw new NetworkError(404, '', 'MOVE');
    remote.delete(oldPath);
    remote.set(newPath, { ...entry, path: newPath });
  });
  const uploadFile = jest.fn(async (path: string) => {
    remote.set(path, {
      path, fileId: 'uploaded', checksum: hash, etag: '"up"',
      size: enc.encode(body).byteLength, lastModified: 1000,
    });
  });
  const deleteFile = jest.fn(async (path: string) => { remote.delete(path); });

  const client = {
    getFiles: jest.fn(async () => [...remote.values()]),
    getDirectories: jest.fn(async () => []),
    getSyncToken: jest.fn(async () => null),
    getRootEtag: jest.fn(async () => null),
    statFile: jest.fn(async (p: string) => remote.get(p) ?? null),
    recalcChecksum: jest.fn(async (p: string) => remote.get(p)?.checksum ?? null),
    remoteExists: jest.fn(async (p: string) => remote.has(p)),
    moveFile,
    uploadFile,
    deleteFile,
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
  };

  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };
  const app = {
    vault: { getAllFolders: () => [], getAbstractFileByPath: () => null, configDir: '.obsidian' },
    fileManager: { trashFile: jest.fn() },
  };
  const engine = new SyncEngine({
    app,
    settings: { ...DEFAULT_SETTINGS, deviceId: 'dev-rmr', syncOnWifiOnly: false },
    localAdapter,
    stateDB,
    statusBar,
    webdavFactory: {
      createClient: jest.fn(async () => ({
        client,
        features: { isNextcloud: false, hasChecksums: false, hasFilesLocking: false, hasBulkUpload: false },
      })),
    },
    pluginDir: PLUGIN_DIR,
    configDir: '.obsidian',
  } as never);

  return {
    engine, stateDB, remote, client, moveFile, uploadFile, deleteFile,
    allowMove: () => { blockMove = false; },
  };
}

describe('pending local MOVE recovery', () => {
  beforeEach(() => {
    (globalThis as { navigator?: unknown }).navigator ??= {};
  });

  it('does not degrade a locked MOVE into upload-new + delete-old', async () => {
    const h = await build();

    await h.engine.syncManual({ manual: true });

    expect(h.moveFile).toHaveBeenCalledWith('A/note.md', 'B/note.md');
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(h.remote.has('A/note.md')).toBe(true);
    expect(h.remote.has('B/note.md')).toBe(false);
    expect(h.stateDB.getPendingRenames()).toHaveLength(1);
    expect(h.stateDB.getFile('A/note.md')).toBeDefined();
  });

  it('retries the same MOVE on a later sync and converges without a copy when the lock clears', async () => {
    const h = await build();

    await h.engine.syncManual({ manual: true }); // 423: stays pending
    h.allowMove();
    await h.engine.syncManual({ manual: true }); // retry succeeds

    expect(h.moveFile).toHaveBeenCalledTimes(2);
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(h.remote.has('A/note.md')).toBe(false);
    expect(h.remote.has('B/note.md')).toBe(true);
    expect(h.stateDB.getPendingRenames()).toEqual([]);
    expect(h.stateDB.getFile('A/note.md')).toBeUndefined();
    expect(h.stateDB.getFile('B/note.md')?.remoteFileId).toBe('fid-1');
  });

  it('keeps a permanent MOVE permission failure pending instead of silently creating a duplicate', async () => {
    const h = await build();
    h.moveFile.mockImplementation(async () => { throw new NetworkError(403, '', 'MOVE'); });

    await h.engine.syncManual({ manual: true });

    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(h.remote.has('A/note.md')).toBe(true);
    expect(h.remote.has('B/note.md')).toBe(false);
    expect(h.stateDB.getPendingRenames()).toHaveLength(1);
  });
});

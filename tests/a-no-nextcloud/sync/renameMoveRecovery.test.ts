import { DataAdapter, Notice } from 'obsidian';
import { StateDB } from '../../../src/data/StateDB';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS, FileState, NetworkError, SyncSessionSummary } from '../../../src/types';

const enc = new TextEncoder();
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

function makeLocalAdapter(files: Record<string, string>) {
  return {
    stat: jest.fn(async (p: string) =>
      p in files ? { size: enc.encode(files[p]).byteLength, mtime: 1000 } : null),
    readBinary: jest.fn(async (p: string) => enc.encode(files[p] ?? '').buffer as ArrayBuffer),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    atomicWriteBinary: jest.fn(),
    atomicWrite: jest.fn(),
    setMtime: jest.fn(),
    exists: jest.fn(async (p: string) => p in files),
  };
}

function summary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
    deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0,
    retriedFiles: [], errors: [],
  };
}

function seedFile(db: StateDB, path: string): void {
  const state: FileState = {
    path, localHash: 'hash-a', remoteId: 'hash-a', idType: 'sha256',
    size: 1, mtime: 1000, remoteFileId: 'fid-a', isConflicted: false,
  };
  db.setFile(state);
}

async function harness(moveFile: jest.Mock, files: Record<string, string> = { 'B.md': 'x' }) {
  const db = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await db.load();
  const localAdapter = makeLocalAdapter(files);
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, deviceId: 'dev1' },
    localAdapter, stateDB: db,
    statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() },
    webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);
  (engine as unknown as { client: unknown }).client = { moveFile };
  (engine as unknown as { features: unknown }).features = {
    isNextcloud: true, version: '30', hasChecksums: true, hasFilesLocking: false,
    hasBulkUpload: false, syncToken: null,
  };
  return { engine, db, localAdapter };
}

const invokeReplay = (
  engine: SyncEngine, s: SyncSessionSummary,
): Promise<{ skipRemotePrefixes: Set<string>; skipUploadPrefixes: Set<string> }> =>
  (engine as unknown as {
    replayPendingRenames(summary: SyncSessionSummary): Promise<{
      skipRemotePrefixes: Set<string>; skipUploadPrefixes: Set<string>;
    }>;
  }).replayPendingRenames(s);

const noticeInstances = (): Array<{ message: string }> =>
  (Notice as unknown as { instances: Array<{ message: string }> }).instances;

beforeEach(() => { noticeInstances().length = 0; });

describe('pending rename state', () => {
  it('collapses A→B→C and cancels when the path returns to A', async () => {
    const db = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
    await db.load();

    expect(db.rememberPendingRename('A.md', 'B.md', 'file')).toEqual({
      oldPath: 'A.md', newPath: 'B.md', kind: 'file',
    });
    expect(db.rememberPendingRename('B.md', 'C.md', 'file')).toEqual({
      oldPath: 'A.md', newPath: 'C.md', kind: 'file',
    });
    expect(db.getPendingRenames()).toEqual([
      { oldPath: 'A.md', newPath: 'C.md', kind: 'file' },
    ]);

    expect(db.rememberPendingRename('C.md', 'A.md', 'file')).toBeNull();
    expect(db.getPendingRenames()).toHaveLength(0);
  });

  it('moves all tracked child identities with a confirmed folder MOVE', async () => {
    const db = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
    await db.load();
    db.setDir({ path: 'A', remoteFileId: 'dir-a' });
    db.setDir({ path: 'A/sub', remoteFileId: 'dir-sub' });
    seedFile(db, 'A/sub/note.md');
    db.rememberPendingRename('A', 'B', 'folder');
    db.rememberPendingRename('A/sub/note.md', 'B/sub/note.md', 'file');

    db.moveTrackedSubtree('A', 'B');

    expect(db.getDir('A')).toBeUndefined();
    expect(db.getDir('B/sub')).toBeDefined();
    expect(db.getFile('A/sub/note.md')).toBeUndefined();
    expect(db.getFile('B/sub/note.md')?.path).toBe('B/sub/note.md');
    expect(db.getPendingRenames()).toHaveLength(0);
  });
});

describe('rename MOVE recovery', () => {
  it('replays a pending file MOVE and clears the intent on success', async () => {
    const moveFile = jest.fn(async () => undefined);
    const { engine, db } = await harness(moveFile);
    seedFile(db, 'A.md');
    db.rememberPendingRename('A.md', 'B.md', 'file');

    const result = await invokeReplay(engine, summary());

    expect(moveFile).toHaveBeenCalledWith('A.md', 'B.md');
    expect(db.getFile('A.md')).toBeUndefined();
    expect(db.getFile('B.md')).toBeDefined();
    expect(db.getPendingRenames()).toHaveLength(0);
    expect(result.skipRemotePrefixes.has('A.md')).toBe(true);
    expect(result.skipUploadPrefixes.has('B.md')).toBe(false);
  });

  it('keeps a 423-locked MOVE pending and suppresses destination upload', async () => {
    const moveFile = jest.fn(async () => {
      throw new NetworkError(423, '', 'MOVE');
    });
    const { engine, db } = await harness(moveFile);
    seedFile(db, 'A.md');
    db.rememberPendingRename('A.md', 'B.md', 'file');
    const s = summary();

    const result = await invokeReplay(engine, s);

    expect(db.getFile('A.md')).toBeDefined();
    expect(db.getFile('B.md')).toBeUndefined();
    expect(db.getPendingRenames()).toEqual([
      { oldPath: 'A.md', newPath: 'B.md', kind: 'file' },
    ]);
    expect(result.skipRemotePrefixes.has('A.md')).toBe(true);
    expect(result.skipUploadPrefixes.has('B.md')).toBe(true);
    expect(s.errorCount).toBe(1);
  });

  it('degrades a permanently denied file MOVE to explicit copy semantics', async () => {
    const moveFile = jest.fn(async () => {
      throw new NetworkError(403, '', 'MOVE');
    });
    const { engine, db } = await harness(moveFile);
    seedFile(db, 'A.md');
    db.rememberPendingRename('A.md', 'B.md', 'file');

    const result = await invokeReplay(engine, summary());

    expect(db.getPendingRenames()).toHaveLength(0);
    expect(db.getFile('A.md')).toBeUndefined();
    expect(result.skipUploadPrefixes.has('B.md')).toBe(false);
    expect(noticeInstances().some(n => /copy/i.test(n.message))).toBe(true);
  });
});

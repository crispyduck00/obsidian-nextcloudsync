// [SPEC:WSF-7] Full sync exclusivity (docs/spec.md §5.7). While a full sync (syncManual) is running,
// `syncSingleFile` must not touch the network or the local filesystem: it only records the path (in-memory)
// and returns. Once the full sync completes, every recorded path is re-evaluated at least once. A tracked
// deletion during the scan coalesces into an authoritative successor because the current run may have
// already passed it. No destructive operation is replayed from the old event.
// These tests drive the REAL SyncEngine (syncManual + syncSingleFile + deleteSingleFile) against a real
// StateDB (in-memory DataAdapter, same harness as untrackedBothSides.test.ts); only the WebDAV client and
// LocalAdapter are doubles. The full sync is held open by making the client's `getFiles` await a promise the
// test resolves explicitly (never a timer), giving a deterministic window in which `running === true`.
import { DataAdapter } from 'obsidian';
import { sha256 } from '../../../src/util/hash';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo } from '../../../src/types';

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
    listVaultFiles: jest.fn(() => [] as Array<{ path: string; size: number; mtime: number }>),
    stat: jest.fn(async (p: string) =>
      (p in files ? { size: enc.encode(files[p]).length, mtime: 1_000 } : null)),
    exists: jest.fn(async (p: string) => p in files),
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
    app: { vault: { getAllFolders: () => [] } }, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false, networkConcurrency: 1 },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient },
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  return { engine, stateDB, localAdapter, client, releaseFullSync };
}

// Seeds a tracked FileState so `deleteSingleFile` treats the path as a known deletion candidate.
function trackFile(stateDB: StateDB, path: string, body: string): void {
  const fs: FileState = {
    path, localHash: 'h', remoteId: 'h', idType: 'sha256',
    size: enc.encode(body).length, mtime: 1_000, remoteFileId: 'f1', isConflicted: false,
  };
  stateDB.setFile(fs);
}

describe('[SPEC:WSF-7] C-5 — full sync exclusivity for watch-mode single-file ops', () => {
  beforeEach(() => {
    // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection. syncOnWifiOnly=false
    // short-circuits before it, but guard the global so environments without `navigator` don't throw.
    (globalThis as { navigator?: unknown }).navigator ??= {};
  });

  it('defers syncSingleFile while a full sync is running — no network I/O, no local read', async () => {
    const { engine, stateDB, localAdapter, client, releaseFullSync } = await buildEngine({ 'note.md': 'local body' });

    const fullSyncDone = engine.syncManual({ manual: true }); // running becomes true synchronously
    await engine.syncSingleFile('note.md');

    expect(localAdapter.stat).not.toHaveBeenCalled();
    expect(localAdapter.readBinary).not.toHaveBeenCalled();
    expect(client.statFile).not.toHaveBeenCalled();

    releaseFullSync();
    await fullSyncDone; // this also drains the deferred path — flush its resulting requestSave() timer
    await stateDB.flush();
  });

  it('re-evaluates a deferred path once the full sync completes', async () => {
    const { engine, stateDB, client, releaseFullSync } = await buildEngine({ 'note.md': 'local body' });

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.syncSingleFile('note.md'); // deferred: queued, not run
    expect(client.statFile).not.toHaveBeenCalled();

    releaseFullSync(); // let the full sync finish
    await fullSyncDone;

    expect(client.statFile).toHaveBeenCalledWith('note.md');
    await stateDB.flush(); // drain the debounced requestSave() timer the upload triggered
  });

  it('coalesces repeated defers of the same path into a single re-evaluation', async () => {
    const { engine, stateDB, client, releaseFullSync } = await buildEngine({ 'note.md': 'local body' });

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.syncSingleFile('note.md');
    await engine.syncSingleFile('note.md'); // queued again — must not double the re-evaluation
    await engine.syncSingleFile('note.md');

    releaseFullSync();
    await fullSyncDone;

    // Two reads, not one: one re-evaluation of the deferred path, plus the post-upload re-read. This harness
    // reports `isNextcloud: false`, so the upload has to ask the server what identity it now holds rather than
    // assuming the checksum it sent came back. Three defers that failed to coalesce would show as six.
    expect(client.statFile).toHaveBeenCalledTimes(2);
    expect(client.statFile).toHaveBeenCalledWith('note.md');
    await stateDB.flush();
  });

  it('re-evaluates two distinct deferred paths independently after the full sync completes', async () => {
    const { engine, stateDB, client, releaseFullSync } = await buildEngine({ 'note.md': 'a', 'other.md': 'b' });

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.syncSingleFile('note.md');
    await engine.syncSingleFile('other.md');

    releaseFullSync();
    await fullSyncDone;

    expect(client.statFile).toHaveBeenCalledWith('note.md');
    expect(client.statFile).toHaveBeenCalledWith('other.md');
    await stateDB.flush();
  });

  it('does not throw when a re-evaluated path has since vanished locally', async () => {
    const { engine, localAdapter, client, releaseFullSync } = await buildEngine({ 'note.md': 'local body' });

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.syncSingleFile('note.md'); // deferred while the file still exists

    // The file is removed locally before the deferred re-evaluation runs (e.g. the user deleted it
    // mid-sync). The re-evaluation must see it as gone and no-op — not throw.
    delete localAdapter.files['note.md'];

    releaseFullSync();
    await expect(fullSyncDone).resolves.toBeUndefined();

    // stat() is consulted during the re-evaluation (proving it ran) and reports "gone", so the
    // classification never reaches the network.
    expect(localAdapter.stat).toHaveBeenCalledWith('note.md');
    expect(client.statFile).not.toHaveBeenCalled();
  });

  it('coalesces a deletion into a fresh scan, which does not delete again after the first scan already did', async () => {
    // The tracked note is already absent before the listing. The current run can delete it.
    // The coalesced successor must re-read the final state and contribute no duplicate DELETE.
    const { engine, stateDB, client, releaseFullSync } = await buildEngine();
    trackFile(stateDB, 'tracked.md', 'server body');
    const before = stateDB.getFile('tracked.md');

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.deleteSingleFile('tracked.md');

    // Recording the structural follow-up makes no client call or tracking change.
    expect(client.statFile).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(stateDB.getFile('tracked.md')).toEqual(before); // tracking stays until a proved deletion

    // The scan does not delete a path just because the listing lacks it; it asks the server first, so the world
    // has to say what the server holds. Here: still there and byte-identical to our base, which makes the
    // deletion provably the user's.
    client.statFile.mockResolvedValue({
      path: 'tracked.md', fileId: 'f1', checksum: 'h', etag: null, size: 11, lastModified: 0,
    });

    releaseFullSync();
    await fullSyncDone;

    // The initial scan already deleted it. The fresh successor sees no tracked path, so it
    // contributes no duplicate DELETE.
    expect(client.deleteFile).toHaveBeenCalledTimes(1);
    expect(client.deleteFile).toHaveBeenCalledWith('tracked.md', 'h');
  });
});


async function buildLateDeletion() {
  const h = await buildEngine({ 'early.md': 'early body', 'later.md': 'later body' });
  const { stateDB, localAdapter, client } = h;
  const remote = new Map<string, { info: RemoteFileInfo; body: string }>();
  for (const [path, body] of Object.entries(localAdapter.files)) {
    const hash = await sha256(toBuf(body));
    stateDB.setFile({ path, localHash: hash, remoteId: hash, idType: 'sha256', size: body.length,
      mtime: 1000, localMtime: 1000, localSize: body.length, remoteFileId: path, isConflicted: false });
    remote.set(path, { body, info: { path, fileId: path, checksum: hash, etag: `etag-${path}`,
      size: body.length, lastModified: 1000, creationTime: 1000 } });
  }
  client.getFiles.mockImplementation(async () => [...remote.values()].map(entry => ({ ...entry.info })));
  Object.assign(localAdapter, { isFile: async (path: string) => path in localAdapter.files });
  localAdapter.listVaultFiles.mockImplementation(() => Object.entries(localAdapter.files)
    .map(([path, body]) => ({ path, size: body.length, mtime: 1000 })));
  client.statFile.mockImplementation(async (...args: unknown[]) => remote.get(String(args[0]))?.info ?? null);
  client.deleteFile.mockImplementation(async (...args: unknown[]) => { remote.delete(String(args[0])); });
  client.uploadFile.mockImplementation(async (...args: unknown[]) => {
    const path = String(args[0]), data = args[1] as ArrayBuffer;
    const body = dec.decode(data), previous = remote.get(path)!;
    remote.set(path, { body, info: { ...previous.info, checksum: await sha256(data), etag: 'uploaded-etag', size: data.byteLength } });
  });
  Object.assign(client, {
    downloadFile: jest.fn(async (path: string) => toBuf(remote.get(path)!.body)),
    recalcChecksum: jest.fn(async (path: string) => remote.get(path)?.info.checksum ?? null),
    moveFile: jest.fn(async (source: string, destination: string) => {
      const moved = remote.get(source)!;
      remote.delete(source);
      remote.set(destination, { body: moved.body, info: { ...moved.info, path: destination } });
    }),
  });
  let reached!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalStat = localAdapter.stat.getMockImplementation()!;
  let held = false;
  localAdapter.stat.mockImplementation(async (path: string) => {
    if (path === 'later.md' && !held) { held = true; reached(); await gate; }
    return originalStat(path);
  });
  return { ...h, remote, waiting, release };
}

describe('a deletion after its file was already classified during the running scan', () => {
  it.each(['unchanged', 'recreated locally', 'recreated with new text', 'peer edit', 'peer rename', 'stopped'])(
    'reconciles the final structure instead of replaying a stale DELETE (%s)', async outcome => {
      const { engine, client, stateDB, localAdapter, remote, waiting, release } = await buildLateDeletion();
      const full = engine.syncManual({ manual: true });
      await waiting;
      delete localAdapter.files['early.md'];
      await engine.deleteSingleFile('early.md');
      if (outcome === 'recreated locally') localAdapter.files['early.md'] = 'early body';
      if (outcome === 'recreated with new text') localAdapter.files['early.md'] = 'new local draft';
      if (outcome === 'peer edit') {
        const changed = remote.get('early.md')!;
        changed.body = 'changed by peer';
        changed.info = { ...changed.info, checksum: await sha256(toBuf(changed.body)), etag: 'peer-etag', size: changed.body.length };
      }
      if (outcome === 'peer rename') {
        const moved = remote.get('early.md')!;
        remote.delete('early.md');
        remote.set('moved.md', { body: moved.body, info: { ...moved.info, path: 'moved.md' } });
      }
      if (outcome === 'stopped') engine.requestStop();
      release(); await full; await stateDB.flush();
      if (outcome === 'stopped') {
        expect(client.getFiles).toHaveBeenCalledTimes(1);
        expect(client.deleteFile).not.toHaveBeenCalled();
        await engine.syncManual({ manual: true }); await stateDB.flush();
      }
      expect(client.deleteFile).toHaveBeenCalledTimes(outcome === 'unchanged' || outcome === 'stopped' ? 1 : 0);
      if (outcome === 'unchanged' || outcome === 'stopped') {
        expect(remote.has('early.md')).toBe(false);
        expect(stateDB.getFile('early.md')).toBeUndefined();
      } else if (outcome === 'peer edit') {
        expect(localAdapter.files['early.md']).toBe('changed by peer');
        expect(remote.get('early.md')?.body).toBe('changed by peer');
      } else if (outcome === 'peer rename') {
        expect(localAdapter.files['moved.md']).toBe('early body');
        expect(remote.get('moved.md')?.info.fileId).toBe('early.md');
      } else if (outcome === 'recreated with new text') {
        expect(localAdapter.files['early.md']).toBe('new local draft');
        expect(remote.get('early.md')?.body).toBe('new local draft');
      } else {
        expect(localAdapter.files['early.md']).toBe('early body');
        expect(remote.get('early.md')?.body).toBe('early body');
      }
      expect(client.getFiles.mock.calls.length).toBeLessThanOrEqual(outcome === 'stopped' ? 3 : 2);
    },
  );
});


test('a late local rename is moved after the current full scan with its original remote identity', async () => {
  const { engine, client, localAdapter, stateDB, remote, waiting, release } = await buildLateDeletion();
  const full = engine.syncManual({ manual: true });
  await waiting;
  localAdapter.files['renamed.md'] = localAdapter.files['early.md'];
  delete localAdapter.files['early.md'];
  await engine.renameSingleFile('early.md', 'renamed.md');
  expect(stateDB.getPendingFileRenames()).toHaveLength(1);
  release(); await full; await stateDB.flush();
  expect(remote.has('early.md')).toBe(false);
  expect(remote.get('renamed.md')?.info.fileId).toBe('early.md');
  expect(stateDB.getFile('renamed.md')?.remoteFileId).toBe('early.md');
  expect(stateDB.getPendingFileRenames()).toHaveLength(0);
  expect(client.uploadFile).not.toHaveBeenCalled();
  expect(client.deleteFile).not.toHaveBeenCalled();
  expect(client.getFiles).toHaveBeenCalledTimes(2);
});

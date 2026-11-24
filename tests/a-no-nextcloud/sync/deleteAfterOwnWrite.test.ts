import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModuleKind, transpileModule } from 'typescript';
import { DataAdapter, TFile, TFolder } from 'obsidian';
import { LocalAdapter, isSyncTmpPath } from '../../../src/data/LocalAdapter';
import { buildEngine, makeLocalAdapter } from '../support/engineHarness';

const File = TFile as unknown as new(path: string) => TFile;
const Folder = TFolder as unknown as new(path: string) => TFolder;
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// Run the actual event wiring and real ignore timers. The engine double models the
// existing tracked/missing proof, independently of event filtering.
function host() {
  const source = readFileSync(resolve('src/main.ts'), 'utf8');
  const start = source.indexOf('      // Watch mode: single-file');
  const rename = source.indexOf("this.registerEvent(this.app.vault.on('rename'", start);
  const end = source.indexOf('\n\n      // Sync on foreground resume', rename);
  const body = transpileModule(source.slice(start, end), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const events = new Map<string, (...args: any[]) => void>();
  const present = new Set<string>();
  const tracked = new Set<string>();
  const local = new LocalAdapter({ exists: async (p: string) => present.has(p) } as DataAdapter);
  const deleted = jest.fn(async (path: string) => { tracked.delete(path); });
  const engine = { isSyncRunning: () => false, canRunWatchSync: () => true,
    retargetLocalCreation: () => false, rememberFileRename: jest.fn(), rememberFolderRename: jest.fn(),
    renameSingleFile: jest.fn(async () => undefined), renameSingleFolder: jest.fn(async () => undefined),
    syncRememberedFileRename: jest.fn(async () => undefined), syncSingleFile: jest.fn(async () => undefined),
    isLocalDeletionPending: async (path: string) => !await local.exists(path) && tracked.has(path),
    deleteSingleFile: deleted, deleteSingleFileForMobileWatch: async (path: string) => { await deleted(path); return true; },
    deleteSingleFolder: deleted, deleteSingleFolderForMobileWatch: async (path: string) => { await deleted(path); return true; },
    syncForWatchRecovery: jest.fn(async () => true), rememberFolderDeletion: jest.fn() };
  const self = { settings: { watchOnChangeEnabled: true, watchDebounceSeconds: 0 }, lastLocalEdit: new Map(),
    app: { vault: { configDir: '.obsidian', on: (name: string, fn: (...args: any[]) => void) => events.set(name, fn) },
      workspace: { on: () => undefined } }, registerEvent: () => undefined, syncEngine: engine,
    localAdapter: local,
    hostToken: () => 'test', logger: { log: jest.fn() }, refreshMobileConflictStatus: () => undefined };
  const debounce = (fn: () => void, delay: number) => {
    let timer: ReturnType<typeof setTimeout>;
    return () => { clearTimeout(timer); timer = setTimeout(fn, delay); };
  };
  new Function('TFile', 'TFolder', 'isSyncTmpPath', 'debounce', 'EDIT_WINDOW_MS', body)
    .call(self, TFile, TFolder, isSyncTmpPath, debounce, 2000);
  const remove = (path: string, folder = false) => {
    present.delete(path);
    events.get('delete')!(folder ? new Folder(path) : new File(path));
  };
  return { local, present, tracked, deleted, engine, self, remove, events };
}

test('rechecks a real user deletion during a recent write', async () => {
  const h = host();
  h.tracked.add('Offer.md'); h.local.ignore('Offer.md');
  h.remove('Offer.md'); h.remove('Offer.md');
  expect(h.deleted).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted.mock.calls).toEqual([['Offer.md']]);
});

test.each(['own-trash', 'atomic-replace', 'user-recreate'])('%s never feeds back into remote deletion', async kind => {
  const h = host();
  h.tracked.add('note.md'); h.local.ignore('note.md'); h.remove('note.md');
  if (kind === 'own-trash') h.tracked.delete('note.md');
  else h.present.add('note.md');
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted).not.toHaveBeenCalled();
  expect(h.engine.syncForWatchRecovery).not.toHaveBeenCalled();
});

test('an ignore refresh retains one recheck at the final expiry', async () => {
  const h = host();
  h.tracked.add('note.md'); h.local.ignore('note.md'); h.remove('note.md');
  await jest.advanceTimersByTimeAsync(3000); h.local.ignore('note.md');
  await jest.advanceTimersByTimeAsync(4999); expect(h.deleted).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1); expect(h.deleted).toHaveBeenCalledTimes(1);
});

test.each([false, true])('a later rename supersedes the old-path recheck, folder=%s', async folder => {
  const h = host();
  const path = 'Project/note.md';
  h.tracked.add(path); h.local.ignore(path); h.remove(path);
  h.present.add('Moved/note.md');
  if (folder) h.events.get('rename')!(new Folder('Moved'), 'Project');
  else h.events.get('rename')!(new File('Moved/note.md'), path);
  // Simulate an unsuccessful MOVE: old tracking still exists. Only rename intent
  // may handle it; the earlier replacement's delete echo must not become DELETE.
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted).not.toHaveBeenCalled();
});

test.each(['own-first', 'own-after'])('an own trash with retained tracking never becomes user deletion (%s)', async order => {
  const h = host();
  h.tracked.add('note.md');
  h.local.ignore('note.md', order === 'own-first'); h.remove('note.md');
  if (order === 'own-after') h.local.ignore('note.md', true);
  // A filesystem may remove successfully and then reject, leaving tracking intact.
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted).not.toHaveBeenCalled();
});

test.each(['engine', 'server', 'account'])('never replays an old event after changing %s', async change => {
  const h = host();
  h.tracked.add('note.md'); h.local.ignore('note.md'); h.remove('note.md');
  if (change === 'engine') h.self.syncEngine = { ...h.engine };
  else if (change === 'server') (h.self.settings as any).serverUrl = 'other';
  else (h.self.settings as any).username = 'other';
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted).not.toHaveBeenCalled();
});

test.each(['scope', 'rename', 'folder-rename', 'unload', 'own-trash'])('invalidates an asynchronous existence proof on %s', async superseded => {
  const h = host();
  let finish!: (pending: boolean) => void;
  h.engine.isLocalDeletionPending = () => new Promise<boolean>(resolve => { finish = resolve; });
  h.tracked.add('Project/note.md'); h.local.ignore('Project/note.md'); h.remove('Project/note.md');
  await jest.advanceTimersByTimeAsync(5001);
  if (superseded === 'scope') h.self.syncEngine = { ...h.engine };
  else if (superseded === 'rename') h.events.get('rename')!(new File('moved.md'), 'Project/note.md');
  else if (superseded === 'folder-rename') h.events.get('rename')!(new Folder('Archive'), 'Project');
  else if (superseded === 'unload') h.local.dispose();
  else h.local.ignore('Project/note.md', true);
  finish(true);
  await jest.advanceTimersByTimeAsync(0);
  expect(h.deleted).not.toHaveBeenCalled();
});

test('a failed atomic replacement cannot convert its own removed target into user deletion', async () => {
  const h = host();
  h.tracked.add('note.md');
  const files = new Set(['note.md']);
  const local = new LocalAdapter({
    exists: async (p: string) => files.has(p), mkdir: async () => undefined,
    write: async (p: string) => { files.add(p); },
    remove: async (p: string) => {
      files.delete(p);
      if (p === 'note.md') {
        // The real host still uses this LocalAdapter in the event callback.
        h.remove(p);
      }
    },
    rename: async () => { throw new Error('rename failed after removing the target'); },
  } as unknown as DataAdapter);
  h.self.localAdapter = local;
  await expect(local.atomicWrite('note.md', 'replacement')).rejects.toThrow('rename failed');
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted).not.toHaveBeenCalled();
});

test.each([false, true])('the engine only confirms still-missing tracked paths, folder=%s', async folder => {
  const local = makeLocalAdapter({});
  const { engine, stateDB } = await buildEngine(local, {});
  const path = folder ? 'Project' : 'note.md';
  expect(await engine.isLocalDeletionPending(path, folder)).toBe(false);
  if (folder) stateDB.setDir({ path, remoteFileId: 'id' });
  else stateDB.setFile({ path, localHash: 'h', remoteId: 'h', idType: 'sha256',
    mtime: 1, size: 1, isConflicted: false, remoteFileId: 'id' });
  expect(await engine.isLocalDeletionPending(path, folder)).toBe(true);
  local.files[path] = 'restored';
  expect(await engine.isLocalDeletionPending(path, folder)).toBe(false);
});

test.each(['watch-off', 'unload'])('drops automatic rechecks on %s', async stop => {
  const h = host();
  h.tracked.add('note.md'); h.local.ignore('note.md'); h.remove('note.md');
  if (stop === 'watch-off') h.self.settings.watchOnChangeEnabled = false;
  else h.local.dispose();
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted).not.toHaveBeenCalled();
});

test.each([false, true])('keeps real folder deletion intent only while still tracked, own=%s', async own => {
  const h = host();
  h.tracked.add('Project'); h.local.ignore('Project'); h.remove('Project', true);
  if (own) h.tracked.delete('Project');
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted.mock.calls).toEqual(own ? [] : [['Project']]);
});

test('internal temp paths never queue a recheck', async () => {
  const h = host();
  for (const path of ['.write.ncs.tmp']) {
    h.tracked.add(path); h.local.ignore(path); h.remove(path);
  }
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted).not.toHaveBeenCalled();
});

test('a remove that deletes then rejects is still our own failed replacement', async () => {
  const h = host(); h.tracked.add('note.md');
  const files = new Set(['note.md']);
  const local = new LocalAdapter({
    exists: async (p: string) => files.has(p), mkdir: async () => undefined,
    write: async (p: string) => { files.add(p); },
    remove: async (p: string) => {
      files.delete(p);
      if (p === 'note.md') { h.remove(p); throw new Error('remove reported failure after unlink'); }
    },
    rename: async () => { throw new Error('rename must not run'); },
  } as unknown as DataAdapter);
  h.self.localAdapter = local;
  await expect(local.atomicWrite('note.md', 'replacement')).rejects.toThrow('remove reported failure');
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted).not.toHaveBeenCalled();
  expect(files.size).toBe(1);
  expect([...files][0]).toMatch(/\.ncs\.tmp$/);
});


test('a successful replacement still observes a later real user deletion', async () => {
  const h = host(); h.tracked.add('note.md');
  const files = new Set(['note.md']);
  const local = new LocalAdapter({
    exists: async (p: string) => files.has(p), mkdir: async () => undefined,
    write: async (p: string) => { files.add(p); },
    remove: async (p: string) => { files.delete(p); if (p === 'note.md') h.remove(p); },
    rename: async (from: string, to: string) => { files.delete(from); files.add(to); },
  } as unknown as DataAdapter);
  h.self.localAdapter = local;
  await local.atomicWrite('note.md', 'replacement');
  files.delete('note.md'); h.remove('note.md');
  await jest.advanceTimersByTimeAsync(5001);
  expect(h.deleted.mock.calls).toEqual([['note.md']]);
});

test.each(['guarded-rename', 'unconditional-remove'])('the real delete sink preserves remote after failed %s', async failure => {
  const h = host();
  const files = new Map([['note.md', 'original']]);
  const buffer = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
  const local = new LocalAdapter({
    exists: async (p: string) => files.has(p), mkdir: async () => undefined,
    stat: async (p: string) => files.has(p) ? { type: 'file', size: buffer(files.get(p)!).byteLength, mtime: 1000, ctime: 1000 } : null,
    readBinary: async (p: string) => buffer(files.get(p)!),
    write: async (p: string, body: string) => { files.set(p, body); },
    remove: async (p: string) => {
      files.delete(p);
      if (p === 'note.md') { h.remove(p); if (failure === 'unconditional-remove') throw new Error('operation failed after mutation'); }
    },
    rename: async (source: string, destination: string) => {
      if (files.has(destination)) throw new Error('EEXIST');
      files.set(destination, files.get(source)!); files.delete(source);
      if (source === 'note.md' && failure === 'guarded-rename') { h.remove(source); throw new Error('operation failed after mutation'); }
    },
  } as unknown as DataAdapter, undefined, undefined, async () => 'untrusted');
  const deletion = jest.fn(async () => undefined);
  const remote = { path: 'note.md', fileId: 'f1', checksum: 'h1', etag: 'e1', size: 8, lastModified: 1000 };
  const client = { statFile: async () => remote, deleteFile: deletion };
  const { SyncEngine } = await import('../../../src/sync/SyncEngine');
  const { DEFAULT_SETTINGS } = await import('../../../src/types');
  const tracked = new Map([['note.md', { path: 'note.md', localHash: 'h1', remoteId: 'h1', idType: 'sha256', size: 8, mtime: 1000, remoteFileId: 'f1', isConflicted: false }]]);
  const engine = new SyncEngine({
    app: {}, settings: DEFAULT_SETTINGS, localAdapter: local,
    stateDB: { getFile: (p: string) => tracked.get(p), deleteFile: (p: string) => tracked.delete(p), requestSave() {} },
    statusBar: { setStatus() {} }, webdavFactory: { createClient: async () => ({ client, features: {} }) }, pluginDir: '', configDir: '.obsidian',
  } as never);
  h.self.syncEngine = engine as never; h.self.localAdapter = local;
  const expected = failure === 'guarded-rename' ? { stat: { size: 8, mtime: 1000 } } : undefined;
  await expect(local.atomicWrite('note.md', 'newbody!', undefined, undefined, expected)).rejects.toThrow('operation failed after mutation');
  await jest.advanceTimersByTimeAsync(5001);
  expect(deletion).not.toHaveBeenCalled();
  if (failure === 'guarded-rename') expect(files.get('note.md')).toBe('original');
  local.dispose();
});

import type { DataAdapter } from 'obsidian';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { ResolutionService } from '../../../src/sync/resolution/ResolutionService';
import { TransferService } from '../../../src/sync/transfer/TransferService';
import { SyncJournal } from '../../../src/sync/session/SyncJournal';
import { makeSummary } from '../support/engineHarness';
import { passThroughLocalWrite } from '../support/pluginPorts';
import type { FileState, RemoteFileInfo } from '../../../src/types';

const path = 'note.md';
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

function fixture(fail: boolean) {
  const original = 'local original';
  const files = new Map([[path, { body: bytes(original), mtime: 1000 }]]);
  const adapter = {
    stat: async (name: string) => {
      const file = files.get(name);
      return file ? { type: 'file', size: file.body.byteLength, mtime: file.mtime } : null;
    },
    exists: async (name: string) => files.has(name),
    readBinary: async (name: string) => files.get(name)!.body.slice(0),
    writeBinary: async (name: string, data: ArrayBuffer, options?: { mtime?: number }) => {
      files.set(name, { body: data.slice(0), mtime: options?.mtime ?? 3000 });
    },
    rename: async (from: string, to: string) => {
      if (files.has(to)) throw new Error('Destination exists');
      files.set(to, files.get(from)!); files.delete(from);
      if (fail && from === path) throw new Error('replacement failed after mutation');
    },
    remove: async (name: string) => {
      files.delete(name);
      if (fail && name === path) throw new Error('replacement failed after mutation');
    },
  } as unknown as DataAdapter;
  const local = new LocalAdapter(adapter);
  const base: FileState = { path, localHash: 'base', remoteId: 'base', idType: 'sha256',
    size: original.length, mtime: 1000, remoteFileId: 'stable-id', isConflicted: true };
  let state = base;
  let remoteBody = 'remote chosen';
  const remote = (): RemoteFileInfo => ({ path, fileId: 'stable-id', checksum: 'remote-hash',
    etag: 'etag', size: bytes(remoteBody).byteLength, lastModified: 2000 });
  const client = { getFiles: async () => [remote()], downloadFile: async () => bytes(remoteBody) };
  const uploadStrategy = { upload: async (_client: unknown, _path: string, body: ArrayBuffer) => {
    remoteBody = new TextDecoder().decode(body); return 'uploaded' as const;
  } };
  const stateDB = { getFile: () => state, setFile: (next: FileState) => { state = next; },
    save: jest.fn(async () => undefined), countConflicted: () => 1 };
  const snapshot = { local: 'clean local chosen', remote: 'clean remote chosen',
    localMtime: 1, remoteMtime: 2, localSize: 1, remoteSize: 2 };
  const cleanSideStore = { get: () => snapshot, delete: jest.fn(), requestSave: jest.fn() };
  const common = { localAdapter: local, stateDB, localWrite: passThroughLocalWrite,
    journal: new SyncJournal({}), mergeBase: { record: jest.fn(), recordBytes: jest.fn() },
    maxFileSizeMB: () => 100 };
  const transfer = new TransferService({ ...common, hasFilesLocking: () => false,
    clientReportsChecksums: () => true, queueRetry: jest.fn() } as never);
  const resolution = new ResolutionService({ ...common, transfer, cleanSideStore,
    autoMergeFileTypes: () => ['md'] } as never);
  const run = async (workflow: string) => {
    if (workflow === 'force-pull') await resolution.pullRemoteToLocal(client as never, path);
    else if (workflow === 'clean-remote') await resolution.applyCleanRemote({ client, uploadStrategy } as never, path);
    else if (workflow === 'clean-local') await resolution.applyCleanLocal({ client, uploadStrategy } as never, path);
    else await transfer.downloadFile(client as never, remote(), 'remote-hash', 'sha256', makeSummary());
  };
  return { local, files, base, state: () => state, stateDB, cleanSideStore, run,
    read: () => new TextDecoder().decode(files.get(path)?.body) };
}

test.each(['force-pull', 'clean-remote', 'clean-local', 'transfer-without-expectation'])(
  '%s keeps the previous copy recoverable when replacement mutates then rejects', async workflow => {
    const f = fixture(true);
    try {
      await expect(f.run(workflow)).rejects.toThrow('replacement failed after mutation');
      expect(await f.local.stat(path)).not.toBeNull();
      expect(f.read()).toBe('local original');
      expect(f.state()).toBe(f.base);
      expect(f.stateDB.save).not.toHaveBeenCalled();
      expect(f.cleanSideStore.delete).not.toHaveBeenCalled();
    } finally { f.local.dispose(); }
  },
);

test.each(['force-pull', 'clean-remote', 'clean-local', 'transfer-without-expectation'])(
  '%s still applies the explicitly selected content on success', async workflow => {
    const f = fixture(false);
    try {
      await f.run(workflow);
      expect(f.read()).toBe(workflow === 'clean-remote' ? 'clean remote chosen'
        : workflow === 'clean-local' ? 'clean local chosen' : 'remote chosen');
      expect(f.state().remoteFileId).toBe('stable-id');
      expect(f.files.size).toBe(1);
    } finally { f.local.dispose(); }
  },
);

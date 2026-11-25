// [SPEC:MIR-1] Regression: planRemoteMirror must lazily connect via ensureClient (like a normal sync),
// not read a possibly-null this.client, which aborted with "Not signed in" before any sync had run.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { sha256 } from '../../../src/util/hash';
import {
  DavSyncSettings, FileState, NextcloudFeatures, RemoteFileInfo, RemoteRootMissingError,
} from '../../../src/types';

const remote = (path: string, checksum: string | null): RemoteFileInfo => ({
  path, fileId: null, checksum, etag: null, size: 1, lastModified: 0,
});

function settings(): DavSyncSettings {
  return {
    configDir: '.obsidian', syncConfigFolder: false, excludedFolders: [], maxFileSizeMB: 0,
    networkConcurrency: 4,
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  } as unknown as DavSyncSettings;
}

function makeEngine(over: {
  tracked?: FileState;
  getFiles?: jest.Mock;
  createThrows?: boolean;
  localFiles?: Array<{ path: string; content: Uint8Array }>;
  recalcChecksum?: jest.Mock;
  getDirectories?: jest.Mock;
}) {
  const feats: NextcloudFeatures = {
    isNextcloud: true, version: '30', hasChecksums: true, hasFilesLocking: false,
    hasBulkUpload: false, hasAccountDav: true, syncToken: null,
  };
  const localFiles = over.localFiles ?? [];
  const byPath = new Map(localFiles.map((f) => [f.path, f.content]));
  const client = {
    getFiles: over.getFiles ?? jest.fn(async () => [] as RemoteFileInfo[]),
    recalcChecksum: over.recalcChecksum ?? jest.fn(async () => null),
    getDirectories: over.getDirectories ?? jest.fn(async () => []),
  };
  const localAdapter = {
    listVaultFiles: () => localFiles.map((f) => ({ path: f.path, size: f.content.byteLength, mtime: 0 })),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async () => null),
    readBinary: jest.fn(async (p: string) => {
      const c = byPath.get(p);
      return (c ? c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) : new ArrayBuffer(0)) as ArrayBuffer;
    }),
  };
  const vault = { adapter: localAdapter, getAllFolders: () => [] };
  const stateDB = { getFile: (path: string) => path === over.tracked?.path ? over.tracked : undefined, getAllFiles: () => [], getAllDirs: () => [] };
  const createClient = over.createThrows
    ? jest.fn(async () => { throw new Error('no credentials'); })
    : jest.fn(async () => ({ client, features: feats }));
  const engine = new SyncEngine({
    app: { vault, fileManager: {} }, settings: settings(), localAdapter,
    stateDB, statusBar: {}, webdavFactory: { createClient }, onFeatures: jest.fn(),
    pluginDir: '.obsidian/plugins/nextcloud-sync', configDir: '.obsidian',
  } as never);
  return { engine, client, createClient };
}

describe('[SPEC:MIR-1] SyncEngine.planRemoteMirror — connects on demand', () => {
  it('connects via ensureClient (does not require a prior sync) and classifies the remote', async () => {
    const getFiles = jest.fn(async () => [remote('a.md', 'ha'), remote('b.md', 'hb')]);
    const { engine, createClient } = makeEngine({ getFiles });
    const plan = await engine.planRemoteMirror();
    expect(createClient).toHaveBeenCalledTimes(1); // built the client itself — no "Not signed in"
    expect(plan.ok).toBe(true);
    expect(plan.downloads.map((d) => d.path).sort()).toEqual(['a.md', 'b.md']);
  });

  it('[SPEC:MIR-1] skips an identical file whose server checksum was absent but is resolved on demand (no re-download)', async () => {
    // Migration case: the remote file was placed by another tool → PROPFIND returns checksum=null.
    // planRemoteMirror must recalc the checksum server-side (no download) so an identical local file
    // is SKIPPED, not re-downloaded (SC-004).
    const content = new TextEncoder().encode('same bytes on both sides');
    const hash = await sha256(content.buffer.slice(0) as ArrayBuffer);
    const getFiles = jest.fn(async () => [{ ...remote('same.md', null), size: content.length }]); // server has no stored checksum
    const recalcChecksum = jest.fn(async () => hash); // server computes it on demand (no download)
    const { engine } = makeEngine({
      getFiles, recalcChecksum,
      localFiles: [{ path: 'same.md', content }],
    });
    const plan = await engine.planRemoteMirror();
    expect(recalcChecksum).toHaveBeenCalledWith('same.md');
    expect(plan.downloads).toHaveLength(0); // NOT re-downloaded
    expect(plan.skipCount).toBe(1);
  });

  it.each(['missed revision', 'legacy state', 'fresh device', 'unchanged revision', 'verified read-only revision', 'changed reported checksum'] as const)(
    'checks a cached same-size checksum against the remote revision (%s)', async (scenario) => {
      const content = new TextEncoder().encode('B');
      const hash = await sha256(content.buffer as ArrayBuffer);
      const listed = { ...remote('note.md', hash), etag: 'current' };
      const tracked: FileState = {
        path: listed.path, idType: 'sha256', localHash: 'A', remoteId: 'A', size: 1, mtime: 0,
        remoteFileId: null, isConflicted: false,
        remoteEtag: scenario === 'legacy state' ? undefined : 'previous',
      };
      if (scenario === 'unchanged revision') Object.assign(tracked, { localHash: hash, remoteId: hash, remoteEtag: listed.etag });
      if (scenario === 'verified read-only revision' || scenario === 'changed reported checksum') {
        Object.assign(tracked, { idType: 'etag', localHash: hash, remoteEtag: listed.etag, remoteId: listed.etag,
          remoteChecksum: scenario === 'verified read-only revision' ? 'incorrect-cached-checksum' : 'previous-checksum' });
        listed.checksum = 'incorrect-cached-checksum';
      }
      const recalcChecksum = jest.fn(async () => null); // e.g. a read-only share cannot persist a new checksum
      const { engine } = makeEngine({
        tracked: scenario === 'fresh device' ? undefined : tracked,
        localFiles: [{ path: listed.path, content }], getFiles: jest.fn(async () => [listed]), recalcChecksum,
      });
      const plan = await engine.planRemoteMirror();
      if (scenario === 'unchanged revision' || scenario === 'verified read-only revision') {
        expect(recalcChecksum).not.toHaveBeenCalled();
        expect(plan.skipCount).toBe(1);
      } else {
        expect(recalcChecksum).toHaveBeenCalledTimes(1);
        expect(plan.downloads).toEqual([{ ...listed, checksum: null, reportedChecksum: listed.checksum }]);
      }
    },
  );

  it('returns ok:false (not a crash) when the server cannot be connected', async () => {
    const { engine } = makeEngine({ createThrows: true });
    const plan = await engine.planRemoteMirror();
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('Not connected');
    expect(plan.deleteFiles).toHaveLength(0);
  });

  it('returns ok:false when the remote listing throws (abort gate, zero deletions)', async () => {
    const getFiles = jest.fn(async () => { throw new Error('PROPFIND 500'); });
    const { engine } = makeEngine({ getFiles });
    const plan = await engine.planRemoteMirror();
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('Failed to list the remote');
    expect(plan.deleteFiles).toHaveLength(0);
  });

  it('[SPEC:MIR-6] returns ok:false with zero deletions or creations when the folder listing throws', async () => {
    const getDirectories = jest.fn(async () => { throw new Error('boom'); });
    const { engine } = makeEngine({
      getDirectories,
      localFiles: [{ path: 'keepme.md', content: new TextEncoder().encode('local only') }],
    });
    const plan = await engine.planRemoteMirror();

    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/^Failed to list the remote/);
    expect(plan.deleteFiles).toHaveLength(0);
    expect(plan.deleteDirs).toHaveLength(0);
    expect(plan.createDirs).toHaveLength(0);
  });

  it('[SPEC:VRR-6] plans zero deletions when the vault folder itself is missing from the server', async () => {
    // Mirror-from-remote deletes whatever the listing does not hold, so a root 404 read as "[]" would plan the
    // deletion of every local file. The typed throw routes it through the abort gate, which keeps the plan
    // empty: it must stay `ok:false`, never "mirror an empty server". The repair is the sync path's (VRR-1).
    const getFiles = jest.fn(async (): Promise<RemoteFileInfo[]> => { throw new RemoteRootMissingError(); });
    const { engine } = makeEngine({
      getFiles,
      localFiles: [{ path: 'keepme.md', content: new TextEncoder().encode('local only') }],
    });
    const plan = await engine.planRemoteMirror();

    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('Failed to list the remote');
    expect(plan.deleteFiles).toHaveLength(0);
    expect(plan.deleteDirs).toHaveLength(0);
    expect(plan.downloads).toHaveLength(0);
  });
});

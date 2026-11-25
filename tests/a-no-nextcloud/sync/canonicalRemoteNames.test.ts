import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { StateDB } from '../../../src/data/StateDB';
import { MergeBaseStore } from '../../../src/data/MergeBaseStore';
import { CleanSideStore } from '../../../src/data/CleanSideStore';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { LocalPathIdentityError, assertUnambiguousLocalPaths } from '../../../src/sync/scan/localPathIdentity';
import { DEFAULT_SETTINGS, type FileState, type RemoteFileInfo, type SyncSessionSummary } from '../../../src/types';
import { FakeVault } from '../../b1-nextcloud-headless/support/fakeVault';
import { sha256 } from '../../../src/util/hash';

const old = 'Notes/Cafe\u0301.md', canonical = old.normalize('NFC');
const bytes = (body: string) => new TextEncoder().encode(body).buffer as ArrayBuffer;
async function build(localPaths = [old]) {
  const vault = new FakeVault();
  vault.seedFolder('.obsidian/plugins/test');
  for (const path of localPaths) vault.seedLocal(path, 'base');
  const adapter = new LocalAdapter(vault.adapter, vault.vault);
  const state = new StateDB(vault.adapter, '.obsidian/plugins/test', 'device');
  const bases = new MergeBaseStore(vault.adapter, '.obsidian/plugins/test', 'device');
  const clean = new CleanSideStore(vault.adapter, '.obsidian/plugins/test', 'device');
  const hash = await sha256(bytes('base'));
  const tracked: FileState = { path: old, remoteFileId: 'id', localHash: hash, remoteId: hash, idType: 'sha256', size: 4,
    mtime: 1, localMtime: 1, localSize: 4, isConflicted: false };
  state.setFile(tracked); bases.set(old, 'real base');
  const remote: RemoteFileInfo = { path: canonical, fileId: 'id', checksum: hash, etag: 'etag', size: 4, lastModified: 1 };
  const client = { deleteFile: jest.fn(), recalcChecksum: jest.fn(async () => hash) };
  const engine = new SyncEngine({ app: vault.app, localAdapter: adapter, stateDB: state, baseStore: bases, cleanSideStore: clean,
    settings: { ...DEFAULT_SETTINGS, deviceId: 'test' }, statusBar: {}, webdavFactory: {},
    pluginDir: '.obsidian/plugins/test', configDir: '.obsidian' } as never);
  const inner = engine as unknown as {
    client: typeof client; features: { isNextcloud: boolean };
    reconcileCanonicalRemoteNames(files: RemoteFileInfo[]): Promise<void>;
    processRemoteFile(remote: RemoteFileInfo, summary: SyncSessionSummary): Promise<void>;
    uploadOrConflict: jest.Mock;
    deletion: { applyLocalDeletion: (...args: unknown[]) => Promise<unknown>; assertNoLocalAlias(base: FileState, summary: SyncSessionSummary): Promise<number | undefined> };
  };
  inner.client = client; inner.features = { isNextcloud: true };
  const summary = { startedAt: Date.now(), errors: [], errorCount: 0 } as unknown as SyncSessionSummary;
  const close = async () => { adapter.dispose(); await state.flush(); await bases.flush(); await clean.flush(); };
  return { vault, adapter, state, bases, clean, tracked, remote, client, inner, summary, close };
}

describe('server-normalized names', () => {
  it.each([[[old]], [[old, canonical]], [[]]])('holds unresolved local spellings %j without changing tracking or content', async paths => {
    const h = await build(paths);
    try {
      await expect(h.inner.reconcileCanonicalRemoteNames([h.remote])).rejects.toBeInstanceOf(LocalPathIdentityError);
      expect(h.state.getFile(old)).toEqual(h.tracked);
      expect(h.state.getFile(canonical)).toBeUndefined();
      expect(h.bases.get(old)).toBe('real base'); expect(h.client.deleteFile).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('adopts only the manually corrected exact name, preserving the baseline and forcing a content read', async () => {
    const h = await build([canonical]);
    try {
      await h.inner.reconcileCanonicalRemoteNames([h.remote]);
      expect(h.state.getFile(old)).toBeUndefined();
      expect(h.state.getFile(canonical)).toEqual({ ...h.tracked, path: canonical, localMtime: undefined, localSize: undefined });
      expect(h.bases.get(old)).toBeUndefined(); expect(h.bases.get(canonical)).toBe('real base');
      // The user can also edit while correcting a name, including a same-size/mtime edit.
      await h.vault.adapter.write(canonical, 'edit', { mtime: 1 });
      const read = jest.spyOn(h.adapter, 'readBinary');
      h.inner.uploadOrConflict = jest.fn();
      await h.inner.processRemoteFile(h.remote, h.summary);
      expect(read).toHaveBeenCalledWith(canonical);
      expect(h.inner.uploadOrConflict).toHaveBeenCalledTimes(1);
    } finally { await h.close(); }
  });

  it('cleans a compatible legacy duplicate without relying on the single-ID reverse index', async () => {
    const h = await build([canonical]);
    try {
      const canonicalState = { ...h.tracked, path: canonical, idType: 'etag' as const, remoteId: 'etag' };
      h.state.setFile(canonicalState); h.bases.set(canonical, 'real base');
      // Make the reverse index point to the old alias; all State entries must still be examined.
      h.state.setFile(h.tracked);
      await h.inner.reconcileCanonicalRemoteNames([h.remote]);
      expect(h.state.getAllFiles()).toEqual([{ ...canonicalState, localMtime: undefined, localSize: undefined }]);
      expect(h.state.getFileByRemoteId('id')?.path).toBe(canonical);
      expect(h.bases.get(canonical)).toBe('real base'); expect(h.bases.get(old)).toBeUndefined();
    } finally { await h.close(); }
  });

  it.each(['hash', 'id', 'base', 'clean'] as const)('holds incompatible legacy duplicate %s metadata', async difference => {
    const h = await build([canonical]);
    try {
      h.state.setFile({ ...h.tracked, path: canonical, ...(difference === 'hash' ? { localHash: 'different' } : {}),
        ...(difference === 'id' ? { remoteFileId: 'other' } : {}) });
      if (difference === 'base') h.bases.set(canonical, 'different base');
      if (difference === 'clean') {
        h.clean.set(old, { local: 'one' } as never); h.clean.set(canonical, { local: 'two' } as never);
      }
      await expect(h.inner.reconcileCanonicalRemoteNames([h.remote])).rejects.toBeInstanceOf(LocalPathIdentityError);
      expect(h.state.getAllFiles()).toHaveLength(2); expect(h.bases.get(old)).toBe('real base');
    } finally { await h.close(); }
  });

  it.each([old, canonical])('blocks direct DELETE of %s while the other same-ID spelling remains local', async removed => {
    const remaining = removed === old ? canonical : old;
    const h = await build([remaining]);
    try {
      h.state.setFile({ ...h.tracked, path: canonical });
      const base = h.state.getFile(removed)!;
      await expect(h.inner.deletion.applyLocalDeletion(h.client, { ...h.remote, path: removed }, base,
        h.remote.checksum, 'sha256', h.summary)).rejects.toBeInstanceOf(LocalPathIdentityError);
      expect(h.client.deleteFile).not.toHaveBeenCalled(); expect(h.client.recalcChecksum).not.toHaveBeenCalled();
      expect(h.vault.readLocal(remaining)).toBe('base');
    } finally { await h.close(); }
  });

  it.each([
    [[old], [canonical]], [[old, canonical], [canonical]],
    [['Cafe\u0301/one.md'], ['Café/two.md']],
    [[], [old, canonical]], [['K.md'], ['K.md']],
  ])('holds canonically colliding in-scope names: %j vs %j', async (local, remote) => {
    const adapter = { stat: jest.fn(), list: jest.fn() };
    await expect(assertUnambiguousLocalPaths(adapter, local, remote)).rejects.toBeInstanceOf(LocalPathIdentityError);
    expect(adapter.stat).not.toHaveBeenCalled(); expect(adapter.list).not.toHaveBeenCalled();
  });

  it('does not rewrite a shared decomposed name or conflate genuinely distinct names', async () => {
    const adapter = { stat: jest.fn(async () => null), list: jest.fn() };
    await assertUnambiguousLocalPaths(adapter, [old, 'Notes/Cafe.md'], [old, 'Notes/Café-other.md']);
    expect(adapter.list).not.toHaveBeenCalled();
  });
});

describe('per-run alias proof cache', () => {
  it('enumerates State once for an ordinary bulk deletion and does not invalidate on removals', async () => {
    const h = await build([]);
    try {
      h.state.deleteFile(old);
      const files = Array.from({ length: 50 }, (_, i) => ({ ...h.tracked, path: `Notes/${i}.md`, remoteFileId: String(i) }));
      files.forEach(file => h.state.setFile(file));
      const enumerations = jest.spyOn(h.state, 'getAllFiles');
      const generation = h.state.getFileIdentityGeneration();
      for (const base of files) await h.inner.deletion.applyLocalDeletion(h.client, { ...h.remote, path: base.path, fileId: base.remoteFileId },
        base, base.remoteId, base.idType, h.summary);
      expect(h.client.deleteFile).toHaveBeenCalledTimes(50);
      expect(enumerations).toHaveBeenCalledTimes(1);
      expect(h.state.getFileIdentityGeneration()).toBe(generation);
    } finally { await h.close(); }
  });

  it('rechecks an alias introduced while remote deletion proof is in flight', async () => {
    const h = await build([]);
    try {
      h.client.recalcChecksum.mockImplementationOnce(async () => {
        h.vault.seedLocal(canonical, 'base');
        h.state.setFile({ ...h.tracked, path: canonical });
        return h.tracked.localHash;
      });
      await expect(h.inner.deletion.applyLocalDeletion(h.client, { ...h.remote, path: old, checksum: null }, h.tracked,
        h.tracked.remoteId, h.tracked.idType, h.summary)).rejects.toBeInstanceOf(LocalPathIdentityError);
      expect(h.client.deleteFile).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('rechecks an identity added between the final async proof and the DELETE continuation', async () => {
    const h = await build([]);
    try {
      const originalProof = h.inner.deletion.assertNoLocalAlias.bind(h.inner.deletion);
      let calls = 0;
      jest.spyOn(h.inner.deletion, 'assertNoLocalAlias').mockImplementation(async (...args) => {
        const generation = await originalProof(...args);
        if (++calls === 2) queueMicrotask(() => {
          h.vault.seedLocal(canonical, 'base'); h.state.setFile({ ...h.tracked, path: canonical });
        });
        return generation;
      });
      await expect(h.inner.deletion.applyLocalDeletion(h.client, { ...h.remote, path: old }, h.tracked,
        h.tracked.remoteId, h.tracked.idType, h.summary)).rejects.toBeInstanceOf(LocalPathIdentityError);
      expect(h.client.deleteFile).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('refreshes for a same-path remote identity change and does not hold a genuinely different ID', async () => {
    const h = await build([canonical]);
    try {
      h.state.setFile({ ...h.tracked, path: canonical, remoteFileId: 'other' });
      await h.inner.deletion.assertNoLocalAlias(h.tracked, h.summary);
      h.state.setFile({ ...h.tracked, path: canonical });
      await expect(h.inner.deletion.assertNoLocalAlias(h.tracked, h.summary)).rejects.toBeInstanceOf(LocalPathIdentityError);
      h.state.deleteFile(canonical);
      await h.inner.deletion.assertNoLocalAlias(h.tracked, h.summary);
    } finally { await h.close(); }
  });

  it('refreshes after loading saved aliases and after reset, without persisting the revision or cache', async () => {
    const h = await build([canonical]);
    try {
      h.state.setFile({ ...h.tracked, path: canonical });
      await h.state.save();
      h.state.deleteFile(canonical);
      await h.inner.deletion.assertNoLocalAlias(h.tracked, h.summary);
      await h.state.load();
      await expect(h.inner.deletion.assertNoLocalAlias(h.tracked, h.summary)).rejects.toBeInstanceOf(LocalPathIdentityError);
      await h.state.reset();
      await h.inner.deletion.assertNoLocalAlias(h.tracked, h.summary);
      const persisted = h.vault.readLocal('.obsidian/plugins/test/state-device.json');
      expect(persisted).not.toContain('IdentityGeneration'); expect(persisted).not.toContain('aliasesByRun');
    } finally { await h.close(); }
  });
});

import { VersionService } from '../../../../src/sync/versions/VersionService';
import { buildEngine, makeLocalAdapter, makeSummary, callProcessRemote, remoteOf, toBuf } from '../../support/engineHarness';
import { sha256 } from '../../../../src/util/hash';

const path = 'note.md';
const beforeRestore = 'HEAD\nRESTORED_DELETION\nKEEP1\nKEEP2\nKEEP3\nTAIL\n';
const restored = 'HEAD\nKEEP1\nKEEP2\nKEEP3\nTAIL\n';
const remoteEdit = 'HEAD\nKEEP1\nKEEP2\nKEEP3\nREMOTE_EDIT\nTAIL\n';
const features = { isNextcloud: true, hasAccountDav: true };

it('persists the restored merge base before success and retains both subsequent device edits', async () => {
  const local = makeLocalAdapter({ [path]: beforeRestore });
  let body = restored;
  const client = {
    restoreVersion: jest.fn(async () => undefined),
    downloadFile: jest.fn(async () => toBuf(body)),
    statFile: jest.fn(async () => remoteOf(path, body, { checksum: await sha256(toBuf(body)), fileId: 'fid' })),
  };
  const { engine, stateDB, baseStore } = await buildEngine(local, client);
  const bases = new Map([[path, beforeRestore]]);
  (baseStore.get as jest.Mock).mockImplementation((...args: unknown[]) => bases.get(String(args[0])));
  baseStore.set.mockImplementation((...args: unknown[]) => { bases.set(String(args[0]), String(args[1])); });
  const oldHash = await sha256(toBuf(beforeRestore));
  stateDB.setFile({ path, localHash: oldHash, remoteId: oldHash, idType: 'sha256', size: toBuf(beforeRestore).byteLength, mtime: 1000, remoteFileId: 'fid', isConflicted: false });
  // Exercise the actual engine wiring, not a manually seeded control base.
  Object.assign(engine, { features });
  await engine.restoreVersion(path, { versionId: 'old' } as never);
  expect(bases.get(path)).toBe(restored);
  expect(baseStore.flush).toHaveBeenCalled();
  local.files[path] = beforeRestore; // A intentionally re-adds the line removed by Restore.
  body = remoteEdit; // B adds another line, based on the restored revision.
  await callProcessRemote(engine, await client.statFile(), makeSummary());
  expect(local.files[path]).toContain('RESTORED_DELETION');
  expect(local.files[path]).toContain('REMOTE_EDIT');
});

it('refuses mismatched remote content/metadata without overwriting the local file', async () => {
  const local = makeLocalAdapter({ [path]: 'local edit' });
  const { stateDB } = await buildEngine(local, {});
  stateDB.setFile({ path, remoteFileId: 'fid' } as never);
  stateDB.setRemoteRootEtag('old');
  let generation = 0;
  const client = {
    restoreVersion: async () => undefined,
    statFile: jest.fn(async () => remoteOf(path, 'same', { fileId: 'fid', checksum: null, etag: `e${++generation}` })),
    downloadFile: jest.fn(async () => toBuf('same')),
  };
  const service = new VersionService({ localAdapter: local, stateDB });
  await expect(service.restoreVersion(client as never, features as never, path, {} as never)).rejects.toThrow('changed while');
  expect(local.files[path]).toBe('local edit');
  expect(local.atomicWriteBinary).not.toHaveBeenCalled();
  expect(stateDB.getRemoteRootEtag()).toBeNull();
  expect(client.downloadFile).toHaveBeenCalledTimes(2);
});

it('rejects a path replaced by another file ID during Restore', async () => {
  const local = makeLocalAdapter({ [path]: 'local edit' });
  const { stateDB } = await buildEngine(local, {});
  stateDB.setFile({ path, remoteFileId: 'fid' } as never);
  const client = { restoreVersion: async () => undefined, statFile: async () => remoteOf(path, 'other', { fileId: 'replacement' }), downloadFile: jest.fn() };
  await expect(new VersionService({ localAdapter: local, stateDB }).restoreVersion(client as never, features as never, path, {} as never)).rejects.toThrow();
  expect(client.downloadFile).not.toHaveBeenCalled();
  expect(local.files[path]).toBe('local edit');
});

it('does not report success when the restored base cannot be persisted', async () => {
  const local = makeLocalAdapter({ [path]: 'old' });
  const { stateDB } = await buildEngine(local, {});
  stateDB.setFile({ path, remoteFileId: 'fid' } as never);
  const client = { restoreVersion: async () => undefined, statFile: async () => remoteOf(path, 'restored', { fileId: 'fid', checksum: null }), downloadFile: async () => toBuf('restored') };
  const save = jest.spyOn(stateDB, 'save');
  const service = new VersionService({ localAdapter: local, stateDB, mergeBase: { recordBytes: jest.fn() }, flushMergeBase: async () => { throw new Error('disk full'); } });
  await expect(service.restoreVersion(client as never, features as never, path, {} as never)).rejects.toThrow('disk full');
  expect(save).not.toHaveBeenCalled();
});

it('keeps upstream iOS compatibility for a nonempty body whose byte length differs from PROPFIND', async () => {
  const local = makeLocalAdapter({ [path]: 'old' });
  const { stateDB } = await buildEngine(local, {});
  stateDB.setFile({ path, remoteFileId: 'fid' } as never);
  const remote = remoteOf(path, 'restored', { fileId: 'fid', checksum: 'server-original-hash', size: 7 });
  const client = { restoreVersion: async () => undefined, statFile: async () => remote, downloadFile: async () => toBuf('restored') };
  await new VersionService({ localAdapter: local, stateDB }).restoreVersion(client as never, features as never, path, {} as never);
  expect(local.files[path]).toBe('restored');
  expect(stateDB.getFile(path)?.remoteId).toBe('server-original-hash');
  expect(stateDB.getFile(path)?.localHash).toBe(await sha256(toBuf('restored')));
});

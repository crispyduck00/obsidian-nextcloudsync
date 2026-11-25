import { sha256 } from '../../../../src/util/hash';
import { withTrustedChecksum } from '../../../../src/sync/remoteIdentity';
import { fileSameContent } from '../../../../src/sync/plugins/bundleDirection';
import { shouldFetchRemoteManifest } from '../../../../src/sync/plugins/pluginCatalog';
import { RemoteListingSource } from '../../../../src/sync/scan/RemoteListingSource';
import { buildEngine, callProcessRemote, makeLocalAdapter, makeSummary, remoteOf, toBuf } from '../../support/engineHarness';

it.each(['checksum', 'size'] as const)('detects changed %s after a checksum fallback with the same ETag', async evidence => {
  const path = 'note.bin';
  let body = 'first';
  const hash = await sha256(toBuf(body));
  const local = makeLocalAdapter({ [path]: body });
  const downloadFile = jest.fn(async () => toBuf(body));
  const { engine, stateDB } = await buildEngine(local, { downloadFile });
  const remote = remoteOf(path, body, { checksum: await sha256(toBuf('stale')), etag: 'reused' });
  stateDB.setFile({ path, localHash: hash, remoteId: hash, idType: 'sha256', size: 5,
    mtime: 1000, remoteFileId: remote.fileId, remoteEtag: 'before', isConflicted: false });

  // A stale checksum is first verified against GET and falls back to ETag identity.
  await callProcessRemote(engine, remote, makeSummary());
  await callProcessRemote(engine, remote, makeSummary());
  expect(downloadFile).toHaveBeenCalledTimes(1);
  await stateDB.save();
  stateDB.deleteFile(path);
  await stateDB.load();

  body = evidence === 'checksum' ? 'other' : 'a longer remote body';
  const changed = { ...remote, size: toBuf(body).byteLength,
    checksum: evidence === 'checksum' ? await sha256(toBuf(body)) : remote.checksum };
  await callProcessRemote(engine, changed, makeSummary());
  expect(local.files[path]).toBe(body);
  expect(stateDB.getFile(path)?.localHash).toBe(await sha256(toBuf(body)));
  expect(downloadFile).toHaveBeenCalledTimes(2);
  await callProcessRemote(engine, changed, makeSummary());
  expect(downloadFile).toHaveBeenCalledTimes(2);
});

it('does not accept a changed advertised checksum as proof of content equality under a reused ETag', async () => {
  const path = 'note.bin', draft = 'draft';
  const draftHash = await sha256(toBuf(draft));
  const local = makeLocalAdapter({ [path]: draft });
  const downloadFile = jest.fn(async () => toBuf('other'));
  const { engine, stateDB } = await buildEngine(local, { downloadFile });
  stateDB.setFile({ path, localHash: draftHash, remoteId: 'reused', idType: 'etag', size: 5,
    mtime: 1000, remoteFileId: 'f1', remoteEtag: 'reused', isConflicted: false });
  await callProcessRemote(engine, remoteOf(path, 'other', { checksum: draftHash, etag: 'reused' }), makeSummary());
  expect(local.files[path]).toBe('other');
  expect(downloadFile).toHaveBeenCalledWith(path, 'reused');
});

it.each(['same', 'changed', 'legacy'] as const)('uses the same revision proof for plugin bundles (%s)', observation => {
  const base = { path: 'manifest.json', localHash: 'actual-body-hash', remoteId: 'reused', idType: 'etag' as const,
    size: 5, mtime: 1000, remoteFileId: 'f1', remoteEtag: 'reused', isConflicted: false,
    remoteChecksum: observation === 'legacy' ? undefined : 'old-advertised-hash' };
  const remote = withTrustedChecksum(remoteOf(base.path, 'other', { etag: 'reused',
    checksum: observation === 'changed' ? 'new-advertised-hash' : 'old-advertised-hash' }), base);
  expect(fileSameContent({ localHash: base.localHash, remote, base, localChanged: false })).toBe(observation === 'same');
  expect(shouldFetchRemoteManifest({ localHash: base.localHash, remoteManifest: remote, base })).toBe(observation !== 'same');
});

it('retains the previous observation when verifying changed metadata fails', async () => {
  const path = 'note.bin';
  const hash = await sha256(toBuf('first'));
  const local = makeLocalAdapter({ [path]: 'first' });
  const { engine, stateDB } = await buildEngine(local, { downloadFile: async () => { throw new Error('offline'); } });
  const base = { path, localHash: hash, remoteId: 'reused', idType: 'etag' as const, size: 5,
    mtime: 1000, remoteFileId: 'f1', remoteEtag: 'reused', remoteChecksum: 'previous', isConflicted: false };
  stateDB.setFile(base);
  await expect(callProcessRemote(engine, remoteOf(path, 'other', { etag: 'reused', checksum: 'changed' }), makeSummary()))
    .rejects.toThrow('offline');
  expect(stateDB.getFile(path)).toEqual(base);
  expect(local.files[path]).toBe('first');
});

it('retains advertised checksum evidence in revision-proof snapshots without trusting it in cached sync', () => {
  const base = { path: 'note.bin', localHash: 'actual-body-hash', remoteId: 'reused', idType: 'etag' as const,
    size: 5, mtime: 1000, remoteFileId: 'f1', remoteEtag: 'reused', remoteChecksum: 'advertised', isConflicted: false };
  const listing = new RemoteListingSource({ stateDB: { getAllFiles: () => [base], getRootSizeSkippedFiles: () => [] } } as never);
  expect(listing.rebuildRemoteFilesFromState()[0].checksum).toBeNull();
  expect(listing.rebuildRemoteFilesFromState(true)[0]).toMatchObject({ checksum: 'advertised', etag: 'reused' });
});

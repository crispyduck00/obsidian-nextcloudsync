import { matchesTrackedRemote } from '../../../../src/sync/push/matchesTrackedRemote';
import { sha256 } from '../../../../src/util/hash';
import { buildEngine, callProcessRemote, makeLocalAdapter, makeSummary, remoteOf, toBuf } from '../../support/engineHarness';

const path = 'note.md';
const latest = '# Title\nNew body\n';
const restored = '# Title\nOld body\n';

it.each(['etag', 'mtime'] as const)('reads a restored body even when Nextcloud repeats the checksum (%s)', async evidence => {
  const checksum = await sha256(toBuf(latest));
  const prior = remoteOf(path, latest, { checksum, etag: 'before', lastModified: 20_000 });
  const rollback = { ...prior, etag: 'after', lastModified: evidence === 'mtime' ? 10_000 : prior.lastModified };
  const local = makeLocalAdapter({ [path]: latest });
  const downloadFile = jest.fn(async () => toBuf(restored));
  const { engine, stateDB } = await buildEngine(local, { downloadFile });
  const base = {
    path, localHash: checksum, remoteId: checksum, idType: 'sha256' as const, size: prior.size,
    remoteFileId: prior.fileId, mtime: prior.lastModified, remoteMtime: prior.lastModified, isConflicted: false,
    localMtime: 1000, localSize: prior.size, remoteEtag: evidence === 'etag' ? prior.etag! : undefined,
  };
  stateDB.setFile(base);
  if (evidence === 'etag') {
    await callProcessRemote(engine, prior, makeSummary());
    expect(downloadFile).not.toHaveBeenCalled();
    expect(matchesTrackedRemote([rollback], [], [prior], [], () => false)).toBe(false);
  }

  await callProcessRemote(engine, rollback, makeSummary());
  expect(local.files[path]).toBe(restored);
  expect(stateDB.getFile(path)).toMatchObject({ remoteId: 'after', idType: 'etag', remoteEtag: 'after' });

  await callProcessRemote(engine, rollback, makeSummary());
  expect(downloadFile).toHaveBeenCalledTimes(1);
  expect(local.atomicWriteBinary).toHaveBeenCalledTimes(1);
});

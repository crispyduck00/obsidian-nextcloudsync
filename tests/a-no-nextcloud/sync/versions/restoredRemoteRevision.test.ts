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
    expect(matchesTrackedRemote([{ ...prior, checksum: 'different' }], [], [prior], [], () => false)).toBe(false);
  }

  await callProcessRemote(engine, rollback, makeSummary());
  expect(local.files[path]).toBe(restored);
  expect(stateDB.getFile(path)).toMatchObject({ remoteId: 'after', idType: 'etag', remoteEtag: 'after' });

  await callProcessRemote(engine, rollback, makeSummary());
  expect(downloadFile).toHaveBeenCalledTimes(1);
  expect(local.atomicWriteBinary).toHaveBeenCalledTimes(1);
});

it.each(['tracked', 'legacy', 'new'] as const)('checks an equal-size draft against the current body before convergence (%s)', async kind => {
  const draft = 'draft';
  const checked = 'other';
  const advertised = await sha256(toBuf(draft));
  const baseHash = await sha256(toBuf('prior'));
  const file = remoteOf('note.bin', checked, { checksum: advertised, etag: 'restored' });
  const local = makeLocalAdapter({ [file.path]: draft });
  const downloadFile = jest.fn(async () => toBuf(checked));
  const upload = jest.fn(async () => 'uploaded' as const);
  const { engine, stateDB } = await buildEngine(local, { downloadFile }, { otherFileStrategy: 'remote-win' }, { upload });
  Object.assign(engine, { features: { isNextcloud: true } });
  if (kind !== 'new') stateDB.setFile({
    path: file.path, localHash: baseHash, remoteId: baseHash, idType: 'sha256', size: 5, mtime: 1000,
    remoteEtag: kind === 'tracked' ? 'prior' : undefined, remoteFileId: file.fileId, isConflicted: false,
  });
  await callProcessRemote(engine, file, makeSummary());
  expect(local.files[file.path]).toBe(checked);
  expect(downloadFile).toHaveBeenCalledWith(file.path, 'restored');
  expect(upload).not.toHaveBeenCalled();
  expect(stateDB.getFile(file.path)?.localHash).toBe(await sha256(toBuf(checked)));
  await callProcessRemote(engine, file, makeSummary());
  expect(downloadFile).toHaveBeenCalledTimes(1);
});

it('preserves the exact draft after a metadata-only MOVE and uses the new ETag on its PUT', async () => {
  const baseHash = await sha256(toBuf('prior'));
  const draft = '# Draft without a trailing newline';
  const file = remoteOf('moved.md', 'prior', { checksum: baseHash, etag: 'after-move' });
  const local = makeLocalAdapter({ [file.path]: draft });
  const downloadFile = jest.fn(async () => toBuf('prior'));
  const upload = jest.fn(async () => 'uploaded' as const);
  const { engine, stateDB } = await buildEngine(local, { downloadFile }, {}, { upload });
  Object.assign(engine, { features: { isNextcloud: true } });
  stateDB.setFile({ path: file.path, localHash: baseHash, remoteId: baseHash, idType: 'sha256',
    remoteEtag: 'before-move', size: 5, mtime: 1000, remoteFileId: file.fileId, isConflicted: false });
  const summary = makeSummary();
  await callProcessRemote(engine, file, summary);
  expect(downloadFile).toHaveBeenCalledTimes(1);
  expect(upload).toHaveBeenCalledWith(expect.anything(), file.path, toBuf(draft), expect.any(Number),
    expect.objectContaining({ ifMatchEtag: file.etag }));
  expect(local.atomicWrite).not.toHaveBeenCalled();
  expect(summary.mergedCount).toBe(0);
});

it('rechecks a legacy checksum before a watch deletion can remove a same-size restored file', async () => {
  const advertised = await sha256(toBuf('prior'));
  const file = remoteOf(path, 'other', { checksum: advertised, etag: 'newer', lastModified: 99_000 });
  const deleteFile = jest.fn();
  const recalcChecksum = jest.fn(async () => sha256(toBuf('other')));
  const local = makeLocalAdapter({});
  const { engine, stateDB } = await buildEngine(local, {
    statFile: async () => file, inspectDirectory: async () => null, recalcChecksum,
    downloadFile: async () => toBuf('other'), deleteFile,
  });
  Object.assign(engine, { features: { isNextcloud: true } });
  stateDB.setFile({ path, localHash: advertised, remoteId: advertised, idType: 'sha256', size: 5,
    mtime: 1000, remoteFileId: file.fileId, isConflicted: false });
  // Drive the same operation used after the watch handler's guarded Depth:0 stat.
  const deletion = Reflect.get(engine, 'deletion');
  await deletion.deleteLocallyMissing(Reflect.get(engine, 'client'), path, stateDB.getFile(path), makeSummary());
  expect(recalcChecksum).toHaveBeenCalledWith(path);
  expect(deleteFile).not.toHaveBeenCalled();
  expect(local.files[path]).toBe('other');
});

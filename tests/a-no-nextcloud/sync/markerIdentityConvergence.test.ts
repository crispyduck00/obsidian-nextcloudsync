import { buildEngine, makeLocalAdapter, makeSummary, callProcessRemote, remoteOf, toBuf } from '../support/engineHarness';
import { sha256 } from '../../../src/util/hash';
const path = 'note.md';
const marker = '<<<<<<< LOCAL\nleft\n=======\nright\n>>>>>>> REMOTE\n';

it.each([true, false])('preserves unresolved marker state through identity shortcuts (checksum=%s)', async (checksum) => {
  const local = makeLocalAdapter({ [path]: marker });
  const client = { downloadFile: jest.fn(async () => toBuf(marker)) };
  const { engine, stateDB, baseStore } = await buildEngine(local, client);
  const hash = await sha256(toBuf(marker));
  stateDB.setFile({ path, localHash: hash, remoteId: 'old-etag', idType: 'etag', size: toBuf(marker).byteLength, mtime: 1, remoteFileId: 'fid', isConflicted: true });
  const remote = remoteOf(path, marker, { fileId: 'fid', checksum: checksum ? hash : null, etag: 'new-etag' });
  if (checksum) await callProcessRemote(engine, remote, makeSummary());
  else await (engine as unknown as { handleConflict: (...args: unknown[]) => Promise<void> }).handleConflict(path, stateDB.getFile(path), remote, 'new-etag', 'etag', makeSummary());
  expect(stateDB.getFile(path)?.isConflicted).toBe(true);
  expect(local.files[path]).toBe(marker);
  expect(local.atomicWrite).not.toHaveBeenCalled();
  expect(baseStore.set).not.toHaveBeenCalled();
});

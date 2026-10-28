import { convergedState } from '../../../src/sync/identity/contentIdentity';
import { buildEngine, makeLocalAdapter, callProcessRemote, makeSummary, remoteOf, toBuf } from '../support/engineHarness';
import { sha256 } from '../../../src/util/hash';
import type { FileState } from '../../../src/types';
const path = 'note.md';
const previous: FileState = { path, localHash: 'h', remoteId: 'r', idType: 'etag', remoteFileId: 'fid', size: 1, mtime: 1, isConflicted: false, ctimeLocalAttempt: 42, ctimeRemoteAttempt: 43 };

it('preserves failed creation-time attempts for the same remote identity during checksum convergence', async () => {
  const local = makeLocalAdapter({ [path]: 'same' });
  const { engine, stateDB } = await buildEngine(local, {});
  const hash = await sha256(toBuf('same'));
  stateDB.setFile({ ...previous, localHash: hash, size: 4 });
  await callProcessRemote(engine, remoteOf(path, 'same', { fileId: 'fid', checksum: hash }), makeSummary());
  expect(stateDB.getFile(path)).toMatchObject({ ctimeLocalAttempt: 42, ctimeRemoteAttempt: 43 });
});

it('does not carry failed server metadata attempts onto a replacement file ID', () => {
  const state = convergedState(remoteOf(path, 'same', { fileId: 'replacement' }), 'h', { size: 4, mtime: 1 }, previous);
  expect(state.ctimeRemoteAttempt).toBeUndefined();
  expect(state.ctimeLocalAttempt).toBeUndefined();
});

it('does not erase a known file ID when the current response omits it', () => {
  const state = convergedState(remoteOf(path, 'same', { fileId: null }), 'h', { size: 4, mtime: 1 }, previous);
  expect(state.remoteFileId).toBe('fid');
  expect(state.ctimeRemoteAttempt).toBe(43);
});

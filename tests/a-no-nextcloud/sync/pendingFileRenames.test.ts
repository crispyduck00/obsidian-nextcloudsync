import type { DataAdapter } from 'obsidian';
import { StateDB } from '../../../src/data/StateDB';
import type { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { PendingFileRenames } from '../../../src/sync/PendingFileRenames';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { ConflictError, NetworkError, DEFAULT_SETTINGS, type FileState, type RemoteFileInfo } from '../../../src/types';

const original: FileState = {
  path: 'Old.md', localHash: 'hash', remoteId: 'hash', idType: 'sha256', size: 4, mtime: 1,
  remoteFileId: 'original-id', remoteEtag: 'original-rev', isConflicted: false,
};
const remoteOriginal: RemoteFileInfo = {
  path: original.path, fileId: original.remoteFileId, checksum: 'hash', etag: 'original-rev', size: 4,
  lastModified: 1, permissions: 'GDNVW',
};

async function build() {
  const disk = new Map<string, string>();
  const adapter = {
    exists: async (p: string) => disk.has(p),
    read: async (p: string) => disk.get(p),
    write: async (p: string, bytes: string) => { disk.set(p, bytes); },
    remove: async (p: string) => { disk.delete(p); },
    rename: async (a: string, b: string) => { disk.set(b, disk.get(a)!); disk.delete(a); },
  } as unknown as DataAdapter;
  const newState = () => new StateDB(adapter, '.obsidian/plugins/nextcloud-sync', 'device');
  const db = newState();
  db.setFile(original);
  await db.save();

  const local = new Set(['New.md']);
  const remote = new Map([[original.path, remoteOriginal]]);
  const settings = { scope: 'account/vault', excluded: '' };
  const serverMove = async (source: string, destination: string, etag: string): Promise<void> => {
    const file = remote.get(source);
    expect(file?.etag).toBe(etag);
    expect(remote.has(destination)).toBe(false);
    remote.delete(source);
    remote.set(destination, { ...file!, path: destination });
  };
  const move = jest.fn(serverMove);
  const client = {
    statFile: jest.fn(async (p: string) => remote.get(p) ?? null),
    downloadFile: jest.fn(async () => new TextEncoder().encode('peer').buffer),
  } as unknown as IWebDAVClient;
  const queueFor = (state: StateDB) => new PendingFileRenames({
    state,
    local: { isFile: async path => local.has(path) },
    scope: () => settings.scope,
    isExcluded: p => !!settings.excluded && p.startsWith(settings.excluded),
    move,
    moveTracking: (source, destination, file) => {
      state.deleteFile(source);
      state.setFile({ ...file, path: destination });
    },
    isCancelled: () => false,
  });
  const restart = async () => {
    const state = newState();
    await state.load();
    return { db: state, queue: queueFor(state) };
  };
  return { db, queue: queueFor(db), client, remote, local, settings, move, serverMove, restart };
}

describe('persistent file renames', () => {
  it('persists the intent before requesting MOVE, then retries a lock after restarting', async () => {
    const h = await build();
    expect(h.queue.capture('Old.md', 'New.md')).toBe(true);
    h.move.mockImplementationOnce(async () => {
      const { queue } = await h.restart();
      expect(queue.list()).toEqual([expect.objectContaining({ attemptedDestination: 'New.md' })]);
      throw new NetworkError(423, '', 'MOVE');
    });
    await expect(h.queue.retry(h.client)).resolves.toBe(false);

    const { db, queue } = await h.restart();
    expect(queue.list()).toEqual([expect.objectContaining({ issue: 'locked', destination: 'New.md' })]);
    expect(queue.holds('Old.md')).toBe(true);
    expect(queue.holds('New.md')).toBe(true);
    await expect(queue.retry(h.client)).resolves.toBe(true);
    expect(h.move).toHaveBeenLastCalledWith('Old.md', 'New.md', 'original-rev');
    expect(db.getFile('New.md')?.remoteFileId).toBe(original.remoteFileId);
    expect(db.getFile('Old.md')).toBeUndefined();
    expect((await h.restart()).queue.list()).toEqual([]);
  });

  it('uses explicit read-only permissions and tries MOVE when write access comes back', async () => {
    const h = await build();
    h.remote.set('Old.md', { ...remoteOriginal, permissions: 'SG' });
    h.queue.capture('Old.md', 'New.md');
    await h.queue.retry(h.client);
    expect(h.move).not.toHaveBeenCalled();
    expect(h.queue.list()[0].issue).toBe('read-only');
    h.remote.set('Old.md', remoteOriginal);
    await expect(h.queue.retry(h.client)).resolves.toBe(true);
  });

  it('holds an inferred rename if a peer edits the source after the lock or after app restart', async () => {
    const h = await build();
    h.queue.capture('Old.md', 'New.md', 'inferred');
    h.move.mockRejectedValueOnce(new NetworkError(423, '', 'MOVE'));
    await h.queue.retry(h.client);
    expect(h.queue.list()[0].issue).toBe('locked');

    h.remote.set('Old.md', { ...remoteOriginal, checksum: 'peer-edit', etag: 'peer-revision' });
    const { queue } = await h.restart();
    await expect(queue.retry(h.client)).resolves.toBe(false);
    expect(queue.list()[0].issue).toBe('conflict');
    expect(h.move).toHaveBeenCalledTimes(1);
    expect(h.remote.has('New.md')).toBe(false);
  });

  it('checks the actual revision before moving an inferred legacy source after a restore', async () => {
    const h = await build();
    h.db.setFile({ ...original, remoteEtag: undefined });
    h.queue.capture('Old.md', 'New.md', 'inferred');
    await expect(h.queue.retry(h.client)).resolves.toBe(false);
    expect(h.client.downloadFile).toHaveBeenCalledWith('Old.md', remoteOriginal.etag);
    expect(h.queue.list()[0].issue).toBe('conflict');
    expect(h.move).not.toHaveBeenCalled();
  });

  it('holds an older, unproven cross-folder rename saved by RC.3', async () => {
    const h = await build();
    const destination = 'Shared/New.md';
    h.local.add(destination);
    h.db.setPendingFileRenames([{ source: 'Old.md', destination, scope: h.settings.scope, fileId: original.remoteFileId }]);
    await h.db.save();

    const { queue } = await h.restart();
    await expect(queue.retry(h.client)).resolves.toBe(false);
    expect(queue.list()[0].issue).toBe('conflict');
    expect(h.move).not.toHaveBeenCalled();
  });

  it('rechecks the target type after saving and reserves a subtree that now occupies a held path', async () => {
    const h = await build();
    h.queue.capture('Old.md', 'New.md');
    const save = h.db.save.bind(h.db);
    jest.spyOn(h.db, 'save').mockImplementationOnce(async () => {
      await save();
      h.local.delete('New.md');
    });

    await expect(h.queue.retry(h.client)).resolves.toBe(false);
    expect(h.queue.list()[0].issue).toBe('local-missing');
    expect(h.queue.holds('New.md/Local child.md')).toBe(true);
    expect(h.queue.holds('New.md.bak')).toBe(false);
    expect(h.move).not.toHaveBeenCalled();
  });

  it('keeps both paths on a server denial that is not known to be read-only', async () => {
    const h = await build();
    h.move.mockRejectedValueOnce(new NetworkError(403, '', 'MOVE'));
    h.queue.capture('Old.md', 'New.md');
    await h.queue.retry(h.client);
    expect(h.queue.list()[0].issue).toBe('denied');
    expect(h.remote.has('New.md')).toBe(false);
    expect(h.queue.holds('Old.md') && h.queue.holds('New.md')).toBe(true);
  });

  it.each(['destination occupied', 'source replaced'])('records a conflict when %s', async kind => {
    const h = await build();
    const path = kind === 'destination occupied' ? 'New.md' : 'Old.md';
    h.remote.set(path, { ...remoteOriginal, path, fileId: 'peer-id' });
    h.queue.capture('Old.md', 'New.md');
    await h.queue.retry(h.client);
    expect(h.move).not.toHaveBeenCalled();
    expect(h.queue.list()[0].issue).toBe('conflict');
    expect(h.remote.get(path)?.fileId).toBe('peer-id');
  });

  it('finds the original at the new path when the server moved it before the response was lost', async () => {
    const h = await build();
    h.move.mockImplementationOnce(async (...args) => {
      await h.serverMove(...args);
      throw new NetworkError(0, '', 'MOVE');
    });
    h.queue.capture('Old.md', 'New.md');
    await h.queue.retry(h.client);
    const { db, queue } = await h.restart();
    await expect(queue.retry(h.client)).resolves.toBe(true);
    expect(h.move).toHaveBeenCalledTimes(1);
    expect(db.getFile('New.md')?.remoteFileId).toBe(original.remoteFileId);
    expect(queue.list()).toEqual([]);
  });

  it('retains an in-flight destination while the user renames again', async () => {
    const h = await build();
    h.queue.capture('Old.md', 'New.md');
    h.move.mockImplementationOnce(async (...args) => {
      expect(h.queue.capture('New.md', 'Final.md')).toBe(true);
      h.local.delete('New.md');
      h.local.add('Final.md');
      await h.serverMove(...args);
      throw new NetworkError(0, '', 'MOVE');
    });
    await h.queue.retry(h.client);
    const { queue, db } = await h.restart();
    expect(queue.holds('New.md')).toBe(true);
    await queue.retry(h.client);
    expect(queue.list()).toEqual([expect.objectContaining({ source: 'New.md', destination: 'Final.md' })]);
    await queue.retry(h.client);
    expect(h.move.mock.calls).toEqual([['Old.md', 'New.md', 'original-rev'], ['New.md', 'Final.md', 'original-rev']]);
    expect(db.getFile('Final.md')?.remoteFileId).toBe(original.remoteFileId);
  });

  it('cancels a blocked rename that the user undoes locally', async () => {
    const h = await build();
    h.queue.capture('Old.md', 'New.md');
    h.move.mockRejectedValueOnce(new NetworkError(423, '', 'MOVE'));
    await h.queue.retry(h.client);
    h.local.delete('New.md');
    h.local.add('Old.md');
    h.queue.capture('New.md', 'Old.md');
    await h.queue.retry(h.client);
    expect(h.move).toHaveBeenCalledTimes(1);
    expect(h.queue.list()).toEqual([]);
    expect(h.db.getFile('Old.md')).toEqual(original);
  });

  it('holds missing local work and does not replay against another account or scope', async () => {
    const h = await build();
    h.queue.capture('Old.md', 'New.md');
    h.local.clear();
    await h.queue.retry(h.client);
    expect(h.queue.list()[0].issue).toBe('local-missing');
    h.settings.scope = 'other/account';
    await h.queue.retry(h.client);
    expect(h.queue.list()[0].issue).toBe('scope');
    expect(h.move).not.toHaveBeenCalled();
  });

  it('rechecks a rejected precondition with the current revision of the same file', async () => {
    const h = await build();
    h.queue.capture('Old.md', 'New.md');
    h.move.mockImplementationOnce(async () => {
      h.remote.set('Old.md', { ...remoteOriginal, etag: 'peer-rev', checksum: 'edited' });
      throw new ConflictError('New.md');
    });
    await h.queue.retry(h.client);
    await h.queue.retry(h.client);
    expect(h.move).toHaveBeenLastCalledWith('Old.md', 'New.md', 'peer-rev');
    expect(h.remote.get('New.md')?.checksum).toBe('edited');
  });
});

describe('manual server-normalized name correction', () => {
  const source = 'Cafe\u0301.md', destination = source.normalize('NFC');
  async function normalizedRename() {
    const h = await build();
    h.db.deleteFile(original.path);
    h.db.setFile({ ...original, path: source, localMtime: 100, localSize: 4 });
    h.remote.clear();
    h.remote.set(source, { ...remoteOriginal, path: source });
    h.remote.set(destination, { ...remoteOriginal, path: destination });
    h.local.clear(); h.local.add(destination);
    h.queue.capture(source, destination);
    return h;
  }

  it('recognizes the same-ID normalized destination after restart without sending MOVE or inventing a content signature', async () => {
    const h = await normalizedRename();
    await h.db.save();
    const { db, queue } = await h.restart();
    await expect(queue.retry(h.client)).resolves.toBe(true);
    expect(h.move).not.toHaveBeenCalled(); expect(queue.list()).toEqual([]);
    expect(db.getFile(source)).toBeUndefined();
    expect(db.getFile(destination)).toEqual(expect.objectContaining({ remoteFileId: original.remoteFileId,
      localHash: original.localHash, localMtime: undefined, localSize: undefined }));
  });

  it.each(['source remains', 'different ID', 'unrelated spelling'] as const)('keeps a safe conflict when %s', async mode => {
    const h = await normalizedRename();
    if (mode === 'source remains') h.local.add(source);
    if (mode === 'different ID') h.remote.set(destination, { ...remoteOriginal, path: destination, fileId: 'other' });
    if (mode === 'unrelated spelling') {
      h.db.setPendingFileRenames([]); h.queue.capture(source, 'Other.md');
      h.remote.set('Other.md', { ...remoteOriginal, path: 'Other.md' }); h.local.add('Other.md');
    }
    await expect(h.queue.retry(h.client)).resolves.toBe(false);
    expect(h.move).not.toHaveBeenCalled(); expect(h.queue.list()[0].issue).toBe('conflict');
    expect(h.db.getFile(source)?.localHash).toBe(original.localHash);
  });
});


it('marks an existing rename ownership stop as requiring manual resolution without changing its message', async () => {
  const h = await build(); h.queue.capture('Old.md', 'New.md');
  const engine = new SyncEngine({ app: { vault: { adapter: {} } }, stateDB: h.db, localAdapter: {}, statusBar: {}, webdavFactory: {},
    settings: { ...DEFAULT_SETTINGS }, pluginDir: '.obsidian/plugins/nextcloud-sync', configDir: '.obsidian' } as never);
  const guard = engine as unknown as { assertFileRenameSettled(path: string): void };
  expect(() => guard.assertFileRenameSettled('New.md')).toThrow('Resolve the pending rename in Sync status before changing this path.');
  try { guard.assertFileRenameSettled('Old.md'); throw new Error('Expected a rename hold'); }
  catch (error) { expect(error).toMatchObject({ requiresManualResolution: true }); }
  expect(() => guard.assertFileRenameSettled('Unrelated.md')).not.toThrow();
});

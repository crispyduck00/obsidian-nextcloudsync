import { RemotePushReconciler } from '../../../../src/sync/push/RemotePushReconciler';
import type { DirState, FileState } from '../../../../src/types';

const tracked = (path: string, fileId: string): FileState => ({
  path,
  localHash: 'local',
  remoteId: 'remote',
  idType: 'etag',
  size: 1,
  mtime: 1,
  remoteFileId: fileId,
  isConflicted: false,
});

const dir = (path: string, fileId: string): DirState => ({ path, remoteFileId: fileId });
const batch = (fileIds: readonly string[], rootFileId: string | null = null) => ({ fileIds, rootFileId });

function build(
  files: Record<string, FileState> = {},
  dirs: DirState[] = [],
  running = () => false,
) {
  const reconciled: Array<[string, string]> = [];
  const reconcileFile = jest.fn(async (path: string, fileId: string) => {
    reconciled.push([path, fileId]);
    return 'done' as const;
  });
  const reconciler = new RemotePushReconciler({
    stateDB: {
      getFileByRemoteId: (id: string) => files[id],
      getAllDirs: () => dirs,
    },
    isFullSyncRunning: running,
    reconcileFile,
  });
  return { reconciler, reconcileFile, reconciled };
}

describe('RemotePushReconciler', () => {
  it('reconciles known file IDs only', async () => {
    const h = build({ a: tracked('A.md', 'a'), b: tracked('B.md', 'b') });

    await expect(h.reconciler.reconcileFileIds(batch(['a', 'b']))).resolves.toBe('done');
    expect(h.reconciled).toEqual([['A.md', 'a'], ['B.md', 'b']]);
  });

  it('deduplicates repeated file IDs', async () => {
    const h = build({ a: tracked('A.md', 'a') });

    await expect(h.reconciler.reconcileFileIds(batch(['a', ' a ', 'a']))).resolves.toBe('done');
    expect(h.reconciled).toEqual([['A.md', 'a']]);
  });

  it('accepts a known parent-folder ID when a known pushed file is below it', async () => {
    const h = build(
      { file: tracked('00 Inbox/xxx.md', 'file') },
      [dir('00 Inbox', 'folder')],
    );

    await expect(h.reconciler.reconcileFileIds(batch(['folder', 'file']))).resolves.toBe('done');
    expect(h.reconciled).toEqual([['00 Inbox/xxx.md', 'file']]);
  });

  it('accepts multiple known ancestor folders for the same pushed file', async () => {
    const h = build(
      { file: tracked('A/B/xxx.md', 'file') },
      [dir('A', 'a-dir'), dir('A/B', 'b-dir')],
    );

    await expect(h.reconciler.reconcileFileIds(batch(['a-dir', 'b-dir', 'file']))).resolves.toBe('done');
    expect(h.reconciled).toEqual([['A/B/xxx.md', 'file']]);
  });

  it('accepts the positively identified vault root as an ancestor of a root-level file', async () => {
    const h = build({ file: tracked('root.md', 'file') });

    await expect(h.reconciler.reconcileFileIds(batch(['root', 'file'], 'root'))).resolves.toBe('done');
    expect(h.reconciled).toEqual([['root.md', 'file']]);
  });

  it('accepts the positively identified vault root as an ancestor of a nested file', async () => {
    const h = build({ file: tracked('A/B/note.md', 'file') });

    await expect(h.reconciler.reconcileFileIds(batch(['root', 'file'], 'root'))).resolves.toBe('done');
    expect(h.reconciled).toEqual([['A/B/note.md', 'file']]);
  });

  it('falls back for a root-only notification', async () => {
    const h = build();

    await expect(h.reconciler.reconcileFileIds(batch(['root'], 'root'))).resolves.toBe('full-sync');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('falls back when root propagation is accompanied by an unknown ID', async () => {
    const h = build({ file: tracked('root.md', 'file') });

    await expect(h.reconciler.reconcileFileIds(batch(['root', 'file', 'unknown'], 'root'))).resolves.toBe('full-sync');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('falls back if the vault root ID collides with tracked file state', async () => {
    const h = build({ root: tracked('wrong.md', 'root') });

    await expect(h.reconciler.reconcileFileIds(batch(['root'], 'root'))).resolves.toBe('full-sync');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('falls back if the vault root ID collides with tracked directory state', async () => {
    const h = build({}, [dir('Wrong', 'root')]);

    await expect(h.reconciler.reconcileFileIds(batch(['root'], 'root'))).resolves.toBe('full-sync');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('falls back for a folder-only notification', async () => {
    const h = build({}, [dir('00 Inbox', 'folder')]);

    await expect(h.reconciler.reconcileFileIds(batch(['folder']))).resolves.toBe('full-sync');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('falls back when a pushed folder is unrelated to every pushed file', async () => {
    const h = build(
      { file: tracked('B/xxx.md', 'file') },
      [dir('A', 'folder')],
    );

    await expect(h.reconciler.reconcileFileIds(batch(['folder', 'file']))).resolves.toBe('full-sync');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('returns untracked when every pushed ID is unknown locally', async () => {
    const h = build();

    await expect(h.reconciler.reconcileFileIds(batch(['new-a', 'new-b']))).resolves.toBe('untracked');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('falls back before touching files when an unknown ID accompanies known vault state', async () => {
    const h = build({ a: tracked('A.md', 'a') });

    await expect(h.reconciler.reconcileFileIds(batch(['a', 'new-or-unknown']))).resolves.toBe('full-sync');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('falls back if a directory ID is duplicated in tracked state', async () => {
    const h = build(
      { file: tracked('A/xxx.md', 'file') },
      [dir('A', 'folder'), dir('Other', 'folder')],
    );

    await expect(h.reconciler.reconcileFileIds(batch(['folder', 'file']))).resolves.toBe('full-sync');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('falls back if the same remote ID maps to file and directory state', async () => {
    const h = build(
      { same: tracked('A.md', 'same') },
      [dir('A', 'same')],
    );

    await expect(h.reconciler.reconcileFileIds(batch(['same']))).resolves.toBe('full-sync');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('reports busy without touching paths when a full sync is active', async () => {
    const h = build({ a: tracked('A.md', 'a') }, [], () => true);

    await expect(h.reconciler.reconcileFileIds(batch(['a']))).resolves.toBe('busy');
    expect(h.reconcileFile).not.toHaveBeenCalled();
  });

  it('stops between files if a full sync starts after the first targeted reconcile', async () => {
    let running = false;
    const files = { a: tracked('A.md', 'a'), b: tracked('B.md', 'b') };
    const reconcileFile = jest.fn(async (path: string) => {
      if (path === 'A.md') running = true;
      return 'done' as const;
    });
    const reconciler = new RemotePushReconciler({
      stateDB: {
        getFileByRemoteId: (id: string) => files[id as keyof typeof files],
        getAllDirs: () => [],
      },
      isFullSyncRunning: () => running,
      reconcileFile,
    });

    await expect(reconciler.reconcileFileIds(batch(['a', 'b']))).resolves.toBe('busy');
    expect(reconcileFile).toHaveBeenCalledTimes(1);
    expect(reconcileFile).toHaveBeenCalledWith('A.md', 'a');
  });

  it('propagates an ambiguous per-file result immediately', async () => {
    const state = tracked('A.md', 'a');
    const reconcileFile = jest.fn(async () => 'full-sync' as const);
    const reconciler = new RemotePushReconciler({
      stateDB: { getFileByRemoteId: () => state, getAllDirs: () => [] },
      isFullSyncRunning: () => false,
      reconcileFile,
    });

    await expect(reconciler.reconcileFileIds(batch(['a']))).resolves.toBe('full-sync');
  });

  it('falls back when an explainable parent batch becomes structural during per-file validation', async () => {
    const state = tracked('A/file.md', 'file');
    const reconcileFile = jest.fn(async () => 'full-sync' as const);
    const reconciler = new RemotePushReconciler({
      stateDB: {
        getFileByRemoteId: (id: string) => id === 'file' ? state : undefined,
        getAllDirs: () => [dir('A', 'folder')],
      },
      isFullSyncRunning: () => false,
      reconcileFile,
    });

    await expect(reconciler.reconcileFileIds(batch(['folder', 'file']))).resolves.toBe('full-sync');
    expect(reconcileFile).toHaveBeenCalledTimes(1);
    expect(reconcileFile).toHaveBeenCalledWith('A/file.md', 'file');
  });


  it('continues independent files after a deferred result without certifying the batch', async () => {
    const files = { a: tracked('A.md', 'a'), b: tracked('B.md', 'b') };
    const reconcileFile = jest.fn()
      .mockResolvedValueOnce('deferred' as const)
      .mockResolvedValue('done' as const);
    const reconciler = new RemotePushReconciler({
      stateDB: {
        getFileByRemoteId: (id: string) => files[id as keyof typeof files],
        getAllDirs: () => [],
      },
      isFullSyncRunning: () => false,
      reconcileFile,
    });

    await expect(reconciler.reconcileFileIds(batch(['a', 'b']))).resolves.toBe('deferred');
    expect(reconcileFile).toHaveBeenCalledTimes(2);
    expect(reconcileFile).toHaveBeenNthCalledWith(1, 'A.md', 'a');
    expect(reconcileFile).toHaveBeenNthCalledWith(2, 'B.md', 'b');
  });

  it('treats an empty batch as ambiguous', async () => {
    const h = build();
    await expect(h.reconciler.reconcileFileIds(batch(['', '   ']))).resolves.toBe('full-sync');
  });
});

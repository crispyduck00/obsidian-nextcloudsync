import { SyncEngine } from '../../../src/sync/SyncEngine';
import { LocalPathIdentityError } from '../../../src/sync/scan/localPathIdentity';
import { DEFAULT_SETTINGS, type FileState, type RemoteFileInfo, type SyncSessionSummary } from '../../../src/types';

const oldPath = 'note.md';
const newPath = 'Note.md';
const remote: RemoteFileInfo = { path: newPath, fileId: 'same-id', checksum: 'body', etag: 'etag', size: 4, lastModified: 1 };
const tracked: FileState = {
  path: oldPath, remoteFileId: 'same-id', localHash: 'body', remoteId: 'body', idType: 'sha256',
  size: 4, mtime: 1, isConflicted: false,
};

function harness(token = false) {
  const localAdapter = {
    stat: jest.fn(async () => ({ size: 4, mtime: 1 })),
    list: jest.fn(async () => ({ files: [oldPath], folders: [] })),
  };
  const stateDB = {
    getAllFiles: () => [tracked], getAllDirs: () => [],
    getFile: (path: string) => path === oldPath ? tracked : undefined,
    getFileByRemoteId: (): FileState | undefined => tracked,
    getSyncToken: () => token ? 'token-1' : null,
    setSyncToken: jest.fn(), setRemoteRootEtag: jest.fn(), getRootListingGeneration: () => 0,
    setFile: jest.fn(), deleteFile: jest.fn(),
    setLastSyncTime: jest.fn(), countConflicted: () => 0,
  };
  const client = {
    getFiles: jest.fn(async () => [remote]),
    getDirectories: jest.fn(async () => []),
    getSyncToken: jest.fn(async () => token ? 'token-2' : null),
    getChanges: jest.fn(async () => ({ modified: [remote], deleted: [oldPath], newSyncToken: 'token-2' })),
    deleteFile: jest.fn(),
  };
  const engine = new SyncEngine({
    app: { vault: { adapter: localAdapter }, fileManager: { trashFile: jest.fn() } },
    localAdapter, stateDB, settings: { ...DEFAULT_SETTINGS, deviceId: 'test' },
    statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn() },
    webdavFactory: {}, pluginDir: '.obsidian/plugins/test', configDir: '.obsidian',
  } as never);
  const inner = engine as unknown as {
    client: unknown;
    initialSync(summary: SyncSessionSummary): Promise<void>;
    incrementalSync(summary: SyncSessionSummary): Promise<void>;
    scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>>;
    preparePluginSession(): Promise<void>;
    obtainFullScanListing(): Promise<unknown>;
    processFileWithRetry(): Promise<void>;
    processRemoteDeletion(path: string, summary: SyncSessionSummary): Promise<void>;
    isSystemExcluded(path: string): boolean;
    ensureClient(): Promise<void>;
    invalidateRootEtagOnScopeChange(): void;
    persistAfterSession(): Promise<void>;
    drainWatchPending(): Promise<void>;
    executePlan(): Promise<void>;
  };
  inner.client = client;
  jest.spyOn(inner, 'scanLocalFiles').mockResolvedValue(new Map([[oldPath, { size: 4, mtime: 1 }]]));
  jest.spyOn(inner, 'preparePluginSession').mockResolvedValue(undefined);
  jest.spyOn(inner, 'obtainFullScanListing').mockResolvedValue({ remoteFiles: [remote], cachedDirs: [], rootEtag: 'root' });
  const processFile = jest.spyOn(inner, 'processFileWithRetry').mockResolvedValue(undefined);
  const executePlan = jest.spyOn(inner, 'executePlan').mockResolvedValue(undefined);
  const summary: SyncSessionSummary = {
    startedAt: 1, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, errors: [], retriedFiles: [],
    pluginsNeedingRestart: [], oversizeSkippedPaths: new Set(),
  };
  return { engine, inner, localAdapter, stateDB, client, processFile, executePlan, summary };
}

it.each(['initial', 'full', 'token'] as const)('checks local path identity before %s mutations', async mode => {
  const h = harness(mode === 'token');
  const run = () => mode === 'initial' ? h.inner.initialSync(h.summary) : h.inner.incrementalSync(h.summary);
  await expect(run()).rejects.toThrow('Sync stopped before changing files');
  await expect(run()).rejects.toThrow('Sync stopped before changing files');
  expect(h.processFile).not.toHaveBeenCalled();
  expect(h.executePlan).not.toHaveBeenCalled();
  expect(h.client.deleteFile).not.toHaveBeenCalled();
  expect(h.stateDB.setFile).not.toHaveBeenCalled();
  expect(h.stateDB.deleteFile).not.toHaveBeenCalled();
  expect(h.stateDB.setSyncToken).toHaveBeenLastCalledWith(null);
});

it('reconciles a token-reported rename through the full listing instead of rebasing State alone', async () => {
  const h = harness(true);
  await expect(h.inner.incrementalSync(h.summary)).rejects.toThrow('Sync stopped');
  expect(h.client.getChanges).toHaveBeenCalledWith('token-1');
  expect(h.inner.obtainFullScanListing).toHaveBeenCalledTimes(1);
  expect(h.stateDB.setRemoteRootEtag).toHaveBeenCalledWith(null);
  expect(h.stateDB.setFile).not.toHaveBeenCalled();
  expect(h.stateDB.deleteFile).not.toHaveBeenCalled();
});

it('prepares the plugin scope before checking paths and before applying token deletions', async () => {
  const h = harness(true);
  let prepared = false;
  jest.spyOn(h.inner, 'preparePluginSession').mockImplementation(async () => { prepared = true; });
  // A listed bundle is excluded until its session has been prepared.
  jest.spyOn(h.inner, 'isSystemExcluded').mockImplementation(() => !prepared);
  jest.spyOn(h.stateDB, 'getFileByRemoteId').mockReturnValue(undefined);
  const deleted = jest.spyOn(h.inner, 'processRemoteDeletion').mockResolvedValue(undefined);
  await expect(h.inner.incrementalSync(h.summary)).rejects.toThrow('Sync stopped');
  expect(prepared).toBe(true);
  expect(deleted).not.toHaveBeenCalled();
  expect(h.processFile).not.toHaveBeenCalled();
  expect(h.inner.scanLocalFiles).toHaveBeenCalledTimes(1);
  expect(h.stateDB.setSyncToken).toHaveBeenLastCalledWith(null);
});

it('does not drain queued watch edits after a public sync stops for manual naming repair', async () => {
  const h = harness();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(h.inner, 'ensureClient').mockResolvedValue(undefined);
  jest.spyOn(h.inner, 'invalidateRootEtagOnScopeChange').mockImplementation(() => undefined);
  jest.spyOn(h.inner, 'persistAfterSession').mockResolvedValue(undefined);
  jest.spyOn(h.inner, 'incrementalSync').mockImplementation(async () => {
    await h.engine.syncSingleFile(oldPath); // Queued because the full run is active.
    throw new LocalPathIdentityError('Match the local filename to the server.');
  });
  const drain = jest.spyOn(h.inner, 'drainWatchPending').mockResolvedValue(undefined);
  try {
    await h.engine.syncManual({ manual: true });
    expect(drain).not.toHaveBeenCalled();
    expect(h.engine.getLastSessionSummary()?.errorCount).toBe(1);
    expect(h.stateDB.setSyncToken).toHaveBeenLastCalledWith(null);
    expect(h.stateDB.setRemoteRootEtag).toHaveBeenLastCalledWith(null);
  } finally { jest.restoreAllMocks(); }
});

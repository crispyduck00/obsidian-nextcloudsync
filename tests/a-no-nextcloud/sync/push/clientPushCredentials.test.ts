import type { IWebDAVClient, RemoteRootInfo } from '../../../../src/network/IWebDAVClient';
import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../../src/types';

function makeEngine() {
  let password: string | null = 'first-password';
  const settings = { ...DEFAULT_SETTINGS, useClientPush: true };
  const getRootInfo = jest.fn(async (): Promise<RemoteRootInfo> => ({ etag: 'root-etag', fileId: 'root-id' }));
  const client: Pick<IWebDAVClient, 'onTeamMountListing' | 'getRootInfo'> = { getRootInfo };
  const createClient = jest.fn(async () => ({ client, features: { isNextcloud: true } }));
  const onTeamMountDiscovered = jest.fn();
  const stateDB = { getSyncToken: jest.fn((): string | null => null), getRemoteRootEtag: jest.fn((): string | null => 'root-etag'), getFileByRemoteId: jest.fn() };
  const engine = new SyncEngine({
    app: {}, settings, localAdapter: {}, stateDB, onTeamMountDiscovered, configDir: '.obsidian',
    statusBar: {}, webdavFactory: { createClient }, readAppPassword: () => password,
  } as never);
  const connect = () => (engine as unknown as { ensureClient(): Promise<unknown> }).ensureClient();
  return { engine, connect, client, settings, getRootInfo, createClient, stateDB, onTeamMountDiscovered, setPassword: (value: string | null) => { password = value; } };
}

test.each(['rotated-password', null])('a changed secret (%p) bypasses the Push scope optimization until reconnect', async (password) => {
  const { engine, connect, getRootInfo, stateDB, setPassword } = makeEngine();
  await connect();
  await expect(engine.shouldReconcileClientPush()).resolves.toEqual({ kind: 'ignore' });

  setPassword(password);
  await expect(engine.shouldReconcileClientPush()).resolves.toEqual({ kind: 'full-sync' });
  await expect(engine.reconcileRemoteFileIds({ fileIds: ['note-id'], rootFileId: 'root-id' })).resolves.toBe('full-sync');
  expect(getRootInfo).toHaveBeenCalledTimes(1);
  expect(stateDB.getFileByRemoteId).not.toHaveBeenCalled();
});

test('a root response that arrives during a password change does not suppress reconciliation', async () => {
  const { engine, connect, getRootInfo, createClient, setPassword } = makeEngine();
  await connect();
  getRootInfo.mockImplementationOnce(async () => {
    setPassword('rotated-password');
    return { etag: 'root-etag', fileId: 'root-id' };
  });

  await expect(engine.shouldReconcileClientPush()).resolves.toEqual({ kind: 'full-sync' });
  await connect();
  expect(createClient).toHaveBeenCalledTimes(2);

  getRootInfo.mockResolvedValueOnce({ etag: 'new-etag', fileId: 'root-id' });
  await expect(engine.shouldReconcileClientPush()).resolves.toEqual({
    kind: 'targeted', rootEtag: 'new-etag', rootFileId: 'root-id',
  });
});

describe('silent Team Folder probes', () => {
  const original = { etag: 'root-etag', fileId: 'root-id' };
  const changed = { ...original, etag: 'changed' };

  test('the initial listing supplies its own root baseline, without advancing the normal push cache', async () => {
    const { engine, client, connect, getRootInfo, stateDB, onTeamMountDiscovered } = makeEngine();
    stateDB.getRemoteRootEtag.mockReturnValue(null);
    await connect();
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    expect(getRootInfo).not.toHaveBeenCalled();

    client.onTeamMountListing!(original, new Map([['', 'root-id']]));
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    getRootInfo.mockResolvedValue(changed);
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({
      kind: 'targeted', rootFileId: 'root-id', rootEtag: 'changed',
    });
    await expect(engine.shouldReconcileClientPush()).resolves.toEqual({ kind: 'full-sync' });
    expect(getRootInfo).toHaveBeenCalledTimes(2);
    expect(onTeamMountDiscovered).toHaveBeenCalledTimes(1);
  });

  test.each(['renamed', 'removed', 'disabled', 'stopped'])('begins the window after a long full sync if the mount is still eligible (%s)', async (outcome) => {
    const { engine, client, connect, onTeamMountDiscovered, settings } = makeEngine();
    await connect();
    let finish!: (result: boolean) => void;
    const run = new Promise<boolean>(resolve => { finish = resolve; });
    jest.spyOn(engine as unknown as { runSyncSession(): Promise<boolean> }, 'runSyncSession').mockReturnValue(run);
    const complete = engine.syncForClientPush();
    client.onTeamMountListing!(original, new Map([['Team', '42']]));
    client.onTeamMountListing!(original, outcome === 'removed' ? new Map() : new Map([['Renamed', '42']]));
    if (outcome === 'disabled') settings.useClientPush = false;
    if (outcome === 'stopped') engine.requestStop();
    expect(onTeamMountDiscovered).not.toHaveBeenCalled();
    finish(true);
    await complete;
    expect(onTeamMountDiscovered).toHaveBeenCalledTimes(outcome === 'renamed' ? 1 : 0);
  });

  test.each([false, true])('a cancelled mirror preview lets a later full sync discover the mount (already seen: %s)', async (alreadySeen) => {
    const { engine, client, connect, getRootInfo, onTeamMountDiscovered } = makeEngine();
    await connect();
    const mounts = new Map([['Team', '42']]);
    if (alreadySeen) client.onTeamMountListing!(original, mounts);
    onTeamMountDiscovered.mockClear();
    await engine.abortAndWait(); // the mirror dialog does this before obtaining its preview listing
    client.onTeamMountListing!(original, mounts);
    expect(onTeamMountDiscovered).not.toHaveBeenCalled();
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    expect(getRootInfo).not.toHaveBeenCalled();

    let finish!: (result: boolean) => void;
    const run = new Promise<boolean>(resolve => { finish = resolve; });
    jest.spyOn(engine as unknown as { runSyncSession(): Promise<boolean> }, 'runSyncSession').mockReturnValue(run);
    const complete = engine.syncForClientPush();
    client.onTeamMountListing!(original, mounts);
    finish(true);
    await complete;
    expect(onTeamMountDiscovered).toHaveBeenCalledTimes(1);
  });

  test('only newly visible, included mount IDs start a window, even when the exclusion changes live', async () => {
    const { engine, client, connect, getRootInfo, onTeamMountDiscovered, settings } = makeEngine();
    const mounts = new Map([['Projects/Team', '42']]);
    settings.excludedFolders = ['Projects'];
    await connect();
    client.onTeamMountListing!(original, mounts);
    expect(onTeamMountDiscovered).not.toHaveBeenCalled();
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    expect(getRootInfo).not.toHaveBeenCalled();

    settings.excludedFolders = [];
    client.onTeamMountListing!(original, mounts);
    client.onTeamMountListing!(original, new Map([['RenamedTeam', '42']]));
    expect(onTeamMountDiscovered).toHaveBeenCalledTimes(1);
    client.onTeamMountListing!(original, new Map());
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    expect(getRootInfo).not.toHaveBeenCalled();
    client.onTeamMountListing!(original, mounts);
    expect(onTeamMountDiscovered).toHaveBeenCalledTimes(2);
  });

  test('an unreadable, replaced, or in-flight stale root cannot trigger a speculative sync', async () => {
    const { engine, client, connect, getRootInfo, setPassword, settings, stateDB } = makeEngine();
    await connect();
    const mounts = new Map([['Team', '42']]);
    client.onTeamMountListing!(original, mounts);

    getRootInfo.mockResolvedValueOnce({ etag: null, fileId: null })
      .mockResolvedValueOnce({ ...changed, fileId: 'replacement' })
      .mockImplementationOnce(async () => { settings.maxFileSizeMB++; return changed; });
    for (let i = 0; i < 3; i++) {
      await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    }
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    settings.maxFileSizeMB--;
    settings.username = 'another-account';
    client.onTeamMountListing!(original, mounts);
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    settings.username = DEFAULT_SETTINGS.username;
    stateDB.getSyncToken.mockReturnValueOnce('token');
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    setPassword('rotated-password');
    await expect(engine.shouldReconcileClientPush(true)).resolves.toEqual({ kind: 'ignore' });
    expect(getRootInfo).toHaveBeenCalledTimes(3);
  });
});

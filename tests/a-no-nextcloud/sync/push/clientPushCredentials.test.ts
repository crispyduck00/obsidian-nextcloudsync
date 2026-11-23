import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../../src/types';

function makeEngine(renames: { fileId: string; scope: string }[] = []) {
  let password: string | null = 'first-password';
  const getRootInfo = jest.fn(async () => ({ etag: 'root-etag', fileId: 'root-id' }));
  const createClient = jest.fn(async () => ({ client: { getRootInfo }, features: { isNextcloud: true } }));
  const stateDB = { getSyncToken: () => null, getRemoteRootEtag: () => 'root-etag', getFileByRemoteId: jest.fn(),
    getPendingFileRenames: () => renames };
  const engine = new SyncEngine({
    app: {}, settings: DEFAULT_SETTINGS, localAdapter: {}, stateDB, configDir: '.obsidian',
    statusBar: {}, webdavFactory: { createClient }, readAppPassword: () => password,
  } as never);
  const connect = () => (engine as unknown as { ensureClient(): Promise<unknown> }).ensureClient();
  return { engine, connect, getRootInfo, createClient, stateDB, setPassword: (value: string | null) => { password = value; } };
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


test('a push for a pending rename retries through full sync even with an unchanged vault root', async () => {
  const scope = JSON.stringify([DEFAULT_SETTINGS.serverUrl, DEFAULT_SETTINGS.username, undefined]);
  const { engine, connect, getRootInfo } = makeEngine([{ fileId: 'note-id', scope }]);
  await connect();
  await expect(engine.shouldReconcileClientPush(['elsewhere'])).resolves.toEqual({ kind: 'ignore' });
  await expect(engine.shouldReconcileClientPush(['note-id'])).resolves.toEqual({ kind: 'full-sync' });
  expect(getRootInfo).toHaveBeenCalledTimes(1);
});

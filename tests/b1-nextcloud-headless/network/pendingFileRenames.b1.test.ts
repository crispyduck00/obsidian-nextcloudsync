import { describeLive, requireUser2, type LiveEnv } from '../support/env';
import { authHeaderOf } from '../support/clientFactory';
import { textBuf, decodeBuf } from '../support/helpers';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace } from '../support/isolation';
import { makeDevice, restartDevice } from '../support/engineDevice';
import { NetworkError } from '../../../src/types';

const oldPath = 'Old.md';
const newPath = 'New.md';

async function writableShare(env: LiveEnv, withVersions = false) {
  const user = requireUser2(env);
  const peer = { ...env, serverUrl: user.serverUrl, username: user.username, appPassword: user.password };
  const { ws, client: owner } = await setupWorkspace(env);
  try {
    if (withVersions) {
      await owner.uploadFile(oldPath, textBuf('earlier revision\n'));
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    await owner.uploadFile(oldPath, textBuf('original\n'));
    const endpoint = new URL('/ocs/v2.php/apps/files_sharing/api/v1/shares', env.serverUrl).toString();
    const headers = { Authorization: authHeaderOf(env), 'OCS-APIRequest': 'true', Accept: 'application/json' };
    const response = await fetch(endpoint, {
      method: 'POST', headers,
      body: new URLSearchParams({ path: '/' + ws.remoteBase, shareType: '0', shareWith: peer.username, permissions: '31' }),
    });
    const json = await response.json() as { ocs: { meta: { statuscode: number }; data: { id: number } } };
    expect(json.ocs.meta.statuscode).toBe(200);
    const device = makeDevice(peer, ws.name, 'pending-file-rename');
    await device.sync();
    expect(device.vault.readLocal(oldPath)).toBe('original\n');

    const setPermissions = async (permissions: string): Promise<void> => {
      const change = await fetch(endpoint + '/' + json.ocs.data.id, {
        method: 'PUT', headers, body: new URLSearchParams({ permissions }),
      });
      const result = await change.json() as { ocs: { meta: { statuscode: number } } };
      expect(result.ocs.meta.statuscode).toBe(200);
    };
    return { ws, owner, peer, device, setPermissions };
  } catch (err) {
    await cleanupWorkspace(owner, ws);
    throw err;
  }
}

describeLive('Persistent file renames on Nextcloud', getEnv => {
  it.each(['Watch', 'full scan without event'])('holds both paths through a foreign lock in %s', async mode => {
    const { owner, ws, peer, device: d } = await writableShare(getEnv(), mode === 'Watch');
    let token: string | null = null;
    try {
      expect((await owner.connect()).hasFilesLocking).toBe(true);
      const originalId = (await owner.statFile(oldPath))?.fileId;
      expect(originalId).toBeTruthy();
      const versions = mode === 'Watch' ? await owner.listVersions(originalId!) : [];
      const prior = versions.at(-1);
      if (mode === 'Watch') {
        expect(prior).toBeDefined();
        expect(decodeBuf(await owner.getVersionContent(prior!, originalId!))).toBe('earlier revision\n');
      }
      token = await owner.lockFile(oldPath);
      await d.vault.adapter.rename(oldPath, newPath);
      if (mode === 'Watch') {
        await d.engine.renameSingleFile(oldPath, newPath);
        await d.engine.syncSingleFile(newPath);
      }
      await d.sync();
      expect(d.engine.getStatusReport().pendingFileRenames).toEqual([
        expect.objectContaining({ source: oldPath, destination: newPath, issue: 'locked' }),
      ]);
      expect(d.engine.getLastSessionSummary()).toMatchObject({ uploadedCount: 0, deletedCount: 0, errorCount: 1 });
      expect(await owner.remoteExists(newPath)).toBe(false);
      expect((await owner.statFile(oldPath))?.fileId).toBe(originalId);

      const restarted = await restartDevice(peer, ws.name, d);
      expect(restarted.engine.getStatusReport().pendingFileRenames?.[0].issue).toBe('locked');
      restarted.vault.seedLocal(newPath, 'local edit during the lock\n');
      await restarted.sync();
      expect(await owner.remoteExists(newPath)).toBe(false);
      expect(restarted.vault.readLocal(newPath)).toBe('local edit during the lock\n');

      await owner.unlockFile(oldPath, token);
      token = null;
      await restarted.sync();
      expect(await owner.statFile(oldPath)).toBeNull();
      expect((await owner.statFile(newPath))?.fileId).toBe(originalId);
      expect(decodeBuf(await owner.downloadFile(newPath))).toBe('local edit during the lock\n');
      if (prior) expect(decodeBuf(await owner.getVersionContent(prior, originalId!))).toBe('earlier revision\n');
      expect(restarted.engine.getStatusReport().pendingFileRenames).toEqual([]);
    } finally {
      if (token) await owner.unlockFile(oldPath, token);
      await cleanupWorkspace(owner, ws);
    }
  });

  it('reads other files while access is read-only and moves the original when write access returns', async () => {
    const { owner, ws, device: d, setPermissions } = await writableShare(getEnv());
    try {
      const originalId = (await owner.statFile(oldPath))?.fileId;
      await setPermissions('1');
      await owner.uploadFile('Other.md', textBuf('readable during the hold'));
      await d.vault.adapter.rename(oldPath, newPath);
      d.engine.rememberFileRename(oldPath, newPath);
      await d.sync();
      expect(d.engine.getStatusReport().pendingFileRenames?.[0].issue).toBe('read-only');
      expect(d.vault.readLocal('Other.md')).toBe('readable during the hold');
      expect(await owner.remoteExists(newPath)).toBe(false);
      expect((await owner.statFile(oldPath))?.fileId).toBe(originalId);

      await setPermissions('31');
      await d.sync();
      expect(await owner.statFile(oldPath)).toBeNull();
      expect((await owner.statFile(newPath))?.fileId).toBe(originalId);
      expect(d.engine.getStatusReport().pendingFileRenames).toEqual([]);
    } finally {
      await cleanupWorkspace(owner, ws);
    }
  });

  it('recovers a completed MOVE after a lost response and a restart', async () => {
    const { owner, ws, peer, device: d } = await writableShare(getEnv());
    try {
      const old = await owner.statFile(oldPath);
      expect(old?.fileId).toBeTruthy();
      await expect(owner.moveFile(oldPath, newPath, 'definitely-not-the-current-etag')).rejects.toThrow();
      expect((await owner.statFile(oldPath))?.fileId).toBe(old?.fileId);
      expect(await owner.statFile(newPath)).toBeNull();

      const sendMove = d.client.moveFile.bind(d.client);
      jest.spyOn(d.client, 'moveFile').mockImplementationOnce(async (...args) => {
        await sendMove(...args);
        throw new NetworkError(0, '', 'MOVE');
      });
      await d.vault.adapter.rename(oldPath, newPath);
      await d.engine.renameSingleFile(oldPath, newPath);
      expect(await owner.statFile(oldPath)).toBeNull();
      expect((await owner.statFile(newPath))?.fileId).toBe(old?.fileId);

      const restarted = await restartDevice(peer, ws.name, d);
      const move = jest.spyOn(restarted.client, 'moveFile');
      await restarted.sync();
      expect(move).not.toHaveBeenCalled();
      expect(restarted.stateDB.getFile(newPath)?.remoteFileId).toBe(old?.fileId);
      expect(restarted.engine.getStatusReport().pendingFileRenames).toEqual([]);
      expect(restarted.vault.readLocal(newPath)).toBe('original\n');
    } finally {
      await cleanupWorkspace(owner, ws);
    }
  });
});

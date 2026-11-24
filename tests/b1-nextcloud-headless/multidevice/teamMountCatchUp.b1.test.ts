import { PushSyncScheduler } from '../../../src/sync/push/PushSyncScheduler';
import { makeClient } from '../support/clientFactory';
import { makeDevice } from '../support/engineDevice';
import { describeLive, requireUser2 } from '../support/env';
import { textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { recordRequests } from '../support/requestRecorder';
import { setupWorkspace } from '../support/workspace';

// Opt in with a pre-existing test Team Folder at the same relative path for both accounts.
// Account 1 writes a unique child. Account 2 only needs read access. No admin privileges needed.
const mount = process.env.NEXTCLOUD_TEST_TEAM_MOUNT;

async function until(ready: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!ready() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100));
  expect(ready()).toBe(true);
}

describeLive('Team Folder catch-up without a file notification', getEnv => {
  (mount ? it : it.skip)('downloads a peer edit and only checks the root on its next idle probe', async () => {
    const env = getEnv(), peer = requireUser2(env);
    const readerEnv = { ...env, serverUrl: peer.serverUrl, username: peer.username, appPassword: peer.password };
    const teamMount = mount!;
    expect(teamMount.split('/').every(part => part && part !== '.' && part !== '..')).toBe(true);
    const root = await makeClient(env, teamMount).getRootInfo();
    expect(root.fileId).toEqual(expect.any(String));
    expect((await makeClient(readerEnv, teamMount).getRootInfo()).fileId).toBe(root.fileId);

    const { ws, client: writer } = await setupWorkspace({ ...env, syncFolder: teamMount });
    const discovered = jest.fn(() => scheduler.teamMountDiscovered());
    const reader = makeDevice(readerEnv, ws.remoteBase, 'team-reader', { useClientPush: true, onTeamMountDiscovered: discovered });
    const shouldSync = jest.fn(reader.engine.shouldReconcileClientPush.bind(reader.engine));
    const sync = jest.fn(async () => await reader.engine.syncForClientPush() ? 'completed' as const : 'retry' as const);
    const scheduler: PushSyncScheduler = new PushSyncScheduler({
      isSyncRunning: () => reader.engine.isSyncRunning(), canProbeTeamMount: () => true, shouldSync, sync,
    });
    const requests = recordRequests();
    try {
      await writer.uploadFile('Shared.md', textBuf('baseline'));
      await reader.sync();
      expect(reader.vault.readLocal('Shared.md')).toBe('baseline');
      expect(discovered).toHaveBeenCalledTimes(1);
      await writer.uploadFile('Shared.md', textBuf('changed by the writer'));
      requests.clear();
      // No socket, interval, manual sync or call to scheduler.notify() drives the recipient after baseline.
      await until(() => scheduler.getStatus().lastTriggeredSyncAt !== null, 80_000);
      expect(reader.vault.readLocal('Shared.md')).toBe('changed by the writer');
      expect(requests.requests.every(r => ['PROPFIND', 'GET', 'REPORT', 'HEAD'].includes(r.method))).toBe(true);
      expect(sync).toHaveBeenCalledTimes(1);

      requests.clear();
      const probes = shouldSync.mock.calls.length;
      await until(() => shouldSync.mock.calls.length > probes, 70_000);
      await expect(shouldSync.mock.results[probes].value).resolves.toEqual({ kind: 'ignore' });
      expect(shouldSync).toHaveBeenLastCalledWith([], true);
      expect(requests.requests).toEqual([{ method: 'PROPFIND', depth: '0', url: expect.any(String) }]);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(discovered).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
      requests.restore();
      await cleanupWorkspace(writer, ws);
    }
  }, 180_000);
});

import { requestUrl } from 'obsidian';
import { NextcloudPushClient, parseFileNotification, type PushWebSocketLike } from '../../../src/network/push/NextcloudPushClient';
import { PushSyncScheduler } from '../../../src/sync/push/PushSyncScheduler';
import { describeLive } from '../support/env';
import { makeDevice, type Device } from '../support/engineDevice';
import { textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';

async function waitUntil(condition: () => boolean, error: string): Promise<void> {
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(error);
}

function observePush(device: Device) {
  const shouldSync = jest.fn((ids: readonly string[]) => device.engine.shouldReconcileClientPush(ids));
  const verifyRoot = jest.fn((root: { kind: 'targeted'; rootFileId: string | null; rootEtag: string }) => device.engine.verifyClientPushRoot(root));
  const sync = jest.fn(async () => await device.engine.syncForClientPush() ? 'completed' as const : 'retry' as const);
  const targeted = jest.fn(device.engine.reconcileRemoteFileIds.bind(device.engine));
  const scheduler = new PushSyncScheduler({
    isSyncRunning: () => device.engine.isSyncRunning(),
    shouldSync, verifyRoot, reconcileFileIds: targeted, sync,
    debounceMs: 30, fullSyncQuietMs: 100, fullSyncMaxDelayMs: 250,
  });
  return { scheduler, shouldSync, verifyRoot, sync, targeted };
}

describeLive('Client Push vault scope and ETag against Nextcloud', getEnv => {
  it.each(['new file ID', 'generic', 'reconnect'])('preserves a second pending server change after a targeted edit at the same ETag (%s)', async hint => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const device = makeDevice(env, ws.remoteBase, 'split-hints');
    const { scheduler, shouldSync, verifyRoot, targeted, sync } = observePush(device);
    try {
      await writer.uploadFile('Existing.md', textBuf('initial'));
      await device.sync();
      await device.sync(); // Establish the persisted complete listing baseline.
      const baseline = device.stateDB.getRemoteRootEtag();
      expect(baseline).toBeTruthy();

      const firstId = (await writer.statFile('Existing.md'))!.fileId!;
      await writer.uploadFile('Existing.md', textBuf('updated'));
      await writer.uploadFile('Added.md', textBuf('arrived in same server state'));
      const addedId = (await writer.statFile('Added.md'))!.fileId!;
      const changed = await writer.getRootInfo();
      expect(changed.etag).not.toBe(baseline);

      scheduler.notify(parseFileNotification(`notify_file_id ["${firstId}"]`)!);
      await waitUntil(() => device.vault.readLocal('Existing.md') === 'updated' && !scheduler.getStatus().pending, 'targeted edit did not apply');
      expect(targeted).toHaveBeenCalledTimes(1);
      expect(verifyRoot).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(device.stateDB.getRemoteRootEtag()).toBe(baseline);
      expect(device.vault.readLocal('Added.md')).toBeNull();
      expect((await writer.getRootInfo()).etag).toBe(changed.etag);

      if (hint === 'reconnect') scheduler.requestRemoteCatchUp();
      else scheduler.notify(parseFileNotification(hint === 'generic' ? 'notify_file' : `notify_file_id ["${addedId}"]`)!);
      await waitUntil(() => device.vault.readLocal('Added.md') !== null && !device.engine.isSyncRunning(), 'in-vault create was lost after first ID');
      expect(device.vault.readLocal('Added.md')).toBe('arrived in same server state');
      expect(verifyRoot).toHaveBeenCalledWith(expect.objectContaining({ rootEtag: changed.etag }));
      expect(sync).toHaveBeenCalledTimes(1);
      expect(shouldSync.mock.calls.length).toBeGreaterThan(1);
    } finally {
      scheduler.stop();
      await cleanupWorkspace(writer, ws);
    }
  });

  it('proves isolated excluded changes are irrelevant to the included tree after a targeted edit', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const device = makeDevice(env, ws.remoteBase, 'exclude-probe', { excludedFolders: ['Excluded'] });
    const { scheduler, shouldSync, verifyRoot, targeted, sync } = observePush(device);
    try {
      await writer.uploadFile('Existing.md', textBuf('original'));
      await device.sync();
      await device.sync();
      const baseline = device.stateDB.getRemoteRootEtag();
      await writer.uploadFile('Existing.md', textBuf('targeted update'));
      const id = (await writer.statFile('Existing.md'))!.fileId!;
      scheduler.notify(parseFileNotification(`notify_file_id ["${id}"]`)!);
      await waitUntil(() => device.vault.readLocal('Existing.md') === 'targeted update' && !scheduler.getStatus().pending, 'targeted edit did not apply');

      await writer.uploadFile('Excluded/Ignore.md', textBuf('private subfolder'));
      const excludedRoot = await writer.getRootInfo();
      expect(excludedRoot.etag).not.toBe(baseline);
      const excluded = (await writer.statFile('Excluded/Ignore.md'))!.fileId!;
      scheduler.notify(parseFileNotification(`notify_file_id ["${excluded}"]`)!);
      await waitUntil(() => verifyRoot.mock.calls.length > 0, 'excluded change did not go through the root proof');
      await expect(verifyRoot.mock.results[0].value).resolves.toBe(true);
      const root = (await device.engine.shouldReconcileClientPush()).kind;
      expect(root).toBe('ignore');
      expect(device.stateDB.getRemoteRootEtag()).toBe(baseline);
      expect(device.vault.readLocal('Excluded/Ignore.md')).toBeNull();
      expect(sync).not.toHaveBeenCalled();

      const checks = shouldSync.mock.calls.length;
      scheduler.requestRemoteCatchUp();
      await waitUntil(() => shouldSync.mock.calls.length > checks && !scheduler.getStatus().pending, 'catch-up probe did not finish');
      expect(targeted).toHaveBeenCalledTimes(2);
      expect(verifyRoot).toHaveBeenCalledTimes(1);
      expect(sync).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
      await cleanupWorkspace(writer, ws);
    }
  });

  it('receives real account WebSocket hints and skips sibling edits, renames and deletes while syncing vault changes', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const { client: sibling, ws: outside } = await setupWorkspace(env);
    const device = makeDevice(env, ws.remoteBase, 'live-websocket');
    const { scheduler, shouldSync, targeted, sync } = observePush(device);
    const seen: string[] = [];
    const push = new NextcloudPushClient({
      serverUrl: env.serverUrl, username: env.username, readAppPassword: () => env.appPassword,
      networkTimeoutMs: 6_000,
      onFileNotification: (hint) => {
        seen.push(hint.raw);
        scheduler.notify(hint);
      },
    }, {
      request: (params) => requestUrl(params),
      createWebSocket: (url) => new WebSocket(url) as unknown as PushWebSocketLike,
      now: () => Date.now(), isOnline: () => true,
    });

    try {
      await writer.uploadFile('In vault.md', textBuf('original'));
      await sibling.uploadFile('Outside.md', textBuf('initial outside'));
      await device.sync();
      await device.sync();
      const baseline = await writer.getRootInfo();
      const last = device.stateDB.getLastSyncTime();
      await push.start();
      await waitUntil(() => push.getStatus().state === 'connected', 'WebSocket did not authenticate');

      for (const change of [
        () => sibling.uploadFile('Outside.md', textBuf('edited outside')),
        () => sibling.moveFile('Outside.md', 'Renamed outside.md'),
        () => sibling.deleteFile('Renamed outside.md', ''),
        () => sibling.createDirectory('Outside folder'),
        () => sibling.moveFile('Outside folder', 'Moved outside folder'),
        () => sibling.deleteCollection('Moved outside folder'),
      ]) {
        const before = shouldSync.mock.calls.length;
        await change();
        await waitUntil(() => shouldSync.mock.calls.length > before, 'missing sibling notification');
        await expect(shouldSync.mock.results.at(-1)!.value).resolves.toEqual({ kind: 'ignore' });
        expect(await writer.getRootInfo()).toEqual(baseline);
      }
      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(sync).not.toHaveBeenCalled();
      expect(targeted).not.toHaveBeenCalled();
      expect(device.stateDB.getLastSyncTime()).toBe(last);

      await writer.uploadFile('In vault.md', textBuf('edited inside'));
      await waitUntil(() => device.vault.readLocal('In vault.md') === 'edited inside', 'edit in vault was missed');
      await waitUntil(() => !scheduler.getStatus().pending && !device.engine.isSyncRunning(), 'edit did not settle');
      await writer.moveFile('In vault.md', 'Moved inside.md');
      await waitUntil(() => device.vault.readLocal('Moved inside.md') === 'edited inside'
        && device.vault.readLocal('In vault.md') === null, 'rename in vault was missed');
      await waitUntil(() => !scheduler.getStatus().pending && !device.engine.isSyncRunning(), 'rename did not settle');
      await writer.deleteFile('Moved inside.md', '');
      await waitUntil(() => device.vault.readLocal('Moved inside.md') === null, 'delete in vault was missed');
      await waitUntil(() => !scheduler.getStatus().pending && !device.engine.isSyncRunning(), 'delete did not settle');
      await writer.uploadFile('Folder/note.md', textBuf('folder child'));
      await waitUntil(() => device.vault.readLocal('Folder/note.md') === 'folder child', 'folder and file creation were missed');
      await waitUntil(() => !scheduler.getStatus().pending && !device.engine.isSyncRunning(), 'folder create did not settle');
      await writer.moveFile('Folder', 'Moved Folder');
      await waitUntil(() => device.vault.readLocal('Moved Folder/note.md') === 'folder child'
        && !device.vault.folderExists('Folder'), 'folder move was missed');
      await waitUntil(() => !scheduler.getStatus().pending && !device.engine.isSyncRunning(), 'folder move did not settle');
      await writer.deleteCollection('Moved Folder');
      await waitUntil(() => !device.vault.folderExists('Moved Folder'), 'folder removal in vault was missed');
      expect(device.vault.readLocal('Outside.md')).toBeNull();
      expect(device.vault.readLocal('Renamed outside.md')).toBeNull();
    } finally {
      push.stop();
      scheduler.stop();
      await cleanupWorkspace(sibling, outside);
      await cleanupWorkspace(writer, ws);
    }
  }, 100_000);
});

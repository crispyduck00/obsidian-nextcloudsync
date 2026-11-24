import { describeLive } from '../support/env';
import { makeDevice } from '../support/engineDevice';
import { decodeBuf, textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { recordRequests } from '../support/requestRecorder';
import { setupWorkspace } from '../support/workspace';

describeLive('First upload delay on Nextcloud', getEnv => {
  it('keeps a new folder and its renamed template note local during automatic sync', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'first-upload', { newItemDelaySeconds: 60 });
    try {
      await writer.uploadFile('Existing.md', textBuf('baseline'));
      await d.sync();
      await d.engine.syncManual();
      const baselineEtag = d.stateDB.getRemoteRootEtag();
      expect(baselineEtag).toBeTruthy();
      d.vault.seedLocal('Untitled/Untitled.md', '# Untitled\n');
      d.engine.rememberLocalCreation('Untitled', true);
      d.engine.rememberLocalCreation('Untitled/Untitled.md', false);

      d.vault.seedLocal('Project/Untitled.md', '# Untitled\n');
      d.vault.deleteLocalTree('Untitled');
      expect(d.engine.retargetLocalCreation('Untitled', 'Project', true)).toBe(true);
      await d.vault.adapter.rename('Project/Untitled.md', 'Project/Project.md');
      d.vault.seedLocal('Project/Project.md', '# Project\nbody\n');
      expect(d.engine.retargetLocalCreation('Project/Untitled.md', 'Project/Project.md', false)).toBe(true);

      const requests = recordRequests();
      try {
        // Desktop/Android Watch, followed by the normal full-sync fallback used by Push.
        await d.engine.createSingleFolder('Project');
        await d.engine.syncSingleFile('Project/Project.md');
        expect(requests.requests).toEqual([]);
        await expect(d.engine.syncForClientPush()).resolves.toBe(true);
        expect(requests.requests.some(r => r.method === 'PUT' || r.method === 'MKCOL')).toBe(false);
        expect(requests.requests.some(r => r.depth === 'infinity')).toBe(false);
        expect(d.stateDB.getRemoteRootEtag()).toBe(baselineEtag);
      } finally {
        requests.restore();
      }
      expect(await writer.statFolderMovePath('Project')).toBeNull();

      // Explicit Sync now overrides the grace. Neither placeholder name was published.
      await d.sync();
      expect(await writer.statFolderMovePath('Untitled')).toBeNull();
      expect(await writer.statFile('Project/Untitled.md')).toBeNull();
      expect(decodeBuf(await writer.downloadFile('Project/Project.md'))).toBe('# Project\nbody\n');
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });

  it('keeps an established file at its old server path until its new parent is ready', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'first-upload-move', { newItemDelaySeconds: 60 });
    try {
      await writer.uploadFile('Existing.md', textBuf('versioned content'));
      const fileId = (await writer.statFile('Existing.md'))?.fileId;
      await d.sync();

      d.vault.seedFolder('New parent');
      d.engine.rememberLocalCreation('New parent', true);
      await d.vault.adapter.rename('Existing.md', 'New parent/Existing.md');
      await d.engine.renameSingleFile('Existing.md', 'New parent/Existing.md');
      await d.engine.syncManual();
      expect((await writer.statFile('Existing.md'))?.fileId).toBe(fileId);
      expect(await writer.statFolderMovePath('New parent')).toBeNull();
      expect(d.stateDB.getPendingFileRenames()).toHaveLength(1);

      d.settings.newItemDelaySeconds = 0;
      await d.engine.createSingleFolder('New parent');
      await d.engine.retryMovesIntoFolder('New parent');
      expect(await writer.statFile('Existing.md')).toBeNull();
      expect((await writer.statFile('New parent/Existing.md'))?.fileId).toBe(fileId);
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });

  it('rechecks the server after a concurrent creation at a path still waiting for its first upload', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'first-upload-peer', { newItemDelaySeconds: 60 });
    try {
      await writer.uploadFile('Existing.md', textBuf('baseline'));
      await d.sync();
      await d.engine.syncManual();
      d.vault.seedFolder('Shared project');
      d.engine.rememberLocalCreation('Shared project', true);
      await writer.uploadFile('Shared project/Peer.md', textBuf('created on the second device'));

      await d.engine.syncForClientPush();
      expect(d.stateDB.getRemoteRootEtag()).toBeNull();
      expect(await d.vault.adapter.exists('Shared project/Peer.md')).toBe(false);

      d.settings.newItemDelaySeconds = 0;
      await d.engine.syncForClientPush();
      expect(await d.vault.adapter.read('Shared project/Peer.md')).toBe('created on the second device');
      expect(d.stateDB.getFile('Shared project/Peer.md')?.remoteFileId)
        .toBe((await writer.statFile('Shared project/Peer.md'))?.fileId);
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });
});

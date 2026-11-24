import { NetworkError } from '../../../src/types';
import { describeLive } from '../support/env';
import { makeDevice, restartDevice } from '../support/engineDevice';
import { decodeBuf, textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';

function signal() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { release, wait };
}

describeLive('Renames during first uploads', getEnv => {
  it.each(['watch', 'automatic full', 'manual full', 'initial full'])('follows a local rename while the first PUT response is still pending (%s)', async entry => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'initial-put-rename');
    const uploaded = signal();
    const releaseResponse = signal();
    let sync: Promise<void> | undefined;
    try {
      if (entry !== 'initial full') {
        await writer.uploadFile('Anchor.md', textBuf('anchor'));
        await d.sync();
      }
      const oldPath = 'Untitled.md';
      const newPath = 'Project.md';
      d.vault.seedLocal(oldPath, '# Untitled\nbody\n');
      const send = d.client.uploadFile.bind(d.client);
      jest.spyOn(d.client, 'uploadFile').mockImplementationOnce(async (...args) => {
        try {
          await send(...args);
        } finally {
          uploaded.release();
          await releaseResponse.wait;
        }
      });

      sync = entry === 'watch' ? d.engine.syncSingleFile(oldPath)
        : entry === 'manual full' ? d.sync() : d.engine.syncManual();
      await uploaded.wait;
      const originalId = (await writer.statFile(oldPath))?.fileId;
      expect(originalId).toBeTruthy();

      await d.vault.adapter.rename(oldPath, newPath);
      d.vault.seedLocal(newPath, '# Project\nbody\n');
      d.engine.rememberFileRename(oldPath, newPath);
      const renamed = d.engine.syncRememberedFileRename(oldPath, newPath);
      if (entry !== 'watch') await d.engine.syncSingleFile(newPath);
      releaseResponse.release();
      await sync;
      expect(d.engine.getLastSessionSummary()?.errorCount ?? 0).toBe(0);
      await renamed;
      await d.sync();
      expect((await writer.statFile(newPath))?.fileId).toBe(originalId);
      expect(await writer.statFile(oldPath)).toBeNull();
      expect(decodeBuf(await writer.downloadFile(newPath))).toBe('# Project\nbody\n');
    } finally {
      releaseResponse.release();
      await sync?.catch(() => undefined);
      await cleanupWorkspace(writer, ws);
    }
  });

  it('keeps an unacknowledged first upload from becoming a second file after a rename', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'lost-first-put-response');
    const uploaded = signal();
    const dropResponse = signal();
    let upload: Promise<void> | undefined;
    try {
      await writer.uploadFile('Anchor.md', textBuf('anchor'));
      await d.sync();
      d.vault.seedLocal('Draft.md', '# Draft\nbody\n');
      const send = d.client.uploadFile.bind(d.client);
      jest.spyOn(d.client, 'uploadFile').mockImplementationOnce(async (...args) => {
        try {
          await send(...args);
        } finally {
          uploaded.release();
          await dropResponse.wait;
        }
        throw new NetworkError(0, 'response lost after content was stored', 'PUT');
      });
      upload = d.engine.syncSingleFile('Draft.md');
      await uploaded.wait;
      expect(await writer.statFile('Draft.md')).not.toBeNull();
      await d.vault.adapter.rename('Draft.md', 'Renamed.md');
      d.vault.seedLocal('Renamed.md', '# Renamed\nbody\n');
      d.engine.rememberFileRename('Draft.md', 'Renamed.md');
      dropResponse.release();
      await upload;
      await d.engine.flushState();
      const restarted = await restartDevice(env, ws.remoteBase, d);
      await restarted.engine.syncSingleFile('Renamed.md');
      await restarted.engine.syncForClientPush();
      await restarted.sync();
      const paths = (await writer.getFiles('')).map(file => file.path).filter(path => path !== 'Anchor.md');
      expect(paths).toEqual(['Draft.md']);
      expect(restarted.vault.readLocal('Renamed.md')).toBe('# Renamed\nbody\n');
      expect(restarted.vault.readLocal('Draft.md')).toBeNull();
      expect(restarted.engine.getStatusReport().pendingFileRenames).toEqual([
        expect.objectContaining({ source: 'Draft.md', destination: 'Renamed.md', unconfirmedCreate: true }),
      ]);

      // Returning to the original name releases the reservation and uses the ordinary conflict policy.
      await restarted.vault.adapter.rename('Renamed.md', 'Draft.md');
      restarted.engine.rememberFileRename('Renamed.md', 'Draft.md');
      expect(restarted.engine.getStatusReport().pendingFileRenames).toHaveLength(0);
    } finally {
      dropResponse.release();
      await upload?.catch(() => undefined);
      await cleanupWorkspace(writer, ws);
    }
  });

});

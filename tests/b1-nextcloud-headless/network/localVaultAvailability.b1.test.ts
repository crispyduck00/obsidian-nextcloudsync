import { describeLive } from '../support/env';
import { textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { makeDevice } from '../support/engineDevice';
import { setupWorkspace } from '../support/workspace';

describeLive('Local vault availability before remote deletion', getEnv => {
  it.each(['full sync', 'an already running full sync', 'Watch'])('keeps remote notes if the local vault disappears during %s', async mode => {
    const env = getEnv();
    const { ws, client } = await setupWorkspace(env);
    try {
      await client.uploadFile('Root.md', textBuf('synced before losing access'));
      const d = makeDevice(env, ws.name, 'unavailable-local-root');
      await d.sync();
      expect(d.vault.readLocal('Root.md')).toBe('synced before losing access');
      const localStat = jest.spyOn(d.vault.adapter, 'stat').mockResolvedValue(null);
      if (mode === 'an already running full sync') {
        localStat.mockResolvedValueOnce({ type: 'folder', size: 0, mtime: 0, ctime: 0 });
      }
      const localFiles = jest.spyOn(d.vault.vault, 'getFiles').mockReturnValue([]);
      const deleteFromNextcloud = jest.spyOn(d.client, 'deleteFile');
      const remove = mode === 'Watch' ? () => d.engine.deleteSingleFile('Root.md') : d.sync;

      await remove();

      expect(await client.remoteExists('Root.md')).toBe(true);
      expect(d.stateDB.getFile('Root.md')).toBeDefined();
      expect(deleteFromNextcloud).not.toHaveBeenCalled();

      localStat.mockRestore();
      localFiles.mockRestore();
      await d.vault.adapter.remove('Root.md');
      await remove();

      expect(await client.remoteExists('Root.md')).toBe(false);
      expect(deleteFromNextcloud).toHaveBeenCalledTimes(1);
    } finally {
      await cleanupWorkspace(client, ws);
    }
  });
});

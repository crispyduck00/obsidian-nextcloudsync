import { makeDevice } from '../support/engineDevice';
import { describeLive } from '../support/env';
import { decodeBuf, textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';

describeLive('Historical version restore with a concurrent local edit', getEnv => {
  it.each(['preflight', 'download', 'staging'] as const)('preserves a same-size edit made during %s', async phase => {
    const env = getEnv();
    const { ws, client } = await setupWorkspace(env);
    const device = makeDevice(env, ws.remoteBase, 'version-guard-' + phase);
    const path = 'Versioned.md';
    const older = '# Note\nOlder content.\n';
    const latest = '# Note\nNewer content.\n';
    const draft = '# Note\nLocal content.\n';
    const originalMtime = Date.now() - 60 * 60 * 1000;
    try {
      await client.uploadFile(path, textBuf(older), originalMtime);
      await client.uploadFile(path, textBuf(latest), originalMtime + 10000);
      await device.sync();
      const version = (await device.engine.listVersions(path)).find(v => !v.isCurrent && !v.isCurrentRevisionAnchor);
      expect(version).toBeDefined();
      expect(await device.engine.readVersionText(path, version!)).toBe(older);

      const initialStat = await device.vault.adapter.stat(path);
      const initialBase = device.stateDB.getFile(path);
      const edit = async () => device.vault.adapter.write(path, draft, { mtime: initialStat!.mtime });
      const hooks = {
        preflight: () => {
          const stat = device.client.statFile.bind(device.client);
          return jest.spyOn(device.client, 'statFile').mockImplementationOnce(async p => {
            const remote = await stat(p);
            await edit();
            return remote;
          });
        },
        download: () => {
          const download = device.client.downloadFile.bind(device.client);
          return jest.spyOn(device.client, 'downloadFile').mockImplementationOnce(async p => {
            const bytes = await download(p);
            await edit();
            return bytes;
          });
        },
        staging: () => {
          const write = device.vault.adapter.writeBinary.bind(device.vault.adapter);
          return jest.spyOn(device.vault.adapter, 'writeBinary').mockImplementationOnce(async (p, data, options) => {
            await write(p, data, options);
            await edit();
          });
        },
      };
      const hook = hooks[phase]();

      try {
        await expect(device.engine.restoreVersion(path, version!)).rejects.toThrow('the local edit was kept');
        expect(device.vault.readLocal(path)).toBe(draft);
        expect(decodeBuf(await client.downloadFile(path))).toBe(older);
        expect(device.stateDB.getFile(path)?.localHash).toBe(initialBase?.localHash);
        expect(device.stateDB.getFile(path)?.localMtime).toBeUndefined();
      } finally { hook.mockRestore(); }
    } finally {
      device.localAdapter.dispose();
      await cleanupWorkspace(client, ws);
    }
  });
});

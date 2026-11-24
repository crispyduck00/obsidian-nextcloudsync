import { NetworkError } from '../../../src/types';
import { describeLive } from '../support/env';
import { makeDevice, restartDevice, type Device } from '../support/engineDevice';
import { decodeBuf, textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';

const root = 'Tree';
const nested = 'Tree/Nested';
const edited = 'Tree/Nested/Edited.md';
const stable = 'Tree/Nested/Stable.md';
const added = 'Tree/Nested/Added.md';
const replaced = 'Tree/Replaced.md';

// Model the per-directory queues restoring a sibling before the files in the missing child are processed.
function waitForParentRestore(device: Device, restorePath = replaced, afterRestore?: () => void): () => void {
  const stat = device.vault.adapter.stat.bind(device.vault.adapter);
  let notified = false;
  const mock = jest.spyOn(device.vault.adapter, 'stat').mockImplementation(async path => {
    if ([edited, stable, added].includes(path)) {
      const deadline = Date.now() + 7000;
      while (device.vault.readLocal(restorePath) === null && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      if (device.vault.readLocal(restorePath) === null) throw new Error('The sibling did not restore the parent.');
      if (!notified) {
        notified = true;
        afterRestore?.();
      }
    }
    return stat(path);
  });
  return () => mock.mockRestore();
}

// The headless vault has no event bus, so deliver the same folder-create handling as the plugin.
function emitFolderCreates(device: Device): () => void {
  const mkdir = device.vault.adapter.mkdir.bind(device.vault.adapter);
  const mock = jest.spyOn(device.vault.adapter, 'mkdir').mockImplementation(async path => {
    const parts = path.split('/');
    const missing = parts.map((_, index) => parts.slice(0, index + 1).join('/'))
      .filter(parent => !device.vault.folderExists(parent));
    await mkdir(path);
    for (const parent of missing) {
      if (!device.localAdapter.shouldIgnore(parent)) device.engine.forgetFolderDeletion(parent);
    }
  });
  return () => mock.mockRestore();
}

describeLive('Observed local directory deletion with concurrent Nextcloud changes', getEnv => {
  it.each([
    'existing edit only', 'plus new peer child', 'observed nested delete', 'remote read interrupted', 'ancestor created by a deeper download',
    'new local draft during restore',
  ])('reconciles the observed tree deletion with %s', async mode => {
    const env = getEnv();
    const { client, ws } = await setupWorkspace(env);
    const device = makeDevice(env, ws.remoteBase, 'observed-delete');
    const restorePath = mode === 'ancestor created by a deeper download' ? 'Tree/Sibling/Deep/Replaced.md' : replaced;
    try {
      await client.uploadFile('Keeper.md', textBuf('outside the deleted tree'));
      await client.uploadFile(edited, textBuf('original'));
      await client.uploadFile(stable, textBuf('unchanged'));
      await client.uploadFile(restorePath, textBuf('original identity'));
      await device.sync();
      expect(device.vault.readLocal(edited)).toBe('original');
      const prior = (await client.statFile(restorePath))?.fileId;
      const nestedId = (await client.statFolderMovePath(nested))?.directoryId;
      expect(nestedId).toBeTruthy();

      device.vault.deleteLocalTree(root);
      device.engine.rememberFolderDeletion(root);
      if (mode === 'observed nested delete') device.engine.rememberFolderDeletion(nested);
      await client.uploadFile(edited, textBuf('peer edit'));
      if (mode === 'plus new peer child') await client.uploadFile(added, textBuf('new peer child'));
      await client.deleteFile(restorePath, '');
      await client.uploadFile(restorePath, textBuf('original identity'));
      const replacement = (await client.statFile(restorePath))?.fileId;
      expect(replacement).toBeTruthy();
      expect(replacement).not.toBe(prior);
      const restoreStat = waitForParentRestore(device, restorePath);
      const restoreMkdir = emitFolderCreates(device);
      const sendDownload = device.client.downloadFile.bind(device.client);
      let interrupt = mode === 'remote read interrupted';
      const downloads = jest.spyOn(device.client, 'downloadFile').mockImplementation(async path => {
        if (interrupt && path === edited) {
          interrupt = false;
          throw new NetworkError(503, '', 'GET');
        }
        const data = await sendDownload(path);
        if (mode === 'new local draft during restore' && path === edited) {
          device.vault.seedLocal(edited, 'new local draft');
        }
        return data;
      });
      const deleteCollection = jest.spyOn(device.client, 'deleteCollection');
      try {
        await device.sync();
      } finally {
        restoreStat();
        restoreMkdir();
        downloads.mockRestore();
      }

      if (mode === 'remote read interrupted') {
        expect(device.vault.readLocal(edited)).toBeNull();
        expect(decodeBuf(await client.downloadFile(edited))).toBe('peer edit');
        expect(device.engine.getLastSessionSummary()?.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: edited }),
        ]));
        await device.sync();
      }

      if (mode === 'new local draft during restore') {
        expect(device.vault.readLocal(edited)).toBe('new local draft');
        expect(decodeBuf(await client.downloadFile(edited))).toBe('peer edit');
        expect(device.engine.getStatusReport().retryFiles).toEqual([edited]);
        expect(await client.statFile(stable)).toBeNull();
        expect(deleteCollection).not.toHaveBeenCalled();
        return;
      }

      // The edited child must already be present after reconciliation, without needing a new file
      // to happen to recreate the missing subfolder on the next run.
      expect(device.vault.readLocal(edited)).toBe('peer edit');
      expect(decodeBuf(await client.downloadFile(edited))).toBe('peer edit');
      expect(await client.statFile(stable)).toBeNull();
      expect((await client.statFolderMovePath(nested))?.directoryId).toBe(nestedId);
      expect((await client.statFile(restorePath))?.fileId).toBe(replacement);
      expect(device.vault.readLocal(restorePath)).toBe('original identity');
      if (mode === 'plus new peer child') expect(device.vault.readLocal(added)).toBe('new peer child');
      expect(deleteCollection).not.toHaveBeenCalled();
      expect(device.engine.getLastSessionSummary()?.errors).toEqual([]);

      await device.sync();
      expect(device.vault.readLocal(edited)).toBe('peer edit');
      expect(await client.statFile(stable)).toBeNull();
      expect(device.engine.getLastSessionSummary()?.errors).toEqual([]);
    } finally {
      await cleanupWorkspace(client, ws);
    }
  });

  it.each(['ancestor restored by user', 'nested collection replaced', 'engine restarted'])(
    'keeps an unproven subtree when %s', async mode => {
      const env = getEnv();
      const { client, ws } = await setupWorkspace(env);
      const device = makeDevice(env, ws.remoteBase, 'protect-missing-child');
      try {
        await client.uploadFile(edited, textBuf('original'));
        await client.uploadFile(stable, textBuf('unchanged'));
        await client.uploadFile(replaced, textBuf('original identity'));
        await device.sync();
        const priorDir = (await client.statFolderMovePath(nested))?.directoryId;
        device.vault.deleteLocalTree(root);
        device.engine.rememberFolderDeletion(root);

        if (mode === 'nested collection replaced') {
          await client.deleteCollection(nested);
          await client.uploadFile(edited, textBuf('published into replacement subtree'));
          await client.uploadFile(stable, textBuf('unchanged'));
          expect((await client.statFolderMovePath(nested))?.directoryId).not.toBe(priorDir);
        }
        await client.deleteFile(replaced, '');
        await client.uploadFile(replaced, textBuf('replacement sibling'));
        await device.engine.flushState();
        const active = mode === 'engine restarted' ? await restartDevice(env, ws.remoteBase, device) : device;
        const remoteDelete = jest.spyOn(active.client, 'deleteFile');
        const restoreStat = mode === 'ancestor restored by user'
          ? waitForParentRestore(active, replaced, () => {
            active.engine.forgetFolderDeletion(root);
            active.vault.seedLocal('Tree/Restored locally.md', 'new local work');
          })
          : undefined;
        try {
          await active.sync();
        } finally {
          restoreStat?.();
        }

        expect(remoteDelete).not.toHaveBeenCalled();
        expect(decodeBuf(await client.downloadFile(stable))).toBe('unchanged');
        expect(decodeBuf(await client.downloadFile(edited))).toBe(
          mode === 'nested collection replaced' ? 'published into replacement subtree' : 'original',
        );
        if (mode === 'ancestor restored by user') {
          expect(active.vault.readLocal('Tree/Restored locally.md')).toBe('new local work');
        }
      } finally {
        await cleanupWorkspace(client, ws);
      }
    },
  );
});

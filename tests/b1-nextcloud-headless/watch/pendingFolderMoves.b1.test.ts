import { NetworkError } from '../../../src/types';
import { describeLive, requireUser2 } from '../support/env';
import { makeDevice, restartDevice, type Device } from '../support/engineDevice';
import { decodeBuf, textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { shareWithUser } from '../support/share';
import { setupWorkspace } from '../support/workspace';

async function moveLocally(device: Device, source: string, destination: string): Promise<void> {
  async function moveEntries(from: string, to: string): Promise<void> {
    const entries = await device.vault.adapter.list(from);
    device.vault.seedFolder(to);
    for (const file of entries.files) await device.vault.adapter.rename(file, to + file.slice(from.length));
    for (const folder of entries.folders) await moveEntries(folder, to + folder.slice(from.length));
  }
  await moveEntries(source, destination);
  device.vault.deleteLocalTree(source);
  device.engine.rememberFolderRename(source, destination);
}

// The guarded-folder topic supplies this optional observation in the combined build.
function forgetFolderDeletion(device: Device, path: string): void {
  const engine = device.engine as Device['engine'] & { forgetFolderDeletion?(path: string): void };
  engine.forgetFolderDeletion?.(path);
}

describeLive('Persistent folder moves against Nextcloud', getEnv => {
  it('applies a nested folder move observed after this scan has already visited its files', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const from = 'Project', to = 'Archive/Project';
    try {
      await writer.uploadFile(from + '/Project.md', textBuf('project note'));
      await writer.uploadFile(from + '/Sub/attachment.bin', textBuf('attachment'));
      await writer.uploadFile('zz-last.md', textBuf('last'));
      await writer.createDirectory('Archive');
      const rootId = (await writer.statFolderMovePath(from))?.directoryId;
      const noteId = (await writer.statFile(from + '/Project.md'))?.fileId;
      const attachmentId = (await writer.statFile(from + '/Sub/attachment.bin'))?.fileId;
      expect([rootId, noteId, attachmentId]).toEqual([expect.any(String), expect.any(String), expect.any(String)]);

      const device = makeDevice(env, ws.remoteBase, 'late-folder-move', { networkConcurrency: 1 });
      await device.sync();
      const list = device.client.getFiles.bind(device.client);
      jest.spyOn(device.client, 'getFiles').mockImplementation(async path =>
        [...await list(path)].sort((a, b) => a.path.localeCompare(b.path)));
      let pause!: () => void, resume!: () => void;
      const reached = new Promise<void>(resolve => { pause = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const stat = device.localAdapter.stat.bind(device.localAdapter);
      const visited = new Set<string>();
      let held = false;
      jest.spyOn(device.localAdapter, 'stat').mockImplementation(async path => {
        if (!held && path === 'zz-last.md') {
          held = true;
          pause();
          await gate;
        }
        visited.add(path);
        return stat(path);
      });
      device.stateDB.setRemoteRootEtag(null);
      const sync = device.engine.syncManual({ manual: true });
      try {
        // A completed scan must also release the test if the expected synchronization point disappears.
        await Promise.race([reached, sync]);
        expect(held).toBe(true);
        expect(visited.has(from + '/Project.md')).toBe(true);
        expect(visited.has(from + '/Sub/attachment.bin')).toBe(true);
        await moveLocally(device, from, to);
        await device.engine.renameSingleFolder(from, to);
      } finally {
        resume();
        await sync;
      }
      // The separate activity-coordination topic replays deferred Watch structure immediately.
      // This standalone topic proves the durable intent on the next ordinary sync.
      await device.sync();
      expect(await writer.statFolderMovePath(from)).toBeNull();
      expect((await writer.statFolderMovePath(to))?.directoryId).toBe(rootId);
      expect((await writer.statFile(to + '/Project.md'))?.fileId).toBe(noteId);
      expect((await writer.statFile(to + '/Sub/attachment.bin'))?.fileId).toBe(attachmentId);
      expect(decodeBuf(await writer.downloadFile(to + '/Sub/attachment.bin'))).toBe('attachment');
      expect(device.engine.getStatusReport().pendingFolderMoves).toEqual([]);
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });

  it('retains the Nextcloud file ID for a heading-driven rename of a freshly downloaded note', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    try {
      await writer.uploadFile('Downloaded.md', textBuf('# Downloaded\nbody\n'));
      const originalId = (await writer.statFile('Downloaded.md'))?.fileId;
      expect(originalId).toBeTruthy();
      const device = makeDevice(env, ws.remoteBase, 'recent-download-rename');
      await device.sync();
      await device.vault.adapter.rename('Downloaded.md', 'New heading.md');
      device.vault.seedLocal('New heading.md', '# New heading\nbody\n');
      // The host must record this event even while the old path is in its own-write window.
      await device.engine.renameSingleFile('Downloaded.md', 'New heading.md');
      await device.sync();
      expect(await writer.statFile('Downloaded.md')).toBeNull();
      expect((await writer.statFile('New heading.md'))?.fileId).toBe(originalId);
      expect(decodeBuf(await writer.downloadFile('New heading.md'))).toBe('# New heading\nbody\n');
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });

  it('keeps folder and child identities and versions across parents, while a second device sees the move', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    try {
      const from = 'Alpha/Research';
      const to = 'Beta/New Research';
      const original = `${from}/Nested/note.md`;
      const moved = `${to}/Nested/note.md`;
      await writer.createDirectory('Beta');
      await writer.uploadFile(original, textBuf('earlier version\n'));
      await new Promise(resolve => setTimeout(resolve, 1100));
      await writer.uploadFile(original, textBuf('current version\n'));
      await writer.createDirectory(`${from}/Empty`);
      const dirId = (await writer.statFolderMovePath(from))?.directoryId;
      const fileId = (await writer.statFile(original))?.fileId;
      expect(dirId).toBeTruthy();
      expect(fileId).toBeTruthy();
      const version = (await writer.listVersions(fileId!)).at(-1);
      expect(version).toBeDefined();

      const device = makeDevice(env, ws.remoteBase, 'move-device');
      const second = makeDevice(env, ws.remoteBase, 'second-device');
      await device.sync();
      await second.sync();
      await moveLocally(device, from, to);
      await device.engine.renameSingleFolder(from, to);
      expect(device.engine.getStatusReport().pendingFolderMoves).toEqual([]);
      expect(await writer.statFolderMovePath(from)).toBeNull();
      expect((await writer.statFolderMovePath(to))?.directoryId).toBe(dirId);
      expect((await writer.statFile(moved))?.fileId).toBe(fileId);
      expect(decodeBuf(await writer.getVersionContent(version!, fileId!))).toBe('earlier version\n');
      expect(device.stateDB.getFile(moved)?.checkAfterFolderMove).toBeUndefined();

      await second.sync();
      expect(second.vault.readLocal(moved)).toBe('current version\n');
      expect(second.vault.readLocal(original)).toBeNull();
      expect(second.vault.folderExists(`${to}/Empty`)).toBe(true);
      await second.vault.adapter.remove(moved);
      await second.sync();
      expect(await writer.statFile(moved)).toBeNull();
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });

  it('retargets a pending child move when an untracked destination parent is renamed', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    try {
      await writer.uploadFile('Original/note.md', textBuf('same object'));
      const id = (await writer.statFile('Original/note.md'))!.fileId;
      const device = makeDevice(env, ws.remoteBase, 'retarget');
      await device.sync();
      await moveLocally(device, 'Original', 'NewParent/Folder');
      await moveLocally(device, 'NewParent', 'FinalParent');
      expect(device.engine.getStatusReport().pendingFolderMoves).toEqual([
        expect.objectContaining({ source: 'Original', destination: 'FinalParent/Folder' }),
      ]);
      await device.sync();
      expect(await writer.statFile('FinalParent/Folder/note.md')).toBeNull();
      expect((await writer.statFile('Original/note.md'))?.fileId).toBe(id);
      await device.sync();
      expect((await writer.statFile('FinalParent/Folder/note.md'))?.fileId).toBe(id);
      expect(await writer.statFolderMovePath('Original')).toBeNull();
      expect(await writer.statFolderMovePath('NewParent')).toBeNull();
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });

  it('keeps a replacement target from moving or deleting the original after restart', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    try {
      await writer.uploadFile('Source/note.md', textBuf('shared contents'));
      const original = await writer.statFile('Source/note.md');
      const device = makeDevice(env, ws.remoteBase, 'lost-target-before-move');
      await device.sync();
      await moveLocally(device, 'Source', 'Target');
      device.vault.deleteLocalTree('Target');
      device.engine.rememberFolderDeletion('Target');
      device.vault.seedLocal('Target/replacement.md', 'different local folder');
      forgetFolderDeletion(device, 'Target');
      await device.stateDB.save();

      const restarted = await restartDevice(env, ws.remoteBase, device);
      await restarted.sync();
      expect(restarted.engine.getStatusReport().pendingFolderMoves).toEqual([
        expect.objectContaining({ destinationRemoved: true, issue: 'local-missing' }),
      ]);
      expect(await writer.statFolderMovePath('Target')).toBeNull();
      expect((await writer.statFile('Source/note.md'))?.fileId).toBe(original?.fileId);
      expect(restarted.vault.readLocal('Target/replacement.md')).toBe('different local folder');

      await moveLocally(restarted, 'Target', 'Source');
      await restarted.sync();
      expect(restarted.engine.getStatusReport().pendingFolderMoves).toEqual([]);
      expect((await writer.statFile('Source/note.md'))?.fileId).toBe(original?.fileId);
      expect(restarted.vault.readLocal('Source/note.md')).toBe('shared contents');
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });

  it('recognizes a MOVE with a lost response and restores a missing local child without deleting the server child', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    try {
      await writer.uploadFile('Source/note.md', textBuf('preserve me'));
      const original = await writer.statFile('Source/note.md');
      const device = makeDevice(env, ws.remoteBase, 'lost-response');
      await device.sync();
      await moveLocally(device, 'Source', 'Target');
      const realMove = device.client.moveTrackedFolder.bind(device.client);
      jest.spyOn(device.client, 'moveTrackedFolder').mockImplementationOnce(async (...args) => {
        await realMove(...args);
        device.vault.deleteLocalTree('Target');
        device.engine.rememberFolderDeletion('Target');
        device.vault.seedFolder('Target');
        forgetFolderDeletion(device, 'Target');
        throw new NetworkError(0, '', 'MOVE');
      });
      await device.sync();
      expect(await writer.statFile('Source/note.md')).toBeNull();
      expect((await writer.statFile('Target/note.md'))?.fileId).toBe(original?.fileId);
      expect(device.stateDB.getPendingFolderMoves()).toHaveLength(1);

      const restarted = await restartDevice(env, ws.remoteBase, device);
      const retryMove = jest.spyOn(restarted.client, 'moveTrackedFolder');
      await restarted.sync();
      expect(retryMove).not.toHaveBeenCalled();
      expect(restarted.engine.getStatusReport().pendingFolderMoves).toEqual([]);
      expect((await writer.statFile('Target/note.md'))?.fileId).toBe(original?.fileId);
      expect(restarted.vault.readLocal('Target/note.md')).toBe('preserve me');
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });

  it('backs off on a foreign child lock, retains both paths on restart and retries the matching child after unlock', async () => {
    const env = getEnv();
    const second = requireUser2(env);
    const peer = { ...env, serverUrl: second.serverUrl, username: second.username, appPassword: second.password };
    const { client: writer, ws } = await setupWorkspace(env);
    let token: string | null = null;
    const original = 'Source/note.md';
    try {
      await writer.uploadFile(original, textBuf('locked child'));
      const originalId = (await writer.statFile(original))!.fileId!;
      await shareWithUser(env, ws.remoteBase, peer.username);
      const device = makeDevice(peer, ws.name, 'folder-lock');
      await device.sync();
      token = await writer.lockFile(original);
      await moveLocally(device, 'Source', 'Target');
      await device.sync();
      expect(device.engine.getStatusReport().pendingFolderMoves).toEqual([
        expect.objectContaining({ source: 'Source', destination: 'Target', issue: 'locked' }),
      ]);
      expect(await writer.statFolderMovePath('Target')).toBeNull();
      const restarted = await restartDevice(peer, ws.name, device);
      await restarted.sync();
      await writer.unlockFile(original, token);
      token = null;
      await restarted.sync();
      expect(restarted.engine.getStatusReport().pendingFolderMoves).toEqual([]);
      expect(await writer.statFile(original)).toBeNull();
      expect((await writer.statFile('Target/note.md'))?.fileId).toBe(originalId);
    } finally {
      if (token) await writer.unlockFile(original, token);
      await cleanupWorkspace(writer, ws);
    }
  });

  it('holds a colliding destination and keeps edits by another device in both trees', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    try {
      await writer.uploadFile('Old/note.md', textBuf('original'));
      const device = makeDevice(env, ws.remoteBase, 'folder-collision');
      await device.sync();
      await moveLocally(device, 'Old', 'New');
      device.vault.seedLocal('New/note.md', 'my local edit');
      await writer.uploadFile('New/note.md', textBuf('peer target'));
      await writer.uploadFile('Old/note.md', textBuf('peer source edit'));
      await device.sync();
      expect(device.engine.getStatusReport().pendingFolderMoves).toEqual([
        expect.objectContaining({ issue: 'conflict' }),
      ]);
      expect(device.vault.readLocal('New/note.md')).toBe('my local edit');
      expect(decodeBuf(await writer.downloadFile('Old/note.md'))).toBe('peer source edit');
      expect(decodeBuf(await writer.downloadFile('New/note.md'))).toBe('peer target');
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });

  it('leaves a local draft created while recovery is downloading a missing moved child', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    try {
      await writer.uploadFile('Old/note.md', textBuf('base'));
      const device = makeDevice(env, ws.remoteBase, 'folder-recovery-draft');
      await device.sync();
      await moveLocally(device, 'Old', 'New');
      await device.vault.adapter.remove('New/note.md');
      const realDownload = device.client.downloadFile.bind(device.client);
      jest.spyOn(device.client, 'downloadFile').mockImplementationOnce(async path => {
        const body = await realDownload(path);
        device.vault.seedLocal(path, 'new local draft');
        return body;
      });
      await device.sync();
      expect(device.vault.readLocal('New/note.md')).toBe('new local draft');
      expect(decodeBuf(await writer.downloadFile('New/note.md'))).toBe('base');
      await device.sync();
      expect(decodeBuf(await writer.downloadFile('New/note.md'))).toBe('new local draft');
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });
});

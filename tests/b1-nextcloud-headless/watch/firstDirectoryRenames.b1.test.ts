import { describeLive } from '../support/env';
import { makeDevice, restartDevice } from '../support/engineDevice';
import { decodeBuf, textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';

function holdMkdirResponse(remoteBase: string, folder: string, loseResponse = false) {
  let report!: (status: number) => void;
  let release!: () => void;
  const received = new Promise<number>(resolve => { report = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const send = globalThis.fetch;
  const mock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await send(input, init);
    const wantedPath = `/${remoteBase}/${folder}`;
    if (init?.method === 'MKCOL' && decodeURIComponent(new URL(String(input)).pathname).endsWith(wantedPath)) {
      report(response.status);
      await waiting;
      if (loseResponse) throw new Error('MKCOL response was lost after creation');
    }
    return response;
  });
  return { received, release, restore: () => mock.mockRestore() };
}

describeLive('Renames during first directory creation', getEnv => {
  it.each(['folder first', 'note first', 'implicit MKCOL'])('keeps folder and note IDs through an overlapping rename (%s)', async order => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'first-folder-move');
    const source = 'Untitled';
    const destination = 'Projects/Überblick';
    const oldNote = `${source}/Untitled.md`;
    const finalNote = `${destination}/Überblick.md`;
    await writer.createDirectory('Projects');
    await d.sync();
    d.vault.seedLocal(oldNote, '# Untitled\nbody\n');
    const mkcol = holdMkdirResponse(ws.remoteBase, source);
    const implicit = order === 'implicit MKCOL';
    const create = implicit ? d.engine.syncSingleFile(oldNote) : d.engine.createSingleFolder(source);
    try {
      expect(await mkcol.received).toBe(201);
      const folderId = (await writer.statFolderMovePath(source))?.directoryId;
      expect(folderId).toBeTruthy();
      if (!implicit) await d.engine.syncSingleFile(oldNote);
      const fileId = (await writer.statFile(oldNote))?.fileId;
      if (!implicit) expect(fileId).toBeTruthy();

      if (order === 'note first') {
        const renamed = `${source}/Überblick.md`;
        await d.vault.adapter.rename(oldNote, renamed);
        d.engine.rememberFileRename(oldNote, renamed);
        await d.vault.adapter.rename(renamed, finalNote);
        d.vault.deleteLocalTree(source);
        d.engine.rememberFolderRename(source, destination);
      } else {
        const moved = `${destination}/Untitled.md`;
        await d.vault.adapter.rename(oldNote, moved);
        d.vault.deleteLocalTree(source);
        d.engine.rememberFolderRename(source, destination);
        await d.vault.adapter.rename(moved, finalNote);
        d.engine.rememberFileRename(moved, finalNote);
      }
      d.vault.seedLocal(finalNote, '# Überblick\nbody\n');
      expect(d.engine.getStatusReport().pendingFolderMoves).toEqual([
        expect.objectContaining({ source, destination, unconfirmedCreate: true }),
      ]);
      await d.engine.syncSingleFile(finalNote);
      expect(await writer.statFile(finalNote)).toBeNull();

      mkcol.release();
      await create;
      const uploadedId = fileId ?? (await writer.statFile(oldNote))?.fileId;
      expect(uploadedId).toBeTruthy();
      await d.sync();
      expect(await writer.statFolderMovePath(source)).toBeNull();
      expect((await writer.statFolderMovePath(destination))?.directoryId).toBe(folderId);
      expect((await writer.statFile(finalNote))?.fileId).toBe(uploadedId);
      expect(decodeBuf(await writer.downloadFile(finalNote))).toBe('# Überblick\nbody\n');
    } finally {
      mkcol.release();
      await create.catch(() => undefined);
      mkcol.restore();
      await cleanupWorkspace(writer, ws);
    }
  });

  it.each(['lost response', 'already exists'])('reserves the paths without moving an unconfirmed collection (%s)', async mode => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'unconfirmed-folder-move');
    await writer.uploadFile('Anchor.md', textBuf('anchor'));
    await d.sync();
    if (mode === 'already exists') await writer.uploadFile('Draft/Peer.md', textBuf('peer content'));
    d.vault.seedFolder('Draft');
    const mkcol = holdMkdirResponse(ws.remoteBase, 'Draft', mode === 'lost response');
    const create = d.engine.createSingleFolder('Draft');
    try {
      expect(await mkcol.received).toBe(mode === 'lost response' ? 201 : 405);
      const originalId = (await writer.statFolderMovePath('Draft'))?.directoryId;
      expect(originalId).toBeTruthy();
      d.vault.deleteLocalTree('Draft');
      d.vault.seedLocal('Renamed/Local.md', 'local content');
      d.engine.rememberFolderRename('Draft', 'Renamed');
      mkcol.release();
      await create;
      await d.engine.flushState();

      const restarted = await restartDevice(env, ws.remoteBase, d);
      await restarted.engine.syncSingleFile('Renamed/Local.md');
      await restarted.engine.syncForClientPush();
      await restarted.sync();
      expect((await writer.statFolderMovePath('Draft'))?.directoryId).toBe(originalId);
      expect(await writer.statFolderMovePath('Renamed')).toBeNull();
      expect(restarted.vault.readLocal('Renamed/Local.md')).toBe('local content');
      expect(restarted.engine.getStatusReport().pendingFolderMoves).toEqual([
        expect.objectContaining({ source: 'Draft', destination: 'Renamed', unconfirmedCreate: true }),
      ]);
      if (mode === 'already exists') expect(decodeBuf(await writer.downloadFile('Draft/Peer.md'))).toBe('peer content');
    } finally {
      mkcol.release();
      await create.catch(() => undefined);
      mkcol.restore();
      await cleanupWorkspace(writer, ws);
    }
  });

  it('does not move a peer replacement of the collection named in a delayed creation response', async () => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'replaced-first-folder');
    await writer.uploadFile('Anchor.md', textBuf('anchor'));
    await d.sync();
    d.vault.seedFolder('Draft');
    const mkcol = holdMkdirResponse(ws.remoteBase, 'Draft');
    const create = d.engine.createSingleFolder('Draft');
    try {
      expect(await mkcol.received).toBe(201);
      const previous = await writer.statFolderMovePath('Draft');
      expect(previous?.directoryId).toBeTruthy();
      await writer.moveFile('Draft', 'Peer moved original');
      await writer.uploadFile('Draft/Peer.md', textBuf('another collection'));
      const replacement = await writer.statFolderMovePath('Draft');
      expect(replacement?.directoryId).not.toBe(previous?.directoryId);

      d.vault.deleteLocalTree('Draft');
      d.vault.seedLocal('Renamed/Local.md', 'local content');
      d.engine.rememberFolderRename('Draft', 'Renamed');
      mkcol.release();
      await create;
      await d.sync();
      expect(d.engine.getStatusReport().pendingFolderMoves).toEqual([
        expect.objectContaining({ source: 'Draft', destination: 'Renamed', fileId: previous?.directoryId, issue: 'conflict' }),
      ]);
      expect(await writer.statFolderMovePath('Renamed')).toBeNull();
      expect((await writer.statFolderMovePath('Peer moved original'))?.directoryId).toBe(previous?.directoryId);
      expect((await writer.statFolderMovePath('Draft'))?.directoryId).toBe(replacement?.directoryId);
      expect(decodeBuf(await writer.downloadFile('Draft/Peer.md'))).toBe('another collection');
    } finally {
      mkcol.release();
      await create.catch(() => undefined);
      mkcol.restore();
      await cleanupWorkspace(writer, ws);
    }
  });
});

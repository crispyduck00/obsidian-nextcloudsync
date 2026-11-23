import { describeLive } from '../support/env';
import { decodeBuf, textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { makeDevice, restartDevice } from '../support/engineDevice';
import { setupWorkspace } from '../support/workspace';

describeLive('File rename recovery and conflicts on Nextcloud', getEnv => {
  it('does not MOVE a remotely edited file based on a same-content local replacement without a rename event', async () => {
    const env = getEnv();
    const { ws, client } = await setupWorkspace(env);
    try {
      await client.uploadFile('Old.md', textBuf('template\n'));
      const d = makeDevice(env, ws.name, 'unobserved');
      await d.sync();
      const originalId = (await client.statFile('Old.md'))?.fileId;
      await client.uploadFile('Old.md', textBuf('edited independently on the server\n'));
      await d.vault.adapter.remove('Old.md');
      d.vault.seedLocal('Other folder/New.md', 'template\n');
      const restarted = await restartDevice(env, ws.name, d);
      await restarted.sync();

      expect((await client.statFile('Old.md'))?.fileId).toBe(originalId);
      expect(decodeBuf(await client.downloadFile('Old.md'))).toBe('edited independently on the server\n');
      expect(decodeBuf(await client.downloadFile('Other folder/New.md'))).toBe('template\n');
    } finally {
      await cleanupWorkspace(client, ws);
    }
  });

  it('holds an inferred rename within one folder when the source bytes have changed', async () => {
    const env = getEnv();
    const { ws, client } = await setupWorkspace(env);
    try {
      await client.uploadFile('Old.md', textBuf('initial\n'));
      const d = makeDevice(env, ws.name, 'unobserved-peer-edit');
      await d.sync();
      const originalId = (await client.statFile('Old.md'))?.fileId;
      await d.vault.adapter.rename('Old.md', 'New.md');
      await client.uploadFile('Old.md', textBuf('updated\n'));

      await d.sync();

      expect((await client.statFile('Old.md'))?.fileId).toBe(originalId);
      expect(decodeBuf(await client.downloadFile('Old.md'))).toBe('updated\n');
      expect(await client.remoteExists('New.md')).toBe(false);
      expect(d.vault.readLocal('New.md')).toBe('initial\n');
      expect(d.engine.getStatusReport().pendingFileRenames).toEqual([
        expect.objectContaining({ issue: 'conflict' }),
      ]);
    } finally {
      await cleanupWorkspace(client, ws);
    }
  });

  it('keeps the original when the pending local target has become a directory', async () => {
    const env = getEnv();
    const { ws, client } = await setupWorkspace(env);
    try {
      await client.uploadFile('Old.md', textBuf('original'));
      const d = makeDevice(env, ws.name, 'directory-target');
      await d.sync();
      const originalId = (await client.statFile('Old.md'))?.fileId;
      await d.vault.adapter.rename('Old.md', 'Target');
      d.engine.rememberFileRename('Old.md', 'Target');
      await d.vault.adapter.remove('Target');
      await d.vault.adapter.mkdir('Target');
      d.vault.seedLocal('Target/Child.md', 'new child');
      await d.engine.createSingleFolder('Target');
      await d.engine.syncSingleFile('Target/Child.md');
      await d.sync();

      expect((await client.statFile('Old.md'))?.fileId).toBe(originalId);
      expect(await client.remoteExists('Target')).toBe(false);
      expect(d.vault.readLocal('Target/Child.md')).toBe('new child');
      expect(d.engine.getStatusReport().pendingFileRenames).toEqual([
        expect.objectContaining({ issue: 'local-missing' }),
      ]);
    } finally {
      await cleanupWorkspace(client, ws);
    }
  });

  it('recognizes the same rename made on two clients and preserves the document at the agreed name', async () => {
    const env = getEnv();
    const { ws, client } = await setupWorkspace(env);
    try {
      await client.uploadFile('Old.md', textBuf('original'));
      const d1 = makeDevice(env, ws.name, 'same-A');
      const d2 = makeDevice(env, ws.name, 'same-B');
      const id = (await client.statFile('Old.md'))?.fileId;
      await d1.sync();
      await d2.sync();
      for (const d of [d1, d2]) {
        await d.vault.adapter.rename('Old.md', 'New.md');
        d.engine.rememberFileRename('Old.md', 'New.md');
      }
      await d1.sync();
      await d2.sync();

      expect(await client.statFile('Old.md')).toBeNull();
      expect((await client.statFile('New.md'))?.fileId).toBe(id);
      expect(d1.engine.getStatusReport().pendingFileRenames).toEqual([]);
      expect(d2.engine.getStatusReport().pendingFileRenames).toEqual([]);
      expect(d2.vault.readLocal('New.md')).toBe('original');
    } finally {
      await cleanupWorkspace(client, ws);
    }
  });

  it('recovers a blocked rename by choosing a third name without taking over the other file', async () => {
    const env = getEnv();
    const { ws, client } = await setupWorkspace(env);
    try {
      await client.uploadFile('Old.md', textBuf('original'));
      await client.uploadFile('Taken.md', textBuf('unrelated'));
      const d = makeDevice(env, ws.name, 'third-name');
      await d.sync();
      const originalId = (await client.statFile('Old.md'))?.fileId;
      // The other note remains on the server and in tracking when this device moves into its vacant path.
      await d.vault.adapter.remove('Taken.md');
      await d.vault.adapter.rename('Old.md', 'Taken.md');
      d.engine.rememberFileRename('Old.md', 'Taken.md');
      await d.engine.syncRememberedFileRename('Old.md', 'Taken.md');
      expect(d.engine.getStatusReport().pendingFileRenames?.[0].issue).toBe('conflict');

      await d.vault.adapter.rename('Taken.md', 'Third.md');
      d.engine.rememberFileRename('Taken.md', 'Third.md');
      await d.engine.syncRememberedFileRename('Taken.md', 'Third.md');

      expect((await client.statFile('Third.md'))?.fileId).toBe(originalId);
      expect(decodeBuf(await client.downloadFile('Taken.md'))).toBe('unrelated');
      expect(d.engine.getStatusReport().pendingFileRenames).toEqual([]);
    } finally {
      await cleanupWorkspace(client, ws);
    }
  });

  it('holds the other client’s different destination and keeps its unsynced edits', async () => {
    const env = getEnv();
    const { ws, client } = await setupWorkspace(env);
    try {
      await client.uploadFile('Old.md', textBuf('original'));
      const winner = makeDevice(env, ws.name, 'different-A');
      const other = makeDevice(env, ws.name, 'different-B');
      const id = (await client.statFile('Old.md'))?.fileId;
      await winner.sync();
      await other.sync();
      await winner.vault.adapter.rename('Old.md', 'First.md');
      winner.engine.rememberFileRename('Old.md', 'First.md');
      await other.vault.adapter.rename('Old.md', 'Second.md');
      other.engine.rememberFileRename('Old.md', 'Second.md');
      other.vault.seedLocal('Second.md', 'local changes on second client');
      await winner.sync();
      await other.sync();

      expect((await client.statFile('First.md'))?.fileId).toBe(id);
      expect(await client.statFile('Second.md')).toBeNull();
      expect(other.vault.readLocal('Second.md')).toBe('local changes on second client');
      expect(other.engine.getStatusReport().pendingFileRenames).toEqual([
        expect.objectContaining({ issue: 'conflict' }),
      ]);
    } finally {
      await cleanupWorkspace(client, ws);
    }
  });

  it('moves a note through a case-only rename on the server', async () => {
    const env = getEnv();
    const { ws, client } = await setupWorkspace(env);
    try {
      const source = 'Öl und Salz 100%.md';
      const destination = 'Öl und salz 100%.md';
      await client.uploadFile(source, textBuf('original'));
      const d = makeDevice(env, ws.name, 'case-change');
      await d.sync();
      const id = (await client.statFile(source))?.fileId;
      await d.vault.adapter.rename(source, destination);
      d.engine.rememberFileRename(source, destination);
      await d.sync();

      expect(await client.statFile(source)).toBeNull();
      expect((await client.statFile(destination))?.fileId).toBe(id);
      expect(d.engine.getStatusReport().pendingFileRenames).toEqual([]);
    } finally {
      await cleanupWorkspace(client, ws);
    }
  });
});

// An established vault must upload every new sibling in one sync even when the first PUT
// records the newly created parent after the directory listing was obtained.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace } from '../support/isolation';
import { makeDevice } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';

describeLive('New folder sibling uploads', getEnv => {
  it.each([false, true])('uploads both siblings in the first sync (existing parent: %s)', async existing => {
    const env = getEnv();
    const { client, ws } = await setupWorkspace(env);
    const a = makeDevice(env, ws.remoteBase, `siblings-a-${existing}`);
    const b = makeDevice(env, ws.remoteBase, `siblings-b-${existing}`);
    try {
      a.vault.seedLocal('Anchor.md', 'baseline');
      await a.sync();
      if (existing) {
        await client.createDirectory('Fresh');
        await a.sync();
      }
      a.vault.seedLocal('Fresh/a.md', 'first sibling');
      a.vault.seedLocal('Fresh/b.md', 'second sibling');
      await a.sync();
      expect(a.engine.getLastSessionSummary()?.errors).toEqual([]);
      expect(a.engine.getLastSessionSummary()?.uploadedCount).toBe(2);
      await b.sync();
      for (const [path, body] of [['Fresh/a.md', 'first sibling'], ['Fresh/b.md', 'second sibling']]) {
        expect(decodeBuf(await client.downloadFile(path))).toBe(body);
        expect(b.vault.readLocal(path)).toBe(body);
        expect(a.stateDB.getFile(path)?.remoteFileId).toBe((await client.statFile(path))?.fileId);
      }
      expect(b.engine.getLastSessionSummary()?.errors).toEqual([]);
    } finally {
      a.localAdapter.dispose();
      b.localAdapter.dispose();
      await cleanupWorkspace(client, ws);
    }
  });
});

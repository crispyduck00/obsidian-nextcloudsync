import { tmpPathFor } from '../../../src/data/LocalAdapter';
import { describeLive } from '../support/env';
import { makeDevice } from '../support/engineDevice';
import { decodeBuf, textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';

describeLive('RC.9 local recreation during a restore', getEnv => {
  it.each(['during GET', 'during the temporary write'])('preserves a draft recreated %s', async phase => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'restore-write-window');
    const note = 'Project/Deep/Note.md';
    const draft = 'local draft created during restore\n';
    const remote = 'peer revision waiting to be restored\n';
    try {
      await writer.uploadFile('Anchor.md', textBuf('keep'));
      await writer.uploadFile(note, textBuf('common base\n'));
      await d.sync();
      const original = d.stateDB.getFile(note);
      expect(original?.remoteFileId).toBeTruthy();
      await d.vault.adapter.remove(note);
      await writer.uploadFile(note, textBuf(remote));
      let inserted = false;
      const createDraft = () => {
        expect(d.vault.readLocal(note)).toBeNull();
        d.vault.seedLocal(note, draft);
        expect(d.vault.readLocal(note)).toBe(draft);
        inserted = true;
      };
      const realGet = d.client.downloadFile.bind(d.client);
      const realWrite = d.vault.adapter.writeBinary.bind(d.vault.adapter);
      const get = jest.spyOn(d.client, 'downloadFile').mockImplementation(async path => {
        const bytes = await realGet(path);
        if (phase === 'during GET' && path === note && !inserted) createDraft();
        return bytes;
      });
      const write = jest.spyOn(d.vault.adapter, 'writeBinary').mockImplementation(async (...args) => {
        await realWrite(...args);
        if (phase === 'during the temporary write' && args[0] === tmpPathFor(note) && !inserted) createDraft();
      });
      const remove = jest.spyOn(d.vault.adapter, 'remove');
      const upload = jest.spyOn(d.client, 'uploadFile');
      try {
        await d.sync();
        const actual = {
          inserted,
          local: d.vault.readLocal(note),
          server: decodeBuf(await writer.downloadFile(note)),
          removedDraft: remove.mock.calls.some(([path]) => path === note),
          uploaded: upload.mock.calls.some(([path]) => path === note),
          retainedBaseline: d.stateDB.getFile(note)?.localHash === original?.localHash,
          pending: d.engine.getStatusReport().retryFiles.includes(note),
        };
        expect(actual).toEqual({
          inserted: true, local: draft, server: remote, removedDraft: false,
          uploaded: false, retainedBaseline: true, pending: true,
        });
      } finally {
        get.mockRestore();
        write.mockRestore();
        remove.mockRestore();
        upload.mockRestore();
      }
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });
});

import { describeLive } from '../support/env';
import { makeDevice, restartDevice } from '../support/engineDevice';
import { decodeBuf, textBuf } from '../support/helpers';
import { cleanupWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { recordRequests } from '../support/requestRecorder';

describeLive('Local writes after a regular download was scheduled', getEnv => {
  it.each([
    ['manual sync with a newly arrived remote file', false],
    ['manual sync on an already synced file', true],
  ] as const)('preserves local changes during %s', async (phase, tracked) => {
    const env = getEnv();
    const { client: writer, ws } = await setupWorkspace(env);
    const d = makeDevice(env, ws.remoteBase, 'uncommitted-local-edit');
    const path = 'Notes/Target.md';
    const initial = 'baseline note';
    const draft = 'draft written by local user during GET';
    const remote = 'content downloaded from another device';
    try {
      await writer.uploadFile('Anchor.md', textBuf('keep'));
      if (tracked) await writer.uploadFile(path, textBuf(initial));
      await d.sync();
      expect(d.vault.readLocal(path)).toBe(tracked ? initial : null);
      const baseline = d.stateDB.getFile(path)?.localHash;
      await writer.uploadFile(path, textBuf(remote));
      const serverId = (await writer.statFile(path))?.fileId;
      expect(serverId).toBeTruthy();
      const read = d.client.downloadFile.bind(d.client);
      let inserted = false;
      const replace = jest.spyOn(d.client, 'downloadFile').mockImplementation(async (file) => {
        const bytes = await read(file);
        if (file === path && !inserted) {
          d.vault.seedLocal(path, draft);
          expect(d.vault.readLocal(path)).toBe(draft);
          inserted = true;
        }
        return bytes;
      });
      const remove = jest.spyOn(d.vault.adapter, 'remove');
      const upload = jest.spyOn(d.client, 'uploadFile');
      try {
        await d.sync();
        const state = d.engine.getStatusReport();
        const actual = {
          phase, inserted, local: d.vault.readLocal(path), remote: decodeBuf(await writer.downloadFile(path)),
          removedLocal: remove.mock.calls.some(([file]) => file === path),
          uploaded: upload.mock.calls.some(([file]) => file === path),
          retainedBaseline: d.stateDB.getFile(path)?.localHash === baseline,
          retry: state.retryFiles.includes(path),
          conflict: d.stateDB.getFile(path)?.isConflicted === true,
        };
        expect(actual).toMatchObject({
          inserted: true, local: draft, remote, removedLocal: false, uploaded: false, retainedBaseline: true,
          retry: true, conflict: false,
        });
      } finally {
        replace.mockRestore();
        remove.mockRestore();
        upload.mockRestore();
      }
    } finally {
      await cleanupWorkspace(writer, ws);
    }
  });
});

describeLive('A changed local revision reaches the next reconciliation', getEnv => {
  it('holds a partial text write across restart before any damaged bytes can be uploaded', async () => {
    const env = getEnv();
    const { client, ws } = await setupWorkspace(env);
    const device = makeDevice(env, ws.remoteBase, 'partial-text-write');
    const path = 'Note.md', baseline = 'original common baseline', remote = 'new peer revision with all content';
    const recovery = '.Note.md.ncs.previous.ncs.tmp';
    const requests = recordRequests();
    try {
      await client.uploadFile(path, textBuf(baseline)); await device.sync();
      const id = (await client.statFile(path))?.fileId;
      await client.uploadFile(path, textBuf(remote));
      const process = jest.spyOn(device.vault.adapter, 'process').mockImplementationOnce(async (file, transform) => {
        const incoming = transform(await device.vault.adapter.read(file));
        await device.vault.adapter.write(file, incoming.slice(0, 3));
        throw new Error('volume write failed after truncation');
      });
      await device.sync(); process.mockRestore();
      expect(device.vault.readLocal(path)).toBe(remote.slice(0, 3));
      expect(device.vault.readLocal(recovery)).toBe(baseline);
      await device.engine.flushState();
      const restarted = await restartDevice(env, ws.remoteBase, device);
      requests.clear(); await restarted.sync();
      expect(restarted.engine.getLastSessionSummary()!.errorCount).toBeGreaterThan(0);
      expect(requests.requests.every(request => ['GET', 'PROPFIND', 'REPORT', 'HEAD'].includes(request.method))).toBe(true);
      expect(decodeBuf(await client.downloadFile(path))).toBe(remote);
      expect((await client.statFile(path))?.fileId).toBe(id);
      // Explicitly recover the saved revision, as the error message instructs, then retry.
      await restarted.vault.adapter.write(path, baseline); await restarted.vault.adapter.remove(recovery);
      await restarted.sync();
      expect(restarted.vault.readLocal(path)).toBe(remote);
      expect(restarted.engine.getLastSessionSummary()?.errors).toEqual([]);
      restarted.localAdapter.dispose();
    } finally { requests.restore(); device.localAdapter.dispose(); await cleanupWorkspace(client, ws); }
  });

  it('merges a same-size, same-mtime local edit after retry and an engine restart', async () => {
    const env = getEnv();
    const { client, ws } = await setupWorkspace(env);
    const note = 'Same stat.md';
    const base = ['head old', 'separator one', 'separator two', 'tail old', ''].join('\n');
    const local = base.replace('head old', 'head new');
    const remote = base.replace('tail old', 'tail new');
    const device = makeDevice(env, ws.remoteBase, 'same-stat-retry');
    try {
      await client.uploadFile(note, textBuf(base), Date.UTC(2024, 0, 1));
      await device.sync();
      const original = device.stateDB.getFile(note);
      const options = (await device.vault.adapter.stat(note))!;
      expect(original?.localMtime).toBe(options.mtime);

      await client.uploadFile(note, textBuf(remote));
      const download = device.client.downloadFile.bind(device.client);
      jest.spyOn(device.client, 'downloadFile').mockImplementationOnce(async path => {
        const data = await download(path);
        await device.vault.adapter.writeBinary(note, textBuf(local), options);
        expect(await device.vault.adapter.stat(note)).toEqual(options);
        return data;
      });
      await device.sync();
      expect(device.engine.getStatusReport().retryFiles).toContain(note);
      expect(device.vault.readLocal(note)).toBe(local);
      expect(decodeBuf(await client.downloadFile(note))).toBe(remote);
      expect(device.stateDB.getFile(note)?.localHash).toBe(original?.localHash);
      expect(device.stateDB.getFile(note)?.localMtime).toBeUndefined();
      await device.engine.flushState();

      const restarted = await restartDevice(env, ws.remoteBase, device);
      await restarted.sync();
      const merged = restarted.vault.readLocal(note);
      expect(merged?.trimEnd()).toBe(remote.replace('head old', 'head new').trimEnd());
      expect(decodeBuf(await client.downloadFile(note))).toBe(merged);
      expect(restarted.engine.getStatusReport().retryFiles).toEqual([]);
    } finally { await cleanupWorkspace(client, ws); }
  });

  it.each(['merge', 'remote-win'] as const)('does not apply a stale %s decision or upload stale merge bytes', async strategy => {
    const env = getEnv();
    const { client, ws } = await setupWorkspace(env);
    const device = makeDevice(env, ws.remoteBase, 'stale-conflict', { autoMergeFileStrategy: strategy });
    const note = 'Conflict.md';
    const base = 'local old\nshared line\nanother shared line\nremote old\n';
    const local = base.replace('local old', 'local v1');
    const later = base.replace('local old', 'local v2 (not part of the first decision)');
    const remote = base.replace('remote old', 'remote v1');
    try {
      await client.uploadFile(note, textBuf(base));
      await device.sync();
      const original = device.stateDB.getFile(note);
      device.vault.seedLocal(note, local);
      await client.uploadFile(note, textBuf(remote));

      const download = device.client.downloadFile.bind(device.client);
      jest.spyOn(device.client, 'downloadFile').mockImplementationOnce(async path => {
        const data = await download(path);
        device.vault.seedLocal(note, later);
        return data;
      });
      const upload = jest.spyOn(device.client, 'uploadFile');
      await device.sync();
      expect(device.vault.readLocal(note)).toBe(later);
      expect(device.stateDB.getFile(note)?.localHash).toBe(original?.localHash);
      expect(device.engine.getStatusReport().retryFiles).toContain(note);
      expect(upload).not.toHaveBeenCalled();
      expect(decodeBuf(await client.downloadFile(note))).toBe(remote);

      await device.sync();
      const resolved = strategy === 'merge' ? remote.replace('local old', 'local v2 (not part of the first decision)') : remote;
      const saved = device.vault.readLocal(note);
      expect(saved?.trimEnd()).toBe(resolved.trimEnd());
      expect(decodeBuf(await client.downloadFile(note))).toBe(saved);
    } finally { await cleanupWorkspace(client, ws); }
  });
});

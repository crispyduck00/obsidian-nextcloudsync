import { PushSyncScheduler } from '../../../../src/sync/push/PushSyncScheduler';
import type { RemotePushBatch } from '../../../../src/sync/push/RemotePushReconciler';
import { buildOversizeWorld, OVER, skipNotices } from '../../support/oversizeWorld';

it('defers an oversized pushed file and a known plugin while applying the note in the same batch', async () => {
  const attachment = 'Shared/attachment.bin';
  const note = 'unrelated.md';
  const plugin = '.obsidian/plugins/example/data.json';
  const w = await buildOversizeWorld({
    incremental: true, local: [[attachment, 'small']], remote: [[attachment, 'small']],
  });
  w.client.getRootEtag.mockResolvedValue('root-before');
  await w.manual();
  const base = w.stateDB.getFile(attachment)!;
  w.stateDB.setFile({ ...base, path: plugin, remoteFileId: 'plugin-id' });
  w.remote.set(attachment, { body: OVER, mtime: 3_000 });
  w.remote.set(note, { body: 'new note from the server', mtime: 3_000 });
  w.client.getRootEtag.mockResolvedValue('root-after');

  const sync = jest.fn(async () => 'completed' as const);
  const reconcile = jest.fn(async (batch: RemotePushBatch) => w.engine.reconcileRemoteFileIds(batch));
  const scheduler = new PushSyncScheduler({
    isSyncRunning: () => w.engine.isSyncRunning(), sync, debounceMs: 0, fullSyncQuietMs: 0, fullSyncMaxDelayMs: 0,
    shouldSync: () => w.engine.shouldReconcileClientPush(), reconcileFileIds: reconcile,
  });
  jest.useFakeTimers();
  try {
    scheduler.notify({ fileIds: [`fid-${attachment}`, 'plugin-id', `fid-${note}`], raw: 'notify_file_id' });
    await jest.runOnlyPendingTimersAsync();

    expect(reconcile).toHaveBeenCalledTimes(1);
    await expect(reconcile.mock.results[0].value).resolves.toBe('deferred');
    expect(w.client.statFile.mock.calls).toEqual([[attachment], [note]]);
    expect(w.client.downloadFile.mock.calls).toEqual([[note]]);
    expect(w.vault.get(note)?.body).toBe('new note from the server');
    expect(w.vault.get(attachment)?.body).toBe('small');
    expect(w.stateDB.getFile(attachment)).toEqual(base);
    expect(w.stateDB.getRemoteRootEtag()).toBe('root-before');
    expect(sync).not.toHaveBeenCalled();
    expect(skipNotices()).toHaveLength(0);

    // The deferred paths cannot certify an otherwise unexplained generic notification at this root.
    scheduler.notify({ fileIds: null, raw: 'notify_file' });
    await jest.runOnlyPendingTimersAsync();
    expect(sync).toHaveBeenCalledTimes(1);
  } finally {
    scheduler.stop();
    await w.stateDB.flush();
    jest.useRealTimers();
  }
});

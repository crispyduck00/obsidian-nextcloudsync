import { buildOversizeWorld, LIMIT_MB, OVER, UNDER } from '../support/oversizeWorld';

type World = Awaited<ReturnType<typeof buildOversizeWorld>>;
const ROOT = '"root-1"';
const ATTACHMENT = 'attachment.bin';
const TRACKED = 'unrelated.md';

function useNextcloudRoot(w: World): void {
  const synced = w.stateDB.getFile(TRACKED)!;
  w.stateDB.setFile({ ...synced, remoteEtag: `"${synced.remoteId}"` });
  w.client.getRootEtag.mockResolvedValue(ROOT);
  w.client.getFiles.mockImplementation(async () => (await w.listing()).map(file => ({
    ...file, etag: `"${file.checksum}"`,
  })));
}

describe('[SPEC:ES-12] size-skipped remote files and the root-ETag short-circuit', () => {
  it('keeps an untracked server file visible at the same root and imports it as soon as the cap is raised', async () => {
    const w = await buildOversizeWorld({ remote: [[ATTACHMENT, OVER]], incremental: true });
    useNextcloudRoot(w);

    await w.automatic();
    await w.automatic();

    expect(w.client.getFiles).toHaveBeenCalledTimes(1);
    expect(w.client.downloadFile).not.toHaveBeenCalled();
    expect(w.stateDB.getRemoteRootEtag()).toBe(ROOT);
    expect(w.stateDB.getRootSizeSkippedFiles().map(file => file.path)).toEqual([ATTACHMENT]);
    expect(w.stateDB.getFileByRemoteId(`fid-${ATTACHMENT}`)).toBeUndefined();

    w.settings.maxFileSizeMB = LIMIT_MB * 10;
    await w.manual();
    await w.automatic();

    expect(w.vault.get(ATTACHMENT)?.body).toBe(OVER);
    expect(w.client.getFiles).toHaveBeenCalledTimes(2);
    expect(w.client.downloadFile).toHaveBeenCalledTimes(1);
    expect(w.stateDB.getRootSizeSkippedFiles()).toEqual([]);
  });

  it.each(['edit', 'delete'])('protects a larger server edit when the previous local copy is changed by a local %s', async (change) => {
    const w = await buildOversizeWorld({ incremental: true });
    useNextcloudRoot(w);
    const baseId = w.stateDB.getFile(TRACKED)?.remoteId;
    w.remote.set(TRACKED, { body: OVER, mtime: 2_000 });

    await w.manual();
    if (change === 'edit') w.vault.set(TRACKED, { body: UNDER, mtime: 3_000 });
    else w.vault.delete(TRACKED);
    await w.manual();

    expect(w.client.getFiles).toHaveBeenCalledTimes(1);
    expect(w.client.uploadFile).not.toHaveBeenCalled();
    expect(w.client.deleteFile).not.toHaveBeenCalled();
    expect(w.client.downloadFile).not.toHaveBeenCalled();
    expect(w.remote.get(TRACKED)?.body).toBe(OVER);
    expect(w.stateDB.getFile(TRACKED)?.remoteId).toBe(baseId);
  });

  it('keeps a new local file from overwriting a size-skipped server file at the same path', async () => {
    const w = await buildOversizeWorld({ remote: [[ATTACHMENT, OVER]], incremental: true });
    useNextcloudRoot(w);

    await w.manual();
    w.vault.set(ATTACHMENT, { body: UNDER, mtime: 3_000 });
    await w.manual();

    expect(w.client.getFiles).toHaveBeenCalledTimes(1);
    expect(w.client.uploadFile).not.toHaveBeenCalled();
    expect(w.remote.get(ATTACHMENT)?.body).toBe(OVER);
    expect(w.vault.get(ATTACHMENT)?.body).toBe(UNDER);
  });

  it('replaces obsolete skipped metadata after a real server listing', async () => {
    const w = await buildOversizeWorld({ remote: [[ATTACHMENT, OVER]], incremental: true });
    useNextcloudRoot(w);
    await w.manual();

    w.remote.delete(ATTACHMENT);
    w.remote.set('replacement.bin', { body: OVER, mtime: 2_000 });
    w.client.getRootEtag.mockResolvedValue('"root-2"');
    await w.manual();
    await w.manual();

    expect(w.client.getFiles).toHaveBeenCalledTimes(2);
    expect(w.stateDB.getRootSizeSkippedFiles().map(file => file.path)).toEqual(['replacement.bin']);
    expect(w.client.downloadFile).not.toHaveBeenCalled();
  });

  it('does not re-arm a root listing invalidated while the scan was running', async () => {
    const w = await buildOversizeWorld({ remote: [[ATTACHMENT, OVER]], incremental: true });
    useNextcloudRoot(w);
    w.client.getDirectories.mockImplementationOnce(async () => {
      w.stateDB.setRemoteRootEtag(null);
      return [];
    });

    await w.manual();
    expect(w.stateDB.getRemoteRootEtag()).toBeNull();
    await w.manual();
    expect(w.client.getFiles).toHaveBeenCalledTimes(2);
    expect(w.stateDB.getRemoteRootEtag()).toBe(ROOT);
  });
});

import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../../src/types';

function build() {
  let open = true;
  const createClient = jest.fn();
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS }, localAdapter: {},
    stateDB: { getPendingFileRenames: () => [], getPendingFolderMoves: () => [] },
    statusBar: {}, configDir: '.obsidian', pluginDir: '.obsidian/plugins/fast-nextcloud-sync',
    webdavFactory: { createClient }, isRemoteMirrorOpen: () => open,
  } as never);
  const watch = (engine as unknown as { watch: { syncSingleFile(path: string): Promise<void> } }).watch;
  return { engine, watch, createClient, close: () => { open = false; } };
}

describe('ordinary sync during remote Mirror', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('manual, startup, resume and interval sync use the busy guard while the modal is open', async () => {
    const h = build();
    expect(h.engine.isSyncRunning()).toBe(true);
    await h.engine.syncManual({ manual: true });
    await h.engine.syncManual();
    expect(await h.engine.syncForClientPush()).toBe(false);
    h.engine.startAutoSync(1);
    await jest.advanceTimersByTimeAsync(120000);
    h.engine.stopAutoSync();
    expect(h.createClient).not.toHaveBeenCalled();
    h.close();
    expect(h.engine.isSyncRunning()).toBe(false);
  });

  test('watch edits stay pending and are reconsidered once after the active mirror closes', async () => {
    const h = build();
    h.engine.requestStop();
    await h.engine.syncSingleFile('Draft.md');
    const sync = jest.spyOn(h.watch, 'syncSingleFile').mockResolvedValue();
    await h.engine.resumeAfterRemoteMirror();
    expect(sync).not.toHaveBeenCalled();
    h.close();
    await h.engine.resumeAfterRemoteMirror();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith('Draft.md');
    await h.engine.resumeAfterRemoteMirror();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(h.createClient).not.toHaveBeenCalled();
  });
});

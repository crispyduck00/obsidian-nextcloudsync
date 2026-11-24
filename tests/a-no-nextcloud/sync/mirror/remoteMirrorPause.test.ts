import Plugin from '../../../../src/main';
import { openMirrorFromRemoteModal } from '../../../../src/ui/MirrorFromRemoteModal';
jest.mock('../../../../src/ui/MirrorFromRemoteModal', () => ({ openMirrorFromRemoteModal: jest.fn() }));
const modal = jest.mocked(openMirrorFromRemoteModal);

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

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => modal.mockReset());
test.each(['completed', 'failed', 'replaced'])('releases only the active engine after the Mirror dialog settles (%s)', async outcome => {
  const plugin = new Plugin({} as never, {} as never);
  const host = plugin as unknown as { syncEngine: unknown; mirrorInProgress: boolean };
  const resume = jest.fn(async () => {});
  const engine = { resumeAfterRemoteMirror: resume };
  host.syncEngine = engine;
  const wait = deferred();
  modal.mockImplementationOnce(() => wait.promise);
  const mirror = plugin.runRemoteMirror();
  expect(host.mirrorInProgress).toBe(true);
  expect(resume).not.toHaveBeenCalled();
  const currentResume = jest.fn(async () => {});
  if (outcome === 'replaced') host.syncEngine = { resumeAfterRemoteMirror: currentResume };
  if (outcome === 'failed') wait.reject(new Error('plan failed'));
  else wait.resolve();
  await mirror;
  expect(host.mirrorInProgress).toBe(false);
  expect(resume).toHaveBeenCalledTimes(outcome === 'replaced' ? 0 : 1);
  expect(currentResume).toHaveBeenCalledTimes(outcome === 'replaced' ? 1 : 0);
});

test('parks ordinary sync and Watch until the host closes Mirror', async () => {
  let open = true;
  const connect = jest.fn();
  const engine = new SyncEngine({ app: {}, settings: { ...DEFAULT_SETTINGS }, localAdapter: {}, stateDB: {},
    statusBar: {}, webdavFactory: { createClient: connect }, configDir: '.obsidian', pluginDir: '.obsidian/plugins/nextcloud-sync',
    isRemoteMirrorOpen: () => open,
  } as never);
  const drain = jest.spyOn(engine as unknown as { drainWatchPending(): Promise<void> }, 'drainWatchPending').mockResolvedValue();
  expect(engine.isSyncRunning()).toBe(true);
  await engine.syncManual();
  await engine.syncSingleFile('Note.md');
  expect(connect).not.toHaveBeenCalled();
  await engine.resumeAfterRemoteMirror();
  expect(drain).not.toHaveBeenCalled();
  open = false;
  await engine.resumeAfterRemoteMirror();
  expect(engine.isSyncRunning()).toBe(false);
  expect(drain).toHaveBeenCalledTimes(1);
});

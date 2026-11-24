import Plugin from '../../../src/main';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../src/types';
import { openMirrorFromRemoteModal } from '../../../src/ui/MirrorFromRemoteModal';

jest.mock('../../../src/ui/MirrorFromRemoteModal', () => ({ openMirrorFromRemoteModal: jest.fn() }));
const modal = jest.mocked(openMirrorFromRemoteModal);
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
  if (outcome === 'replaced') host.syncEngine = {};
  if (outcome === 'failed') wait.reject(new Error('plan failed'));
  else wait.resolve();
  await mirror;
  expect(host.mirrorInProgress).toBe(false);
  expect(resume).toHaveBeenCalledTimes(outcome === 'replaced' ? 0 : 1);
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

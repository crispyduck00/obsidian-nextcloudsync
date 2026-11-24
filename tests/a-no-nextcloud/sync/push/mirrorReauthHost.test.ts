import Plugin from '../../../../src/main';
import { NextcloudSyncSettingTab } from '../../../../src/settings/SettingTab';
import { LoginFlowV2 } from '../../../../src/auth/LoginFlowV2';
import { DEFAULT_SETTINGS, type LoginFlowResult } from '../../../../src/types';
import { WatchOperations, type WatchDeps } from '../../../../src/sync/watch/WatchOperations';
import { openMirrorFromRemoteModal } from '../../../../src/ui/MirrorFromRemoteModal';

jest.mock('../../../../src/ui/MirrorFromRemoteModal', () => ({ openMirrorFromRemoteModal: jest.fn() }));
const modal = jest.mocked(openMirrorFromRemoteModal);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function host() {
  const app = { secretStorage: { setSecret: jest.fn() } };
  const plugin = new Plugin(app as never, {} as never);
  const p = plugin as unknown as {
    settings: typeof DEFAULT_SETTINGS; logger: { log(): void }; mirrorInProgress: boolean;
    syncEngine: unknown;
  };
  p.settings = { ...DEFAULT_SETTINGS, serverUrl: 'http://127.0.0.1/remote.php/dav/files/test/', username: 'before' };
  p.logger = { log() {} };
  const engine = {
    abortAndWait: jest.fn(async () => {}),
    planRemoteMirror: jest.fn(async () => ({ ok: true })),
    applyRemoteMirror: jest.fn(async () => ({})),
    resumeAfterRemoteMirror: jest.fn(async () => {}),
  };
  p.syncEngine = engine;
  const reconcileStructure = jest.fn(async () => {});
  const watch = new WatchOperations({
    isSyncRunning: () => p.mirrorInProgress,
    isCancelled: () => false,
    isSystemExcluded: () => false, isPluginPath: () => false,
    isBlockedByWifiOnly: () => false, reconcileStructure,
  } as unknown as WatchDeps);
  const replacement = { resumeAfterRemoteMirror: jest.fn(() => watch.drainPending()) };
  jest.spyOn(plugin, 'saveSettings').mockResolvedValue();
  const init = jest.spyOn(plugin, 'initSyncEngine').mockImplementation(async () => { p.syncEngine = replacement; });
  const tab = new NextcloudSyncSettingTab(app as never, plugin);
  const approved = deferred<LoginFlowResult>();
  jest.spyOn(LoginFlowV2, 'start').mockResolvedValue({ loginUrl: 'http://127.0.0.1/login', pollEndpoint: 'http://127.0.0.1/poll', pollToken: 'test-token' });
  const poll = jest.spyOn(LoginFlowV2, 'poll').mockImplementation(() => approved.promise);
  return { plugin, p, tab, engine, replacement, approved, init, poll, watch, reconcileStructure };
}

beforeEach(() => {
  modal.mockReset();
  Object.defineProperty(window, 'open', { value: jest.fn(() => ({})), configurable: true });
});
afterEach(() => jest.restoreAllMocks());

test('a pending public browser login can replace the engine under a Mirror confirmation', async () => {
  const h = host(), closed = deferred<void>();
  let callbacks!: Parameters<typeof openMirrorFromRemoteModal>[1];
  modal.mockImplementationOnce((_app, actions) => { callbacks = actions; return closed.promise; });
  // The same public action is wired to the Login setting. Its poll stays pending while the user
  // returns to Obsidian and opens Mirror using the existing signed-in engine.
  const login = h.tab.startLoginFlow() as Promise<void>;
  await Promise.resolve();
  expect(h.poll).toHaveBeenCalledTimes(1);
  const mirror = h.plugin.runRemoteMirror();
  const plan = await callbacks.plan(() => {});
  h.approved.resolve({ status: 'success', server: 'http://127.0.0.1', loginName: 'after', appPassword: 'test-password' });
  await login;
  expect(h.init).toHaveBeenCalledTimes(1);
  expect(h.p.syncEngine).toBe(h.replacement);
  // The new engine sees a local deletion while the old dialog still owns the vault.
  await h.watch.deleteSingleFile('local.md');
  expect(h.reconcileStructure).not.toHaveBeenCalled();
  expect(() => callbacks.apply(plan, () => {})).toThrow('sync account or plugin changed');
  expect(h.engine.applyRemoteMirror).not.toHaveBeenCalled();
  closed.resolve(); await mirror;
  expect(h.engine.resumeAfterRemoteMirror).not.toHaveBeenCalled();
  expect(h.replacement.resumeAfterRemoteMirror).toHaveBeenCalledTimes(1);
  expect(h.reconcileStructure).toHaveBeenCalledTimes(1);
});

test('a plan that finishes after a successful asynchronous login is rejected before confirmation', async () => {
  const h = host(), closed = deferred<void>(), listing = deferred<{ ok: true }>();
  h.engine.planRemoteMirror.mockImplementationOnce(() => listing.promise);
  let callbacks!: Parameters<typeof openMirrorFromRemoteModal>[1];
  modal.mockImplementationOnce((_app, actions) => { callbacks = actions; return closed.promise; });
  const login = h.tab.startLoginFlow() as Promise<void>;
  await Promise.resolve();
  const mirror = h.plugin.runRemoteMirror();
  const planning = callbacks.plan(() => {});
  const rejected = expect(planning).rejects.toThrow('sync account or plugin changed');
  await Promise.resolve();
  h.approved.resolve({ status: 'success', server: 'http://127.0.0.1', loginName: 'after', appPassword: 'test-password' });
  await login;
  listing.resolve({ ok: true });
  await rejected;
  expect(h.engine.applyRemoteMirror).not.toHaveBeenCalled();
  closed.resolve(); await mirror;
  expect(h.replacement.resumeAfterRemoteMirror).toHaveBeenCalledTimes(1);
});

import Plugin from '../../../src/main';
import { StateDB } from '../../../src/data/StateDB';
import { SyncHistoryStore } from '../../../src/data/SyncHistoryStore';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { DEFAULT_SETTINGS } from '../../../src/types';
import { Platform, requestUrl } from 'obsidian';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function host() {
  const adapter = { exists: jest.fn(async () => false) };
  const plugin = new Plugin({ vault: { configDir: '.obsidian', getName: () => 'Test', adapter }, workspace: {} } as never,
    { id: 'fast-nextcloud-sync' } as never);
  plugin.settings = { ...DEFAULT_SETTINGS, deviceId: 'test-device', startupSyncDelaySeconds: 1 };
  const internals = plugin as unknown as { logger: unknown };
  internals.logger = { log() {} };
  const interval = jest.spyOn(plugin, 'applyAutoSyncInterval').mockImplementation(() => {});
  const settings = jest.spyOn(plugin, 'addSettingTab').mockImplementation(() => {});
  return { plugin, adapter, interval, settings };
}

async function untilStarted(started: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !started(); i++) await Promise.resolve();
  expect(started()).toBe(true);
}

describe('unload during asynchronous plugin initialization', () => {
  const platform = { mobile: Platform.isMobile, ios: Platform.isIosApp };
  beforeEach(() => {
    jest.useFakeTimers();
    Platform.isMobile = true;
    Platform.isIosApp = false;
    jest.mocked(requestUrl).mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    Platform.isMobile = platform.mobile;
    Platform.isIosApp = platform.ios;
  });

  test('does not continue initialization after unloading while dynamic imports are pending', async () => {
    const h = host();
    const init = h.plugin.initSyncEngine();
    h.plugin.onunload();
    await init;
    expect(h.plugin.syncEngine).toBeUndefined();
    expect(h.interval).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  test.each(['state', 'history'])('does not start an engine after unloading during %s loading', async phase => {
    const h = host(), loading = deferred();
    const load = jest.spyOn(phase === 'state' ? StateDB.prototype : SyncHistoryStore.prototype, 'load')
      .mockImplementationOnce(() => loading.promise);
    const dispose = jest.spyOn(LocalAdapter.prototype, 'dispose');
    const init = h.plugin.initSyncEngine();
    await untilStarted(() => load.mock.calls.length > 0);
    h.plugin.onunload();
    h.plugin.onunload();
    loading.resolve();
    await init;
    expect(h.plugin.syncEngine).toBeUndefined();
    expect(dispose).toHaveBeenCalled();
    expect(h.interval).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  test('ignores a delayed init request after the plugin was unloaded', async () => {
    const h = host();
    h.plugin.onunload();
    await h.plugin.initSyncEngine();
    expect(h.plugin.syncEngine).toBeUndefined();
    expect(h.adapter.exists).not.toHaveBeenCalled();
  });

  test('initializes an active instance normally and runs its startup sync once', async () => {
    const h = host();
    await h.plugin.initSyncEngine();
    expect(h.plugin.syncEngine).toBeDefined();
    expect(h.interval).toHaveBeenCalledTimes(1);
    const sync = jest.spyOn(h.plugin.syncEngine!, 'syncManual').mockResolvedValue();
    await jest.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(requestUrl).not.toHaveBeenCalled();
    h.plugin.onunload();
  });

  test('a previous startup timer cannot sync an engine that replaced its original instance', async () => {
    const h = host();
    await h.plugin.initSyncEngine();
    const original = h.plugin.syncEngine!;
    const sync = jest.fn();
    h.plugin.syncEngine = { syncManual: sync, stopAutoSync() {}, requestStop() {}, flushState: async () => {} } as never;
    await jest.advanceTimersByTimeAsync(1000);
    expect(sync).not.toHaveBeenCalled();
    h.plugin.onunload();
    original.requestStop();
  });

  test.each(['settings load', 'device ID save'])('does not register UI after unloading during %s', async phase => {
    const h = host(), loading = deferred();
    h.plugin.settings.deviceId = phase === 'device ID save' ? '' : 'test-device';
    const load = jest.spyOn(h.plugin, 'loadSettings').mockImplementationOnce(() => phase === 'settings load' ? loading.promise : Promise.resolve());
    const save = jest.spyOn(h.plugin, 'saveSettings').mockImplementationOnce(() => loading.promise);
    const startup = h.plugin.onload();
    await untilStarted(() => phase === 'settings load' ? load.mock.calls.length > 0 : save.mock.calls.length > 0);
    h.plugin.onunload();
    loading.resolve();
    await startup;
    expect(h.settings).not.toHaveBeenCalled();
    expect(h.plugin.syncEngine).toBeUndefined();
    expect(requestUrl).not.toHaveBeenCalled();
  });
});

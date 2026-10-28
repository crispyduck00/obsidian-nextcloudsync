import { Platform } from 'obsidian';
import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../../src/types';

function makeEngine(syncOnWifiOnly: boolean): SyncEngine {
  return new SyncEngine({
    app: {},
    settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly },
    localAdapter: {},
    stateDB: {},
    statusBar: {},
    webdavFactory: {},
    pluginDir: '',
    configDir: '.obsidian',
  } as never);
}

describe('SyncEngine.canRunWatchSync — mobile network policy', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  let savedNavigator: unknown;
  let savedIos: boolean;

  beforeEach(() => {
    savedNavigator = g.navigator;
    savedIos = Platform.isIosApp;
    Platform.isIosApp = false;
  });

  afterEach(() => {
    g.navigator = savedNavigator;
    Platform.isIosApp = savedIos;
  });

  function network(onLine: boolean, type?: string): void {
    g.navigator = { onLine, connection: type ? { type } : undefined };
  }

  it('blocks cellular when Wi-Fi-only is enabled', () => {
    network(true, 'cellular');
    expect(makeEngine(true).canRunWatchSync()).toBe(false);
  });

  it('allows Wi-Fi when Wi-Fi-only is enabled', () => {
    network(true, 'wifi');
    expect(makeEngine(true).canRunWatchSync()).toBe(true);
  });

  it('blocks offline before starting a new automatic watch operation', () => {
    network(false, 'wifi');
    expect(makeEngine(false).canRunWatchSync()).toBe(false);
  });

  it('allows cellular when Wi-Fi-only is disabled', () => {
    network(true, 'cellular');
    expect(makeEngine(false).canRunWatchSync()).toBe(true);
  });

  it('is permissive in a non-DOM test host with no navigator', () => {
    delete g.navigator;
    expect(makeEngine(true).canRunWatchSync()).toBe(true);
  });
});

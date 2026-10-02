import { Notice, Platform } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../src/types';

function makeEngine(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): SyncEngine {
  return new SyncEngine({
    app: {},
    settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false, ...overrides },
    localAdapter: {},
    stateDB: {},
    statusBar: {},
    webdavFactory: {},
    pluginDir: '',
    configDir: '.obsidian',
  } as never);
}

describe('Client Push automatic mobile feedback', () => {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  let previousNavigator: unknown;
  let previousMobile: boolean;

  beforeEach(() => {
    previousNavigator = globalRecord.navigator;
    previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    Notice.instances.length = 0;
    globalRecord.navigator = { onLine: true, connection: { type: 'wifi' } };
  });

  afterEach(() => {
    globalRecord.navigator = previousNavigator;
    Platform.isMobile = previousMobile;
    Notice.instances.length = 0;
  });

  it('defers a push full-reconciliation race silently when another full sync is already running', async () => {
    const engine = makeEngine();
    (engine as unknown as { running: boolean }).running = true;

    await expect(engine.syncForClientPush()).resolves.toBe(false);

    expect(Notice.instances).toHaveLength(0);
  });

  it('defers push silently when Wi-Fi-only blocks the current network', async () => {
    globalRecord.navigator = { onLine: true, connection: { type: 'cellular' } };
    const engine = makeEngine({ syncOnWifiOnly: true });

    await expect(engine.syncForClientPush()).resolves.toBe(false);

    expect(Notice.instances).toHaveLength(0);
  });

  it('does not change the ordinary manual busy guidance', async () => {
    const engine = makeEngine();
    (engine as unknown as { running: boolean }).running = true;

    await engine.syncManual({ manual: true });

    expect(Notice.instances).toHaveLength(1);
    expect(Notice.instances[0].message).toMatch(/already in progress/i);
  });
});

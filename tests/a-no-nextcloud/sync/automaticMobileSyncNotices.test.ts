import { Notice, Platform } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../src/types';

function makeEngine(over: Partial<typeof DEFAULT_SETTINGS> = {}): SyncEngine {
  return new SyncEngine({
    app: {},
    settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false, ...over },
    localAdapter: {},
    stateDB: {},
    statusBar: {},
    webdavFactory: {},
    pluginDir: '',
    configDir: '.obsidian',
  } as never);
}

describe('automatic mobile sync overlap notices', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  let oldNavigator: unknown;
  let oldMobile: boolean;

  beforeEach(() => {
    oldNavigator = g.navigator;
    oldMobile = Platform.isMobile;
    Platform.isMobile = true;
    Notice.instances.length = 0;
    g.navigator = { onLine: true, connection: { type: 'wifi' } };
  });

  afterEach(() => {
    g.navigator = oldNavigator;
    Platform.isMobile = oldMobile;
    Notice.instances.length = 0;
  });

  it('keeps an automatic busy overlap silent', async () => {
    const engine = makeEngine();
    (engine as unknown as { running: boolean }).running = true;

    await engine.syncManual();

    expect(Notice.instances).toHaveLength(0);
  });

  it('still explains a busy overlap when the user explicitly pressed Sync now', async () => {
    const engine = makeEngine();
    (engine as unknown as { running: boolean }).running = true;

    await engine.syncManual({ manual: true });

    expect(Notice.instances).toHaveLength(1);
    expect(Notice.instances[0].message).toMatch(/already in progress/i);
  });

  it('keeps an automatic Wi-Fi-only skip silent', async () => {
    g.navigator = { onLine: true, connection: { type: 'cellular' } };
    const engine = makeEngine({ syncOnWifiOnly: true });

    await engine.syncManual();

    expect(Notice.instances).toHaveLength(0);
  });

  it('still explains Wi-Fi-only when the user explicitly pressed Sync now', async () => {
    g.navigator = { onLine: true, connection: { type: 'cellular' } };
    const engine = makeEngine({ syncOnWifiOnly: true });

    await engine.syncManual({ manual: true });

    expect(Notice.instances).toHaveLength(1);
    expect(Notice.instances[0].message).toMatch(/cellular/i);
  });

  it('keeps Client Push busy fallback silent and retryable', async () => {
    const engine = makeEngine();
    (engine as unknown as { running: boolean }).running = true;

    await expect(engine.syncForClientPush()).resolves.toBe(false);
    expect(Notice.instances).toHaveLength(0);
  });
});

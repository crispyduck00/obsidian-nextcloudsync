import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../../src/types';

function makeEngine(): SyncEngine {
  return new SyncEngine({
    app: {},
    settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    localAdapter: {},
    stateDB: {},
    statusBar: {},
    webdavFactory: {},
    pluginDir: '',
    configDir: '.obsidian',
  } as never);
}

describe('SyncEngine.syncForWatchRecovery', () => {
  it('awaits an already-running authoritative full sync instead of starting a second one', async () => {
    const engine = makeEngine();
    const internals = engine as unknown as {
      currentRun: Promise<boolean> | null;
      syncManualWithResult: () => Promise<boolean>;
    };

    internals.currentRun = Promise.resolve(true);
    const startAnother = jest.fn(async () => true);
    internals.syncManualWithResult = startAnother;

    await expect(engine.syncForWatchRecovery()).resolves.toBe(true);
    expect(startAnother).not.toHaveBeenCalled();
  });

  it('starts a fresh full sync when structure changed during the already-running sync', async () => {
    const engine = makeEngine();
    const internals = engine as unknown as {
      currentRun: Promise<boolean> | null;
      syncManualWithResult: () => Promise<boolean>;
    };

    internals.currentRun = Promise.resolve(true);
    const freshFullSync = jest.fn(async () => true);
    internals.syncManualWithResult = freshFullSync;

    await expect(engine.syncForWatchRecovery(true)).resolves.toBe(true);
    expect(freshFullSync).toHaveBeenCalledTimes(1);
  });

  it('uses the ordinary full-sync path when no authoritative run is active', async () => {
    const engine = makeEngine();
    const internals = engine as unknown as {
      currentRun: Promise<boolean> | null;
      syncManualWithResult: () => Promise<boolean>;
    };

    internals.currentRun = null;
    const ordinaryFullSync = jest.fn(async () => true);
    internals.syncManualWithResult = ordinaryFullSync;

    await expect(engine.syncForWatchRecovery()).resolves.toBe(true);
    expect(ordinaryFullSync).toHaveBeenCalledTimes(1);
  });

  it('reports an active full-sync failure as incomplete recovery', async () => {
    const engine = makeEngine();
    const internals = engine as unknown as {
      currentRun: Promise<boolean> | null;
      syncManualWithResult: () => Promise<boolean>;
    };

    internals.currentRun = Promise.reject(new Error('full sync failed'));
    const startAnother = jest.fn(async () => true);
    internals.syncManualWithResult = startAnother;

    await expect(engine.syncForWatchRecovery()).resolves.toBe(false);
    expect(startAnother).not.toHaveBeenCalled();
  });
});

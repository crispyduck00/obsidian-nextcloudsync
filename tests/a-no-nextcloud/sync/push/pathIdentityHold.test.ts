import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { PushSyncScheduler } from '../../../../src/sync/push/PushSyncScheduler';
import { MobileWatchLifecycle } from '../../../../src/sync/watch/MobileWatchLifecycle';
import { assertUnambiguousLocalPaths, LocalPathIdentityError } from '../../../../src/sync/scan/localPathIdentity';
import { StateDB } from '../../../../src/data/StateDB';
import { DEFAULT_SETTINGS } from '../../../../src/types';
import { makeStateAdapter, PLUGIN_DIR } from '../../support/engineHarness';

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function host() {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'device');
  await stateDB.load();
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };
  const client = {};
  const localAdapter = { stat: jest.fn(async () => null) };
  const engine = new SyncEngine({ app: {}, localAdapter, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    stateDB, statusBar, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: '.obsidian' } as never);
  const inner = engine as unknown as {
    ensureClient(): Promise<unknown>; initialSync(): Promise<void>; drainWatchPending(): Promise<void>;
    lastSummary: { errorCount: number; errors: { message: string }[] };
  };
  jest.spyOn(inner, 'ensureClient').mockResolvedValue({ client });
  const guard = jest.spyOn(inner, 'initialSync').mockImplementation(async () => {
    await assertUnambiguousLocalPaths({
      stat: async () => ({ size: 4, mtime: 1 }),
      list: async () => ({ files: ['note.md'], folders: [] }),
    }, ['note.md'], ['Note.md']);
  });
  const drain = jest.spyOn(inner, 'drainWatchPending').mockResolvedValue();
  return { engine, inner, stateDB, statusBar, guard, drain, localAdapter };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('a proven naming hold consumes one Push hint, stays red and does not retry autonomously', async () => {
  const h = await host();
  const sync = jest.fn(async () => await h.engine.syncForClientPush() ? 'completed' as const : 'retry' as const);
  const scheduler = new PushSyncScheduler({
    isSyncRunning: () => h.engine.isSyncRunning(), sync, fullSyncQuietMs: 0,
  });
  scheduler.notify({ raw: 'notify_file', fileIds: ['remote-note-id'] });
  await jest.advanceTimersByTimeAsync(351);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(h.inner.lastSummary.errorCount).toBe(1);
  expect(h.inner.lastSummary.errors[0].message).toContain('differently spelled path');
  expect(h.statusBar.setSyncComplete).toHaveBeenLastCalledWith(0, 0, 0, 1);
  expect(h.stateDB.getRemoteRootEtag()).toBeNull();
  expect(scheduler.getStatus().pending).toBe(false);
  expect(h.drain).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(180_000);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(h.guard).toHaveBeenCalledTimes(1);
  // A new real hint remains eligible; the hold is not a global suppression latch.
  scheduler.notify({ raw: 'notify_file', fileIds: ['new-remote-id'] });
  await jest.advanceTimersByTimeAsync(351);
  expect(sync).toHaveBeenCalledTimes(2);
  scheduler.stop();
  await h.stateDB.flush();
});

test('an ordinary transport failure keeps the Push request and its bounded retry', async () => {
  const h = await host();
  h.guard.mockRejectedValue(new Error('HTTP transport is unavailable'));
  const sync = jest.fn(async () => await h.engine.syncForClientPush() ? 'completed' as const : 'retry' as const);
  const scheduler = new PushSyncScheduler({ isSyncRunning: () => h.engine.isSyncRunning(), sync, fullSyncQuietMs: 0 });
  scheduler.notify({ raw: 'notify_file', fileIds: ['remote-note-id'] });
  await jest.advanceTimersByTimeAsync(351);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(scheduler.getStatus().pending).toBe(true);
  await jest.advanceTimersByTimeAsync(5001);
  expect(sync).toHaveBeenCalledTimes(2);
  scheduler.stop();
  await h.stateDB.flush();
});

test('Mobile joining a held Push run receives incomplete recovery, never the Push-only consumed result', async () => {
  const h = await host();
  let fail!: () => void;
  h.guard.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
    fail = () => reject(new LocalPathIdentityError('Manual path repair needed'));
  }));
  const push = h.engine.syncForClientPush();
  await settle();
  const mobile = h.engine.syncForWatchRecovery();
  fail();
  await expect(push).resolves.toBe(true);
  await expect(mobile).resolves.toBe(false);
  expect(h.guard).toHaveBeenCalledTimes(1);
  expect(h.drain).not.toHaveBeenCalled();
  await h.stateDB.flush();
});

test('Mobile keeps queued edits behind structural uncertainty after a hold without creating a retry timer', async () => {
  const h = await host();
  const file = jest.fn(async () => true);
  const recover = jest.fn(async fresh => h.engine.syncForWatchRecovery(fresh));
  const mobile = new MobileWatchLifecycle({
    isEnabled: () => true, isVisible: () => true, canUseNetwork: () => true,
    syncFile: file, recoverStructural: recover,
  });
  mobile.queueFile('note.md');
  mobile.markStructuralDirty();
  mobile.onVisible();
  await settle();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(mobile.isStructuralDirty()).toBe(true);
  expect(mobile.pendingFileCount()).toBe(1);
  expect(file).not.toHaveBeenCalled();
  expect(h.drain).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(180_000);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(file).not.toHaveBeenCalled();
  await h.stateDB.flush();
});

test('manual repair allows the next full sync and deferred Watch drain normally', async () => {
  const h = await host();
  await expect(h.engine.syncForClientPush()).resolves.toBe(true);
  expect(h.inner.lastSummary.errorCount).toBe(1);
  h.guard.mockResolvedValue();
  await h.engine.syncManual({ manual: true });
  expect(h.inner.lastSummary.errorCount).toBe(0);
  expect(h.drain).toHaveBeenCalledTimes(1);
  await h.stateDB.flush();
});

test('a stopped run does not claim that Push work was consumed', async () => {
  const h = await host();
  h.guard.mockImplementationOnce(async () => {
    h.engine.requestStop();
    throw new LocalPathIdentityError('Manual path repair needed');
  });
  await expect(h.engine.syncForClientPush()).resolves.toBe(false);
  expect(h.drain).not.toHaveBeenCalled();
  await h.stateDB.flush();
});


test('a later blocked invocation cannot inherit an earlier consumed hold', async () => {
  const h = await host();
  await expect(h.engine.syncForClientPush()).resolves.toBe(true);
  jest.spyOn(h.engine, 'isSyncRunning').mockReturnValue(true);
  await expect(h.engine.syncForClientPush()).resolves.toBe(false);
  expect(h.guard).toHaveBeenCalledTimes(1);
  await h.stateDB.flush();
});


test('a file queued during the held full sync waits for a later successful reconciliation', async () => {
  const h = await host();
  h.drain.mockRestore();
  let fail!: () => void;
  h.guard.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
    fail = () => reject(new LocalPathIdentityError('Manual path repair needed'));
  }));
  const push = h.engine.syncForClientPush();
  await settle();
  await h.engine.syncSingleFile('note.md');
  expect(h.localAdapter.stat).not.toHaveBeenCalled();
  fail();
  await expect(push).resolves.toBe(true);
  expect(h.localAdapter.stat).not.toHaveBeenCalled();
  h.guard.mockResolvedValue();
  await h.engine.syncManual({ manual: true });
  expect(h.localAdapter.stat).toHaveBeenCalledWith('note.md');
  await h.stateDB.flush();
});

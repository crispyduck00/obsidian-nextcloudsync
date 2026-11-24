import Plugin from '../../../../src/main';
import { DEFAULT_SETTINGS } from '../../../../src/types';
import { openMirrorFromRemoteModal } from '../../../../src/ui/MirrorFromRemoteModal';

jest.mock('../../../../src/ui/MirrorFromRemoteModal', () => ({ openMirrorFromRemoteModal: jest.fn() }));

const modal = jest.mocked(openMirrorFromRemoteModal);
const changedRoot = { kind: 'targeted' as const, rootEtag: 'changed', rootFileId: 'root' };
const native = { fileIds: ['note-id'], raw: 'notify_file_id [note-id]' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function host() {
  const reconcile = jest.fn(async () => 'done');
  const ordinarySync = jest.fn(async () => true);
  const shouldSync = jest.fn(async () => changedRoot);
  const plugin = new Plugin({} as never, {} as never);
  // Exercise the actual host-created scheduler and modal lifecycle, without network or UI.
  const p = plugin as unknown as {
    settings: typeof DEFAULT_SETTINGS; logger: { log(): void }; mirrorInProgress: boolean;
    syncEngine: unknown; pushStatusItem: unknown; refreshMobileConflictStatus(): void;
    initClientPush(read: () => string): void; teardownClientPush(): void;
    pushSyncScheduler: { notify(hint: typeof native | { fileIds: null; raw: string }): void; getStatus(): { pending: boolean } };
  };
  p.settings = { ...DEFAULT_SETTINGS, serverUrl: 'http://127.0.0.1/remote.php/dav/files/test/', username: 'test', useClientPush: true };
  p.syncEngine = { canRunWatchSync: () => true, isSyncRunning: () => false,
    shouldReconcileClientPush: shouldSync, reconcileRemoteFileIds: reconcile, syncForClientPush: ordinarySync,
    resumeAfterRemoteMirror: jest.fn(async () => {}), stopAutoSync: jest.fn(), requestStop: jest.fn(), flushState: jest.fn(async () => {}) };
  p.logger = { log() {} };
  p.pushStatusItem = { pulse() {}, setStatus() {}, destroy() {} };
  p.refreshMobileConflictStatus = () => {};
  p.initClientPush(() => 'test-only-secret');
  return { plugin, p, reconcile, ordinarySync, shouldSync };
}

describe('Client Push while Mirror from remote is open', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  beforeEach(() => {
    jest.useFakeTimers();
    modal.mockReset();
    Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  test.each(['native', 'generic', 'resume'])('parks a %s event until the modal closes, then processes it once', async event => {
    const h = host(), closed = deferred<void>();
    if (event === 'generic') h.shouldSync.mockResolvedValue({ kind: 'full-sync' } as never);
    modal.mockImplementationOnce(() => closed.promise);
    const mirror = h.plugin.runRemoteMirror();
    try {
      if (event === 'resume') (h.p.pushSyncScheduler as unknown as { requestRemoteCatchUp(): void }).requestRemoteCatchUp();
      else h.p.pushSyncScheduler.notify(event === 'native' ? native : { fileIds: null, raw: 'notify_file' });
      await jest.advanceTimersByTimeAsync(12000);
      expect(h.shouldSync).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(h.ordinarySync).not.toHaveBeenCalled();
      expect(h.p.pushSyncScheduler.getStatus().pending).toBe(true);
      closed.resolve();
      await mirror;
      await jest.advanceTimersByTimeAsync(12000);
      expect(h.reconcile).toHaveBeenCalledTimes(event === 'native' ? 1 : 0);
      expect(h.ordinarySync).toHaveBeenCalledTimes(event === 'native' ? 0 : 1);
      expect(h.p.pushSyncScheduler.getStatus().pending).toBe(false);
    } finally { closed.resolve(); await mirror; h.p.teardownClientPush(); }
  });

  test('retains an in-flight scope result when the mirror opens before the read returns', async () => {
    const h = host(), closed = deferred<void>(), scope = deferred<typeof changedRoot>();
    h.shouldSync.mockImplementationOnce(() => scope.promise);
    modal.mockImplementationOnce(() => closed.promise);
    h.p.pushSyncScheduler.notify(native);
    await jest.advanceTimersByTimeAsync(350);
    expect(h.shouldSync).toHaveBeenCalledTimes(1);
    const mirror = h.plugin.runRemoteMirror();
    try {
      scope.resolve(changedRoot);
      await jest.advanceTimersByTimeAsync(12000);
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(h.p.pushSyncScheduler.getStatus().pending).toBe(true);
      closed.resolve();
      await mirror;
      await jest.advanceTimersByTimeAsync(12000);
      expect(h.reconcile).toHaveBeenCalledTimes(1);
      expect(h.ordinarySync).not.toHaveBeenCalled();
    } finally { scope.resolve(changedRoot); closed.resolve(); await mirror; h.p.teardownClientPush(); }
  });

  test('does not resume a disposed engine when Obsidian unloads with the modal open', async () => {
    const h = host(), closed = deferred<void>();
    const engine = h.p.syncEngine as { resumeAfterRemoteMirror: jest.Mock };
    modal.mockImplementationOnce(() => closed.promise);
    const mirror = h.plugin.runRemoteMirror();
    h.plugin.onunload();
    expect(h.p.syncEngine).toBeUndefined();
    closed.resolve();
    await mirror;
    expect(engine.resumeAfterRemoteMirror).not.toHaveBeenCalled();
  });

  test('wakes the current scheduler after the engine is replaced with the old modal still open', async () => {
    const h = host(), closed = deferred<void>();
    const original = h.p.syncEngine as { resumeAfterRemoteMirror: jest.Mock };
    const reconcile = jest.fn(async () => 'done');
    const replacement = { ...original, canRunWatchSync: () => true, isSyncRunning: () => false,
      shouldReconcileClientPush: async () => changedRoot, reconcileRemoteFileIds: reconcile,
      resumeAfterRemoteMirror: jest.fn(async () => {}) };
    modal.mockImplementationOnce(() => closed.promise);
    const mirror = h.plugin.runRemoteMirror();
    try {
      h.p.teardownClientPush();
      h.p.syncEngine = replacement;
      h.p.pushStatusItem = { pulse() {}, setStatus() {}, destroy() {} };
      h.p.initClientPush(() => 'test-only-secret');
      h.p.pushSyncScheduler.notify(native);
      await jest.advanceTimersByTimeAsync(12000);
      expect(reconcile).not.toHaveBeenCalled();
      closed.resolve();
      await mirror;
      await jest.advanceTimersByTimeAsync(12000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(original.resumeAfterRemoteMirror).not.toHaveBeenCalled();
      expect(replacement.resumeAfterRemoteMirror).not.toHaveBeenCalled();
    } finally { closed.resolve(); await mirror; h.p.teardownClientPush(); }
  });

  test('releases parked notifications when the modal fails', async () => {
    const h = host(), closed = deferred<void>();
    modal.mockImplementationOnce(() => closed.promise);
    const mirror = h.plugin.runRemoteMirror();
    try {
      h.p.pushSyncScheduler.notify(native);
      await jest.advanceTimersByTimeAsync(12000);
      expect(h.reconcile).not.toHaveBeenCalled();
      closed.reject(new Error('test preview failure'));
      await mirror;
      await jest.advanceTimersByTimeAsync(12000);
      expect(h.reconcile).toHaveBeenCalledTimes(1);
    } finally { h.p.teardownClientPush(); }
  });
});

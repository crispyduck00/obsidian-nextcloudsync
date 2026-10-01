import { MobileWatchLifecycle } from '../../../../src/sync/watch/MobileWatchLifecycle';

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  let enabled = true;
  let visible = true;
  let network = true;
  const syncFile = jest.fn(async (_path: string) => undefined);
  const recoverStructural = jest.fn(async () => true);
  const log = jest.fn();

  const lifecycle = new MobileWatchLifecycle({
    isEnabled: () => enabled,
    isVisible: () => visible,
    canUseNetwork: () => network,
    syncFile,
    recoverStructural,
    log,
  });

  return {
    lifecycle,
    syncFile,
    recoverStructural,
    log,
    setEnabled: (v: boolean) => { enabled = v; },
    setVisible: (v: boolean) => { visible = v; },
    setNetwork: (v: boolean) => { network = v; },
  };
}

describe('MobileWatchLifecycle', () => {
  it('deduplicates rapid edits and flushes the file once while visible', async () => {
    const h = harness();
    h.lifecycle.queueFile('note.md');
    h.lifecycle.queueFile('note.md');

    await h.lifecycle.flushFiles();
    await settle();

    expect(h.syncFile).toHaveBeenCalledTimes(1);
    expect(h.syncFile).toHaveBeenCalledWith('note.md');
    expect(h.lifecycle.pendingFileCount()).toBe(0);
  });

  it('does not start ordinary watch work while hidden', async () => {
    const h = harness();
    h.setVisible(false);
    h.lifecycle.queueFile('late.md');

    await h.lifecycle.flushFiles();

    expect(h.syncFile).not.toHaveBeenCalled();
    expect(h.lifecycle.pendingFileCount()).toBe(1);
  });

  it('gives pre-existing pending edits one best-effort hidden flush and keeps them for foreground retry', async () => {
    const h = harness();
    h.lifecycle.queueFile('quick-note.md');
    h.setVisible(false);

    h.lifecycle.onHidden();
    await settle();

    expect(h.syncFile).toHaveBeenCalledTimes(1);
    expect(h.syncFile).toHaveBeenCalledWith('quick-note.md');
    expect(h.lifecycle.pendingFileCount()).toBe(1);

    // A duplicate hidden event must not start a second background attempt.
    h.lifecycle.onHidden();
    await settle();
    expect(h.syncFile).toHaveBeenCalledTimes(1);

    h.setVisible(true);
    h.lifecycle.onVisible();
    await settle();

    expect(h.syncFile).toHaveBeenCalledTimes(2);
    expect(h.lifecycle.pendingFileCount()).toBe(0);
  });

  it('never starts a late file event that arrives after the app is already hidden', async () => {
    const h = harness();
    h.setVisible(false);
    h.lifecycle.onHidden(); // the one hidden-flush opportunity has already happened
    h.lifecycle.queueFile('saved-after-hidden.md');

    await h.lifecycle.flushFiles();
    await settle();
    expect(h.syncFile).not.toHaveBeenCalled();

    h.setVisible(true);
    h.lifecycle.onVisible();
    await settle();
    expect(h.syncFile).toHaveBeenCalledWith('saved-after-hidden.md');
  });

  it('re-queues a file that was in flight when Android hid the app', async () => {
    const h = harness();
    const first = deferred<void>();
    h.syncFile
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => undefined);

    h.lifecycle.queueFile('in-flight.md');
    await h.lifecycle.flushFiles();
    await settle();
    expect(h.syncFile).toHaveBeenCalledTimes(1);

    h.setVisible(false);
    h.lifecycle.onHidden();
    expect(h.lifecycle.pendingFileCount()).toBe(1);

    first.resolve();
    await settle();

    h.setVisible(true);
    h.lifecycle.onVisible();
    await settle();
    expect(h.syncFile).toHaveBeenCalledTimes(2);
  });

  it('retains file edits while Wi-Fi-only blocks the network and drains them when the network becomes allowed', async () => {
    const h = harness();
    h.setNetwork(false);
    h.lifecycle.queueFile('wifi.md');

    await h.lifecycle.flushFiles();
    expect(h.syncFile).not.toHaveBeenCalled();
    expect(h.lifecycle.pendingFileCount()).toBe(1);

    h.setNetwork(true);
    h.lifecycle.onNetworkChanged();
    await settle();

    expect(h.syncFile).toHaveBeenCalledWith('wifi.md');
    expect(h.lifecycle.pendingFileCount()).toBe(0);
  });

  it('does not use a network-change event to start new work while hidden', async () => {
    const h = harness();
    h.setNetwork(false);
    h.setVisible(false);
    h.lifecycle.queueFile('hidden-wifi.md');

    h.setNetwork(true);
    h.lifecycle.onNetworkChanged();
    await settle();
    expect(h.syncFile).not.toHaveBeenCalled();

    h.setVisible(true);
    h.lifecycle.onVisible();
    await settle();
    expect(h.syncFile).toHaveBeenCalledWith('hidden-wifi.md');
  });

  it('re-checks network policy between files in the same drained batch', async () => {
    const h = harness();
    h.lifecycle.queueFile('a.md');
    h.lifecycle.queueFile('b.md');
    h.syncFile.mockImplementation(async () => {
      h.setNetwork(false);
    });

    await h.lifecycle.flushFiles();
    await settle();

    expect(h.syncFile).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.pendingFileCount()).toBe(1);

    h.setNetwork(true);
    h.lifecycle.onNetworkChanged();
    await settle();
    expect(h.syncFile).toHaveBeenCalledTimes(2);
  });

  it('defers a hidden structural event to authoritative recovery instead of running it blindly', async () => {
    const h = harness();
    h.setVisible(false);
    const structuralWork = jest.fn(async () => undefined);

    const ran = await h.lifecycle.runStructural(structuralWork);

    expect(ran).toBe(false);
    expect(structuralWork).not.toHaveBeenCalled();
    expect(h.lifecycle.isStructuralDirty()).toBe(true);

    h.setVisible(true);
    h.lifecycle.onVisible();
    await settle();

    expect(h.recoverStructural).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.isStructuralDirty()).toBe(false);
  });

  it('Wi-Fi-blocked rename/delete/folder work becomes structural-dirty and waits for Wi-Fi', async () => {
    const h = harness();
    h.setNetwork(false);
    const structuralWork = jest.fn(async () => undefined);

    expect(await h.lifecycle.runStructural(structuralWork)).toBe(false);
    expect(structuralWork).not.toHaveBeenCalled();
    expect(h.lifecycle.isStructuralDirty()).toBe(true);

    h.setNetwork(true);
    h.lifecycle.onNetworkChanged();
    await settle();
    expect(h.recoverStructural).toHaveBeenCalledTimes(1);
  });

  it('marks structure dirty when the app hides during an in-flight structural operation', async () => {
    const h = harness();
    const op = deferred<void>();
    const running = h.lifecycle.runStructural(() => op.promise);
    await settle();

    h.setVisible(false);
    h.lifecycle.onHidden();

    expect(h.lifecycle.isStructuralDirty()).toBe(true);

    op.resolve();
    await running;

    h.setVisible(true);
    h.lifecycle.onVisible();
    await settle();
    expect(h.recoverStructural).toHaveBeenCalledTimes(1);
  });

  it('blocks queued file uploads behind structural recovery', async () => {
    const h = harness();
    h.lifecycle.markStructuralDirty('test');
    h.lifecycle.queueFile('after-rename.md');

    await h.lifecycle.flushFiles();
    expect(h.syncFile).not.toHaveBeenCalled();

    h.lifecycle.onVisible();
    await settle();

    expect(h.recoverStructural).toHaveBeenCalledTimes(1);
    expect(h.syncFile).toHaveBeenCalledWith('after-rename.md');
  });

  it('runs another authoritative recovery if structure changes during the first recovery', async () => {
    const h = harness();
    const first = deferred<boolean>();
    h.recoverStructural
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => true);

    h.lifecycle.markStructuralDirty('first');
    h.lifecycle.onVisible();
    await settle();
    expect(h.recoverStructural).toHaveBeenCalledTimes(1);

    h.lifecycle.markStructuralDirty('changed during recovery');
    first.resolve(true);
    await settle();
    await settle();

    expect(h.recoverStructural).toHaveBeenCalledTimes(2);
    expect(h.lifecycle.isStructuralDirty()).toBe(false);
  });

  it('requests a fresh-after-current recovery when the dirty marker came from a mid-sync event', async () => {
    const h = harness();

    h.lifecycle.markStructuralDirty('changed during full sync', true);
    h.lifecycle.onVisible();
    await settle();

    expect(h.recoverStructural).toHaveBeenCalledWith(true);
    expect(h.lifecycle.isStructuralDirty()).toBe(false);
  });

  it('keeps structural-dirty state when recovery does not complete', async () => {
    const h = harness();
    h.recoverStructural.mockResolvedValueOnce(false);

    h.lifecycle.markStructuralDirty('needs recovery');
    h.lifecycle.onVisible();
    await settle();

    expect(h.lifecycle.isStructuralDirty()).toBe(true);

    h.recoverStructural.mockResolvedValueOnce(true);
    h.lifecycle.onNetworkChanged();
    await settle();
    expect(h.lifecycle.isStructuralDirty()).toBe(false);
  });

  it('retains a file path when an unexpected sync rejection escapes the existing watch layer', async () => {
    const h = harness();
    h.syncFile.mockRejectedValueOnce(new Error('unexpected'));
    h.lifecycle.queueFile('retry-me.md');

    await h.lifecycle.flushFiles();
    await settle();

    expect(h.lifecycle.pendingFileCount()).toBe(1);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('retry-me.md'));
  });

  it('turns an unexpected structural rejection into authoritative recovery work', async () => {
    const h = harness();

    expect(await h.lifecycle.runStructural(async () => {
      throw new Error('move exploded');
    })).toBe(false);

    expect(h.lifecycle.isStructuralDirty()).toBe(true);
    h.lifecycle.onVisible();
    await settle();
    expect(h.recoverStructural).toHaveBeenCalledTimes(1);
  });

  it('turning watch off drops queued automatic work but does not require cancelling in-flight requests', async () => {
    const h = harness();
    h.lifecycle.queueFile('queued.md');
    h.setEnabled(false);

    await h.lifecycle.flushFiles();

    expect(h.syncFile).not.toHaveBeenCalled();
    expect(h.lifecycle.pendingFileCount()).toBe(0);
    expect(h.lifecycle.isStructuralDirty()).toBe(false);
  });

  it('takePendingFile supports edit-then-rename without leaving the old path queued', () => {
    const h = harness();
    h.lifecycle.queueFile('old.md');

    expect(h.lifecycle.takePendingFile('old.md')).toBe(true);
    expect(h.lifecycle.takePendingFile('old.md')).toBe(false);
    expect(h.lifecycle.pendingFileCount()).toBe(0);
  });
});

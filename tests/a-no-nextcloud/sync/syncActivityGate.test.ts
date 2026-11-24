import { SyncActivityGate } from '../../../src/sync/SyncActivityGate';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

const tick = () => Promise.resolve();

describe('SyncActivityGate', () => {
  it('allows lightweight operations to overlap', async () => {
    const gate = new SyncActivityGate();
    const release = deferred();
    let active = 0;
    let maxActive = 0;

    const run = () => gate.runShared(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active--;
    });

    const a = run();
    const b = run();
    await tick();
    expect(maxActive).toBe(2);

    release.resolve();
    await Promise.all([a, b]);
  });

  it('waits for active lightweight operations before starting a full sync', async () => {
    const gate = new SyncActivityGate();
    const releaseShared = deferred();
    const events: string[] = [];

    const shared = gate.runShared(async () => {
      events.push('shared-start');
      await releaseShared.promise;
      events.push('shared-end');
    });
    await tick();

    const exclusive = gate.runExclusive(async () => {
      events.push('full');
    });
    await tick();
    expect(events).toEqual(['shared-start']);

    releaseShared.resolve();
    await Promise.all([shared, exclusive]);
    expect(events).toEqual(['shared-start', 'shared-end', 'full']);
  });

  it('gives a waiting full sync priority over later lightweight operations', async () => {
    const gate = new SyncActivityGate();
    const releaseFirst = deferred();
    const releaseFull = deferred();
    const events: string[] = [];

    const first = gate.runShared(async () => {
      events.push('first-start');
      await releaseFirst.promise;
      events.push('first-end');
    });
    await tick();

    const full = gate.runExclusive(async () => {
      events.push('full-start');
      await releaseFull.promise;
      events.push('full-end');
    });
    const late = gate.runShared(async () => {
      events.push('late');
    });

    releaseFirst.resolve();
    await first;
    await tick();
    expect(events).toEqual(['first-start', 'first-end', 'full-start']);

    releaseFull.resolve();
    await Promise.all([full, late]);
    expect(events).toEqual(['first-start', 'first-end', 'full-start', 'full-end', 'late']);
  });

  it('releases shared and exclusive slots when an operation throws', async () => {
    const gate = new SyncActivityGate();

    await expect(gate.runShared(async () => { throw new Error('shared'); })).rejects.toThrow('shared');
    await expect(gate.runExclusive(async () => { throw new Error('full'); })).rejects.toThrow('full');

    await expect(gate.runShared(async () => 42)).resolves.toBe(42);
  });
});

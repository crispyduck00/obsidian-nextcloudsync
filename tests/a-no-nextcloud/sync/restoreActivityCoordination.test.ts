import { buildEngine, makeLocalAdapter } from '../support/engineHarness';
const turn = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

it('waits for Restore before starting a full sync', async () => {
  const { engine } = await buildEngine(makeLocalAdapter({}), {});
  let release!: () => void;
  const restore = jest.fn(() => new Promise<void>((r) => { release = r; }));
  const run = jest.fn(async () => { Object.assign(engine, { running: false }); });
  Object.assign(engine, { features: {}, versions: { restoreVersion: restore }, runSyncSession: run });
  const restoring = engine.restoreVersion('note.md', {} as never);
  await turn();
  expect(restore).toHaveBeenCalledTimes(1);
  const syncing = engine.syncManual();
  await turn();
  expect(run).not.toHaveBeenCalled();
  release();
  await Promise.all([restoring, syncing]);
  expect(run).toHaveBeenCalledTimes(1);
});

it('waits for a full sync before Restore enters its server/local write path', async () => {
  const { engine } = await buildEngine(makeLocalAdapter({}), {});
  let release!: () => void;
  const run = jest.fn(async () => { await new Promise<void>((r) => { release = r; }); Object.assign(engine, { running: false }); });
  const restore = jest.fn(async () => undefined);
  Object.assign(engine, { features: {}, versions: { restoreVersion: restore }, runSyncSession: run });
  const syncing = engine.syncManual();
  await turn();
  const restoring = engine.restoreVersion('note.md', {} as never);
  await turn();
  expect(restore).not.toHaveBeenCalled();
  release();
  await Promise.all([syncing, restoring]);
  expect(restore).toHaveBeenCalledTimes(1);
});

it('waits for an in-flight Restore before maintenance resets the index', async () => {
  const { engine, stateDB } = await buildEngine(makeLocalAdapter({}), {});
  let release!: () => void;
  Object.assign(engine, { features: {}, versions: { restoreVersion: () => new Promise<void>((r) => { release = r; }) } });
  const reset = jest.spyOn(stateDB, 'reset');
  const restoring = engine.restoreVersion('note.md', {} as never);
  await turn();
  const resetting = engine.resetIndex();
  await turn();
  expect(reset).not.toHaveBeenCalled();
  release();
  await Promise.all([restoring, resetting]);
  expect(reset).toHaveBeenCalledTimes(1);
});

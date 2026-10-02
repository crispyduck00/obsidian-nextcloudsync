import { DataAdapter } from 'obsidian';
import { StateDB } from '../../../src/data/StateDB';

const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const DEVICE_ID = 'dev-rename';

function makeAdapter(seed: Record<string, string> = {}): DataAdapter {
  const store = { ...seed };
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (from: string, to: string) => {
      store[to] = store[from];
      delete store[from];
    }),
    stat: jest.fn(),
    list: jest.fn(),
    readBinary: jest.fn(),
    writeBinary: jest.fn(),
  } as unknown as DataAdapter;
}

describe('StateDB pending rename recovery', () => {
  it('persists a pending file MOVE across reload', async () => {
    const adapter = makeAdapter();
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();

    db.rememberPendingRename({
      oldPath: 'A/note.md', newPath: 'B/note.md', kind: 'file', recordedAt: 10,
    });
    await db.save();

    const reloaded = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await reloaded.load();

    expect(reloaded.getPendingRenames()).toEqual([
      { oldPath: 'A/note.md', newPath: 'B/note.md', kind: 'file', recordedAt: 10 },
    ]);
    expect(reloaded.isPendingRenamePath('A/note.md')).toBe(true);
    expect(reloaded.isPendingRenamePath('B/note.md')).toBe(true);
  });

  it('coalesces a rename chain and cancels a rename back to the original path', async () => {
    const db = new StateDB(makeAdapter(), PLUGIN_DIR, DEVICE_ID);
    await db.load();

    db.rememberPendingRename({ oldPath: 'A.md', newPath: 'B.md', kind: 'file', recordedAt: 1 });
    db.rememberPendingRename({ oldPath: 'B.md', newPath: 'C.md', kind: 'file', recordedAt: 2 });
    expect(db.getPendingRenames()).toEqual([
      { oldPath: 'A.md', newPath: 'C.md', kind: 'file', recordedAt: 1 },
    ]);

    db.rememberPendingRename({ oldPath: 'C.md', newPath: 'A.md', kind: 'file', recordedAt: 3 });
    expect(db.getPendingRenames()).toEqual([]);
  });

  it('lets a folder intent subsume matching child rename events in either order', async () => {
    const db = new StateDB(makeAdapter(), PLUGIN_DIR, DEVICE_ID);
    await db.load();

    db.rememberPendingRename({
      oldPath: 'Old/child.md', newPath: 'New/child.md', kind: 'file', recordedAt: 1,
    });
    db.rememberPendingRename({
      oldPath: 'Old', newPath: 'New', kind: 'folder', recordedAt: 2,
    });

    expect(db.getPendingRenames()).toEqual([
      { oldPath: 'Old', newPath: 'New', kind: 'folder', recordedAt: 2 },
    ]);
    expect(db.isPendingRenamePath('Old/deep/x.md')).toBe(true);
    expect(db.isPendingRenamePath('New/deep/x.md')).toBe(true);

    db.rememberPendingRename({
      oldPath: 'Old/another.md', newPath: 'New/another.md', kind: 'file', recordedAt: 3,
    });
    expect(db.getPendingRenames()).toHaveLength(1);
  });

  it('remaps tracked directory rows for a successful collection MOVE', async () => {
    const db = new StateDB(makeAdapter(), PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setDir({ path: 'Old', remoteFileId: 'd1' });
    db.setDir({ path: 'Old/Sub', remoteFileId: 'd2' });
    db.setDir({ path: 'Sibling', remoteFileId: 'd3' });

    db.moveDirSubtree('Old', 'New');

    expect(db.getDir('Old')).toBeUndefined();
    expect(db.getDir('Old/Sub')).toBeUndefined();
    expect(db.getDir('New')).toEqual({ path: 'New', remoteFileId: 'd1' });
    expect(db.getDir('New/Sub')).toEqual({ path: 'New/Sub', remoteFileId: 'd2' });
    expect(db.getDir('Sibling')).toEqual({ path: 'Sibling', remoteFileId: 'd3' });
  });

  it('reset clears pending rename intents', async () => {
    const db = new StateDB(makeAdapter(), PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.rememberPendingRename({ oldPath: 'A', newPath: 'B', kind: 'folder', recordedAt: 1 });

    await db.reset();

    expect(db.getPendingRenames()).toEqual([]);
  });
});

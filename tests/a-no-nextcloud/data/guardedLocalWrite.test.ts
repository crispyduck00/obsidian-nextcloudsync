import { link, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileView, type DataAdapter, type TFile, type Vault, type Workspace } from 'obsidian';
import { LocalAdapter, LocalFileChangedError, tmpPathFor } from '../../../src/data/LocalAdapter';
import { sha256 } from '../../../src/util/hash';

const note = 'Project/Deep/Note.md';
const incoming = 'incoming server version';
const draft = 'locally saved after classification';
const tmp = tmpPathFor(note);
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;
type Hook = (path: string, destination?: string) => Promise<void>;

async function diskFixture() {
  const root = await mkdtemp(join(tmpdir(), 'fns-guarded-write-'));
  const absolute = (path: string): string => join(root, path);
  const statPath = async (path: string) => {
    try {
      const file = await stat(absolute(path));
      return { type: file.isDirectory() ? 'folder' : 'file', size: file.size, mtime: file.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  const rename = jest.fn(async (source: string, destination: string) => {
    await hooks.beforeRename?.(source, destination);
    // The collision-checked DataAdapter rename, using a real, exclusive filesystem operation.
    await link(absolute(source), absolute(destination));
    await unlink(absolute(source));
  });
  const writeBinary = jest.fn(async (path: string, body: ArrayBuffer) => {
    await writeFile(absolute(path), Buffer.from(body));
    await hooks.afterWrite?.(path);
  });
  const hooks: { beforeRename?: Hook; afterWrite?: Hook } = {};
  const adapter = {
    stat: statPath,
    exists: async (path: string) => (await statPath(path)) !== null,
    mkdir: async (path: string) => { await mkdir(absolute(path), { recursive: true }); },
    writeBinary,
    readBinary: async (path: string) => new Uint8Array(await readFile(absolute(path))).buffer,
    remove: jest.fn(async (path: string) => { await rm(absolute(path)); }),
    rename,
  } as unknown as DataAdapter;
  const local = new LocalAdapter(adapter);
  await adapter.mkdir('Project/Deep');
  const write = async (content: string) => { await writeFile(absolute(note), content); };
  const read = (path = note) => readFile(absolute(path), 'utf8');
  const remember = async (content: string) => {
    await write(content);
    await utimes(absolute(note), 1600000000, 1600000000);
    return { stat: (await local.stat(note))!, hash: await sha256(bytes(content)) };
  };
  const dispose = async () => {
    local.dispose();
    await rm(root, { force: true, recursive: true });
  };
  return { adapter, local, absolute, read, write, remember, dispose, hooks };
}

describe('Guarded local file publication', () => {
  it.each(['temporary write', 'publication'])('keeps a new file saved during %s', async phase => {
    const disk = await diskFixture();
    try {
      if (phase === 'temporary write') {
        disk.hooks.afterWrite = async path => { if (path === tmp) await disk.write(draft); };
      } else {
        disk.hooks.beforeRename = async path => { if (path === tmp) await disk.write(draft); };
      }
      await expect(disk.local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, { stat: null }))
        .rejects.toBeInstanceOf(LocalFileChangedError);
      expect(await disk.read()).toBe(draft);
      expect(disk.adapter.remove).not.toHaveBeenCalledWith(note);
      expect(await disk.adapter.exists(tmp)).toBe(false);
    } finally { await disk.dispose(); }
  });

  it('restores an edit with the same mtime and size right before moving the old file aside', async () => {
    const disk = await diskFixture();
    try {
      const expected = await disk.remember('old note');
      disk.hooks.beforeRename = async path => {
        if (path !== note) return;
        await disk.write('new note');
        await utimes(disk.absolute(note), 1600000000, 1600000000);
      };
      await expect(disk.local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, expected))
        .rejects.toBeInstanceOf(LocalFileChangedError);
      expect(await disk.read()).toBe('new note');
      expect(disk.adapter.remove).not.toHaveBeenCalledWith(note);
    } finally { await disk.dispose(); }
  });

  it('retains a folder created at the destination during preparation', async () => {
    const disk = await diskFixture();
    try {
      disk.hooks.afterWrite = async path => { if (path === tmp) await disk.adapter.mkdir(note + '/Child'); };
      await expect(disk.local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, { stat: null }))
        .rejects.toBeInstanceOf(LocalFileChangedError);
      expect(await disk.adapter.exists(note + '/Child')).toBe(true);
      expect(disk.adapter.remove).not.toHaveBeenCalledWith(note);
    } finally { await disk.dispose(); }
  });

  it('never replaces a proven existing file with a truncated staged write', async () => {
    const disk = await diskFixture();
    try {
      const expected = await disk.remember('last synced body');
      disk.hooks.afterWrite = async path => { if (path === tmp) await writeFile(disk.absolute(tmp), 'bad'); };
      await expect(disk.local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, expected))
        .rejects.toThrow('write-back verification failed');
      expect(await disk.read()).toBe('last synced body');
      expect(disk.adapter.rename).not.toHaveBeenCalled();
    } finally { await disk.dispose(); }
  });

  it('rolls back a failed publication without asking the sync engine to treat it as a deletion', async () => {
    const disk = await diskFixture();
    try {
      const expected = await disk.remember('common baseline');
      disk.hooks.beforeRename = async path => { if (path === tmp) throw new Error('volume write failure'); };
      await expect(disk.local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, expected))
        .rejects.toThrow('volume write failure');
      expect(await disk.read()).toBe('common baseline');
      expect(await disk.adapter.exists(tmp)).toBe(false);
    } finally { await disk.dispose(); }
  });

  it('recovers a parked previous copy after a restart with a vacant target', async () => {
    const disk = await diskFixture();
    const restarted = new LocalAdapter(disk.adapter);
    try {
      const expected = await disk.remember('recoverable prior body');
      disk.hooks.beforeRename = async path => { if (path !== note) throw new Error('mount unavailable'); };
      let saved: string | undefined;
      try {
        await disk.local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, expected);
        throw new Error('Expected recovery to be needed');
      } catch (err) {
        if (!(err instanceof LocalFileChangedError)) throw err;
        saved = err.retainedCopy;
      }
      expect(saved).toBeTruthy();
      expect(await disk.adapter.exists(note)).toBe(false);
      expect(await disk.read(saved)).toBe('recoverable prior body');
      await restarted.removeTmp(saved!);
      expect(await disk.read(saved)).toBe('recoverable prior body');

      delete disk.hooks.beforeRename;
      expect(await restarted.stat(note)).toMatchObject({ size: expected.stat.size });
      expect(await disk.read()).toBe('recoverable prior body');
      expect(await disk.adapter.exists(saved!)).toBe(false);
    } finally {
      restarted.dispose();
      await disk.dispose();
    }
  });

  it('leaves both copies recoverable when a new target makes rollback unsafe', async () => {
    const disk = await diskFixture();
    try {
      const expected = await disk.remember('previous local revision');
      disk.hooks.beforeRename = async path => { if (path === tmp) await disk.write(draft); };
      try {
        await disk.local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, expected);
        throw new Error('Expected the new local file to block publication');
      } catch (err) {
        if (!(err instanceof LocalFileChangedError)) throw err;
        expect(await disk.read(err.retainedCopy)).toBe('previous local revision');
      }
      expect(await disk.read()).toBe(draft);
      expect(disk.adapter.remove).not.toHaveBeenCalledWith(note);
    } finally { await disk.dispose(); }
  });

  it.each([false, true])('uses Vault.process for an open UTF-8 note with concurrent edit=%s', async changed => {
    const disk = await diskFixture();
    const previous = '\uFEFFfirst line\r\n';
    const updated = '\uFEFFremote line\r\n';
    const file = { path: note, extension: 'md' } as TFile;
    const view = Object.assign(Object.create(FileView.prototype) as FileView, { file });
    const workspace = { iterateAllLeaves: (visit: (leaf: { view: FileView }) => void) => visit({ view }) } as unknown as Workspace;
    const vault = {
      process: async (_file: TFile, process: (current: string) => string) => {
        if (changed) await disk.write(draft);
        await disk.write(process(await disk.read()));
      },
    } as unknown as Vault;
    const local = new LocalAdapter(disk.adapter, vault, workspace);
    try {
      const expected = await disk.remember(previous);
      if (changed) {
        await expect(local.atomicWriteBinary(note, bytes(updated), undefined, undefined, expected))
          .rejects.toBeInstanceOf(LocalFileChangedError);
      } else {
        await local.atomicWriteBinary(note, bytes(updated), undefined, undefined, expected);
      }
      expect(await disk.read()).toBe(changed ? draft : updated);
      expect(disk.adapter.rename).not.toHaveBeenCalled();
    } finally {
      local.dispose();
      await disk.dispose();
    }
  });
});

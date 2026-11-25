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
  it.each([
    ['active', false], ['active', true], ['deferred', false], ['deferred', true],
  ] as const)('holds an open %s binary before any unsafe write (binary original=%s)', async (leaf, binaryOriginal) => {
    const disk = await diskFixture();
    const original = binaryOriginal ? new Uint8Array([255, 0, 128]).buffer : bytes('original text');
    const updated = binaryOriginal ? bytes('incoming text') : new Uint8Array([255, 1, 128]).buffer;
    const file = { path: note } as TFile;
    const view = Object.create(FileView.prototype) as FileView;
    view.file = file;
    let open = true;
    const workspace = { iterateAllLeaves: (fn: (item: unknown) => void) => {
      if (open) fn(leaf === 'active' ? { view } : { view: {}, isDeferred: true, getViewState: () => ({ state: { file: note } }) });
    } } as unknown as Workspace;
    const modifyBinary = jest.fn(async () => { await disk.write('partial'); throw new Error('ENOSPC'); });
    const vault = { getAbstractFileByPath: () => file, getFileByPath: () => file, modifyBinary } as unknown as Vault;
    const local = new LocalAdapter(disk.adapter, vault, workspace);
    try {
      await writeFile(disk.absolute(note), Buffer.from(original));
      const expected = { stat: (await local.stat(note))!, hash: await sha256(original), beforeCommit: jest.fn() };
      await expect(local.atomicWriteBinary(note, updated, undefined, undefined, expected)).rejects.toMatchObject({
        requiresManualResolution: true, message: expect.stringContaining('Close'),
      });
      expect(await disk.adapter.readBinary(note)).toEqual(original);
      expect(modifyBinary).not.toHaveBeenCalled();
      expect(disk.adapter.writeBinary).not.toHaveBeenCalled();
      expect(expected.beforeCommit).not.toHaveBeenCalled();
      // Closing the preview reuses the ordinary guarded replacement; no new queue/state is needed.
      open = false;
      await local.atomicWriteBinary(note, updated, undefined, undefined, expected);
      expect(await disk.adapter.readBinary(note)).toEqual(updated);
      expect(expected.beforeCommit).toHaveBeenCalledTimes(1);
    } finally { local.dispose(); await disk.dispose(); }
  });

  it.each(['text', 'binary'] as const)('updates a closed UTF-8 file without renaming the indexed note (%s)', async mode => {
    const disk = await diskFixture();
    const previous = '\uFEFFfirst line\r\n', updated = '\uFEFFremote line\r\n';
    disk.adapter.process = jest.fn(async (_path, transform) => {
      const result = transform(await disk.read());
      await disk.write(result);
      return result;
    });
    try {
      const expected = await disk.remember(previous);
      if (mode === 'text') await disk.local.atomicWrite(note, updated, undefined, undefined, expected);
      else await disk.local.atomicWriteBinary(note, bytes(updated), undefined, undefined, expected);
      expect(await disk.read()).toBe(updated);
      expect(disk.adapter.process).toHaveBeenCalledTimes(1);
      expect(disk.adapter.rename).not.toHaveBeenCalled();
      expect(await disk.adapter.exists('Project/Deep/.Note.md.ncs.previous.ncs.tmp')).toBe(false);
    } finally { await disk.dispose(); }
  });

  it.each(['edit', 'editor', 'rename'] as const)('keeps a local %s arriving at the atomic text callback', async change => {
    const disk = await diskFixture();
    const file = { path: note } as TFile;
    const local = new LocalAdapter(disk.adapter, { getAbstractFileByPath: () => file } as unknown as Vault);
    let canWrite = true;
    const beforeCommit = jest.fn();
    disk.adapter.process = jest.fn(async (_path, transform) => {
      if (change === 'edit') await disk.write(draft);
      if (change === 'editor') canWrite = false;
      if (change === 'rename') file.path = 'Project/Elsewhere.md';
      const result = transform(await disk.read());
      await disk.write(result);
      return result;
    });
    try {
      const expected = { ...await disk.remember('common baseline'), canWrite: () => canWrite, beforeCommit };
      await expect(local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, expected)).rejects.toBeInstanceOf(LocalFileChangedError);
      expect(await disk.read()).toBe(change === 'edit' ? draft : 'common baseline');
      expect(beforeCommit).not.toHaveBeenCalled();
      expect(disk.adapter.rename).not.toHaveBeenCalled();
      expect(await disk.adapter.exists('Project/Deep/.Note.md.ncs.previous.ncs.tmp')).toBe(false);
    } finally { local.dispose(); await disk.dispose(); }
  });

  it.each(['reject', 'truncate', 'remove', 'silent truncation'] as const)('keeps recovery bytes after an in-place write can %s', async failure => {
    const disk = await diskFixture();
    const restarted = new LocalAdapter(disk.adapter);
    disk.adapter.process = jest.fn(async (_path, transform) => {
      const result = transform(await disk.read());
      if (failure === 'remove') await disk.adapter.remove(note);
      if (failure === 'truncate' || failure === 'silent truncation') await disk.write(result.slice(0, 3));
      if (failure !== 'silent truncation') throw new Error('volume write failure');
      return result;
    });
    try {
      const expected = await disk.remember('recoverable original');
      let retained: string | undefined;
      try {
        await disk.local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, expected);
        throw new Error('The broken write was accepted');
      } catch (err) {
        if (!(err instanceof LocalFileChangedError)) throw err;
        expect(err.requiresManualResolution).toBe(true);
        retained = err.retainedCopy;
      }
      expect(retained).toBeTruthy();
      expect(await disk.read(retained)).toBe('recoverable original');
      if (failure === 'remove') {
        expect(await restarted.stat(note)).not.toBeNull();
        expect(await disk.read()).toBe('recoverable original');
      } else {
        await expect(restarted.stat(note)).rejects.toMatchObject({ retainedCopy: retained, requiresManualResolution: true });
        expect(await disk.read()).toBe(failure === 'reject' ? 'recoverable original' : incoming.slice(0, 3));
      }
    } finally { restarted.dispose(); await disk.dispose(); }
  });

  it('rejects a damaged recovery snapshot before changing the note', async () => {
    const disk = await diskFixture();
    disk.adapter.process = jest.fn();
    disk.hooks.afterWrite = async path => { if (path.endsWith('.ncs.previous.ncs.tmp')) await writeFile(disk.absolute(path), 'broken'); };
    try {
      const expected = await disk.remember('original');
      await expect(disk.local.atomicWriteBinary(note, bytes(incoming), undefined, undefined, expected)).rejects.toThrow('Recovery copy verification failed');
      expect(await disk.read()).toBe('original');
      expect(disk.adapter.process).not.toHaveBeenCalled();
      expect(await disk.adapter.exists('Project/Deep/.Note.md.ncs.previous.ncs.tmp')).toBe(false);
    } finally { await disk.dispose(); }
  });

  it.each([false, true])('keeps non-UTF-8 data on the binary replacement path (original=%s)', async originalBinary => {
    const disk = await diskFixture();
    const original = originalBinary ? new Uint8Array([255, 0, 128]).buffer : bytes('original');
    const updated = originalBinary ? bytes('remote') : new Uint8Array([255, 1, 128]).buffer;
    disk.adapter.process = jest.fn();
    try {
      await writeFile(disk.absolute(note), Buffer.from(original));
      const expected = { stat: (await disk.local.stat(note))!, hash: await sha256(original) };
      await disk.local.atomicWriteBinary(note, updated, undefined, undefined, expected);
      expect(new Uint8Array(await disk.adapter.readBinary(note))).toEqual(new Uint8Array(updated));
      expect(disk.adapter.process).not.toHaveBeenCalled();
      expect(disk.adapter.rename).toHaveBeenCalled();
    } finally { await disk.dispose(); }
  });

  it('keeps same-basename binary attachments independent during parallel replacement', async () => {
    const disk = await diskFixture();
    const paths = ['Project/Deep/Note.png', 'Project/Deep/Note.pdf'];
    const original = new Uint8Array([255, 0, 1]).buffer, updated = new Uint8Array([255, 3, 4, 5]).buffer;
    try {
      for (const path of paths) await writeFile(disk.absolute(path), Buffer.from(original));
      await Promise.all(paths.map(async path => disk.local.atomicWriteBinary(path, updated, undefined, undefined, {
        stat: await disk.local.stat(path), hash: await sha256(original),
      })));
      for (const path of paths) expect(new Uint8Array(await disk.adapter.readBinary(path))).toEqual(new Uint8Array(updated));
      const backups = (disk.adapter.rename as jest.Mock).mock.calls.filter(([from]) => paths.includes(from));
      expect(backups.map(([, to]) => to).sort()).toEqual(['Project/Deep/Note.ncs-previous-1-pdf', 'Project/Deep/Note.ncs-previous-1-png']);
    } finally { await disk.dispose(); }
  });

  it.each(['Project/Deep/.Note.md.ncs.previous.ncs.tmp', 'Project/Deep/Note.ncs-previous-1-md'])('recovers and protects the retained copy %s', async copy => {
    const disk = await diskFixture();
    try {
      await writeFile(disk.absolute(copy), 'recoverable bytes');
      await disk.local.removeTmp(copy);
      expect(await disk.adapter.exists(copy)).toBe(true);
      expect(await disk.local.stat(note)).not.toBeNull();
      expect(await disk.read()).toBe('recoverable bytes');
    } finally { await disk.dispose(); }
  });

  it('requires a manual choice when both recovery formats exist', async () => {
    const disk = await diskFixture();
    const copies = ['Project/Deep/.Note.md.ncs.previous.ncs.tmp', 'Project/Deep/Note.ncs-previous-1-md'];
    try {
      for (let index = 0; index < copies.length; index++) await writeFile(disk.absolute(copies[index]), `copy ${index}`);
      await expect(disk.local.stat(note)).rejects.toMatchObject({ requiresManualResolution: true });
      expect(disk.adapter.rename).not.toHaveBeenCalled();
      for (let index = 0; index < copies.length; index++) expect(await disk.read(copies[index])).toBe(`copy ${index}`);
    } finally { await disk.dispose(); }
  });

  it('holds an existing long binary filename before an unsafe backup rename', async () => {
    const disk = await diskFixture();
    const path = 'Project/Deep/' + 'x'.repeat(247) + '.png';
    const original = new Uint8Array([255, 0]).buffer, updated = new Uint8Array([255, 1]).buffer;
    try {
      await writeFile(disk.absolute(path), Buffer.from(original));
      await expect(disk.local.atomicWriteBinary(path, updated, undefined, undefined, {
        stat: await disk.local.stat(path), hash: await sha256(original),
      })).rejects.toMatchObject({ requiresManualResolution: true });
      expect(new Uint8Array(await disk.adapter.readBinary(path))).toEqual(new Uint8Array(original));
      expect(disk.adapter.rename).not.toHaveBeenCalled();
      expect(await disk.adapter.exists(tmpPathFor(path))).toBe(false);
    } finally { await disk.dispose(); }
  });

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

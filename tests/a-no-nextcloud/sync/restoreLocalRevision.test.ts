import type { DataAdapter } from 'obsidian';
import { LocalAdapter, LocalFileChangedError, tmpPathFor } from '../../../src/data/LocalAdapter';
import { VersionService } from '../../../src/sync/versions/VersionService';
import { sha256 } from '../../../src/util/hash';
import type { FileState, FileVersion, NextcloudFeatures } from '../../../src/types';
import type { IWebDAVClient } from '../../../src/network/IWebDAVClient';

const path = 'note.md';
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;
const features = { isNextcloud: true, hasAccountDav: true } as NextcloudFeatures;
const version = { versionId: 'old' } as FileVersion;

async function fixture() {
  const files = new Map([[path, bytes('base')]]);
  const mtime = 1700000000000;
  const hooks: { staged?: () => void } = {};
  const adapter = {
    stat: async (name: string) => files.has(name) ? { type: 'file', size: files.get(name)!.byteLength, mtime } : null,
    exists: async (name: string) => files.has(name),
    readBinary: async (name: string) => files.get(name)!.slice(0),
    writeBinary: async (name: string, data: ArrayBuffer) => {
      files.set(name, data.slice(0));
      if (name === tmpPathFor(path)) hooks.staged?.();
    },
    rename: async (from: string, to: string) => {
      if (files.has(to)) throw new Error('Destination exists');
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    remove: async (name: string) => { files.delete(name); },
  } as unknown as DataAdapter;
  const local = new LocalAdapter(adapter);
  const originalHash = await sha256(bytes('base'));
  let state: FileState = { path, localHash: originalHash, remoteId: originalHash, idType: 'sha256', size: 4,
    mtime, remoteFileId: '42', isConflicted: false, localMtime: mtime, localSize: 4 };
  const save = jest.fn(async () => undefined);
  let writable = true;
  const client = { restoreVersion: jest.fn(async () => undefined), downloadFile: jest.fn(async () => bytes('restored')),
    statFile: jest.fn(async () => ({ path, fileId: '42', checksum: null, etag: 'restored-etag', size: 8, lastModified: 1, creationTime: 0 })) };
  const service = new VersionService({ localAdapter: local,
    stateDB: { getFile: () => state, setFile: value => { state = value; }, save, setRemoteRootEtag: () => undefined },
    canApplyRestore: () => writable });
  const restore = () => service.restoreVersion(client as unknown as IWebDAVClient, features, path, version);
  return { files, local, state: () => state, originalHash, save, client, hooks, restore,
    setWritable: (value: boolean) => { writable = value; },
    read: () => new TextDecoder().decode(files.get(path)) };
}

test.each(['server restore', 'download', 'staging'])('keeps a same-stat local edit during %s', async phase => {
  const f = await fixture();
  const edit = () => { f.files.set(path, bytes('edit')); };
  if (phase === 'server restore') f.client.restoreVersion.mockImplementationOnce(async () => { edit(); return undefined; });
  if (phase === 'download') f.client.downloadFile.mockImplementationOnce(async () => { edit(); return bytes('restored'); });
  if (phase === 'staging') f.hooks.staged = edit;
  try {
    await expect(f.restore()).rejects.toThrow('the local edit was kept');
    expect(f.read()).toBe('edit');
    expect(f.state().localHash).toBe(f.originalHash);
    expect(f.state().localMtime).toBeUndefined();
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.files.has(tmpPathFor(path))).toBe(false);
  } finally { f.local.dispose(); }
});

test('does not restore remotely while the editor forbids a local write', async () => {
  const f = await fixture();
  try {
    f.setWritable(false);
    await expect(f.restore()).rejects.toBeInstanceOf(LocalFileChangedError);
    expect(f.client.restoreVersion).not.toHaveBeenCalled();
    expect(f.read()).toBe('base');
  } finally { f.local.dispose(); }
});

test('a successful restore tracks the committed bytes without trusting a later stat', async () => {
  const f = await fixture();
  const commit = f.local.atomicWriteBinary.bind(f.local);
  jest.spyOn(f.local, 'atomicWriteBinary').mockImplementationOnce(async (...args) => {
    const result = await commit(...args);
    f.files.set(path, bytes('subsequent editor save'));
    return result;
  });
  try {
    await f.restore();
    expect(f.read()).toBe('subsequent editor save');
    expect(f.state().localHash).toBe(await sha256(bytes('restored')));
    expect(f.state().localMtime).toBeUndefined();
    expect(f.state().localSize).toBeUndefined();
  } finally { f.local.dispose(); }
});

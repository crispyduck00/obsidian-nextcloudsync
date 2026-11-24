import { FileState } from '../types';
import { LocalAdapter, type LocalStat } from './LocalAdapter';
import type { StateDB } from './StateDB';
import { SIGNATURE_SAFETY_WINDOW_MS } from '../util/limits';
import { sha256 } from '../util/hash';

export function withinSafetyWindow(mtime: number, ref: number): boolean {
  return Math.abs(ref - mtime) < SIGNATURE_SAFETY_WINDOW_MS;
}

// A second same-size save can retain this mtime until the filesystem's timestamp tick advances.
// Preserve the mtime for rename inference, but require a hash before accepting it as a content signature.
export function localReadSignature(stat: LocalStat, observedAt: number, bytesRead: number): Pick<FileState, 'localMtime' | 'localSize'> {
  return { localMtime: stat.mtime, localSize: bytesRead === stat.size && !withinSafetyWindow(stat.mtime, observedAt) ? stat.size : undefined };
}

export async function hashLocalFile(
  adapter: Pick<LocalAdapter, 'readBinary'>, state: Pick<StateDB, 'getFile' | 'setFile'>,
  path: string, stat: LocalStat, base?: FileState,
): Promise<string> {
  const observedAt = Date.now();
  const data = await adapter.readBinary(path);
  const hash = await sha256(data);
  if (base && base.localSize === undefined && base.localMtime === stat.mtime && stat.size === data.byteLength
      && !withinSafetyWindow(stat.mtime, observedAt) && base.localHash === hash && state.getFile(path) === base) {
    state.setFile({ ...base, localSize: stat.size });
  }
  return hash;
}

// Re-stats the file after a write: the real post-write stat is the change-detection key (the downloaded
// mtime is requested at write time via DataWriteOptions.mtime). Best-effort: if stat fails the fields stay
// undefined and the file is hashed next time.
export async function withLocalSignature(
  localAdapter: Pick<LocalAdapter, 'stat'>,
  fs: FileState,
  remoteMtime?: number | null,
): Promise<FileState> {
  const st = await localAdapter.stat(fs.path);
  if (st) {
    fs.localMtime = st.mtime;
    fs.localSize = st.size;
  }
  if (remoteMtime != null) fs.remoteMtime = remoteMtime;
  return fs;
}

export function invalidateLocalSignature(state: Pick<StateDB, 'getFile' | 'setFile'>, path: string): void {
  const base = state.getFile(path);
  if (base && (base.localMtime !== undefined || base.localSize !== undefined)) {
    state.setFile({ ...base, localMtime: undefined, localSize: undefined });
  }
}

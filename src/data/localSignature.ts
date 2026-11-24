import { FileState } from '../types';
import { LocalAdapter } from './LocalAdapter';
import type { StateDB } from './StateDB';

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

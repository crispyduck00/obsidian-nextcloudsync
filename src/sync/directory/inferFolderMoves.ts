import type { LocalAdapter } from '../../data/LocalAdapter';
import type { StateDB } from '../../data/StateDB';
import type { RemoteDirInfo } from '../../types';
import { sha256 } from '../../util/hash';
import { MAX_HASH_SIZE } from '../../util/limits';
import { parentDir } from '../policy';

export async function findUnobservedFolderMoves(local: Pick<LocalAdapter, 'listVaultFiles' | 'isFolder' | 'readBinary'>,
  state: Pick<StateDB, 'getFile' | 'getDir' | 'getAllFiles'>, remoteDirs: readonly RemoteDirInfo[],
  unavailable: (path: string) => boolean): Promise<Map<string, string>> {
  const bySource = new Map<string, Set<string>>();
  const byDestination = new Map<string, Set<string>>();
  const dirs = new Set(remoteDirs.map(dir => dir.fileId).filter(id => !!id));
  if (!dirs.size) return new Map();
  const localFiles = local.listVaultFiles();
  const present = new Set(localFiles.map(file => file.path));
  const newStats = new Map<string, typeof localFiles>();
  const basename = (path: string): string => path.slice(parentDir(path).length + (path.includes('/') ? 1 : 0));
  const signature = (path: string, size: number, mtime: number): string => JSON.stringify([basename(path), size, mtime]);
  for (const file of localFiles) {
    if (!file.path.includes('/') || file.size > MAX_HASH_SIZE || state.getFile(file.path) || unavailable(file.path)) continue;
    const key = signature(file.path, file.size, file.mtime);
    const matches = newStats.get(key) ?? [];
    matches.push(file);
    newStats.set(key, matches);
  }
  if (!newStats.size) return new Map();
  const absent = new Map<string, boolean>();
  const hashes = new Map<string, string | null>();
  for (const base of state.getAllFiles()) {
    if (base.localMtime === undefined || !base.path.includes('/') || present.has(base.path) || unavailable(base.path)) continue;
    const candidates = newStats.get(signature(base.path, base.size, base.localMtime));
    if (!candidates) continue;
    let source: string | undefined;
    for (let parent = parentDir(base.path); parent; parent = parentDir(parent)) {
      const id = state.getDir(parent)?.remoteFileId;
      if (!id || !dirs.has(id) || unavailable(parent)) continue;
      if (!absent.has(parent)) absent.set(parent, !await local.isFolder(parent));
      if (!absent.get(parent)) break;
      source = parent;
    }
    if (!source) continue;
    const suffix = base.path.slice(source.length);
    for (const file of candidates) {
      if (!file.path.endsWith(suffix)) continue;
      const destination = file.path.slice(0, -suffix.length);
      if (!destination || state.getDir(destination) || unavailable(destination)) continue;
      if (!hashes.has(file.path)) {
        const bytes = await local.readBinary(file.path).catch(() => null);
        hashes.set(file.path, bytes?.byteLength === base.size ? await sha256(bytes) : null);
      }
      if (hashes.get(file.path) !== base.localHash) continue;
      const destinations = bySource.get(source) ?? new Set<string>();
      destinations.add(destination);
      bySource.set(source, destinations);
      const sources = byDestination.get(destination) ?? new Set<string>();
      sources.add(source);
      byDestination.set(destination, sources);
    }
  }
  const matches = new Map<string, string>();
  for (const [source, destinations] of bySource) {
    if (destinations.size !== 1) continue;
    const [destination] = destinations;
    if (byDestination.get(destination)?.size === 1) matches.set(source, destination);
  }
  return matches;
}

import type { LocalAdapter } from '../../data/LocalAdapter';

// Callers can distinguish a manual naming repair from a transient filesystem failure.
export class LocalPathIdentityError extends Error {
  readonly requiresManualResolution = true;
}

// stat/read may resolve a differently-spelled name on a case-insensitive filesystem.
// Before reconciling different path sets, prove that every existing candidate is an
// actual directory entry. Otherwise deleting the "old" name can delete the new one.
export async function assertUnambiguousLocalPaths(
  adapter: Pick<LocalAdapter, 'stat' | 'list'>,
  localPaths: Iterable<string>,
  remotePaths: Iterable<string>,
  kind: 'file' | 'folder' = 'file',
): Promise<void> {
  const local = new Set(localPaths);
  const remote = new Set(remotePaths);
  // Compare spellings only: never rewrite paths or infer that two files are the same.
  // Include ancestors so different children cannot hide a normalized folder collision.
  const names = new Map<string, string>();
  for (const path of new Set([...local, ...remote])) {
    let prefix = '';
    for (const part of path.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const normalized = prefix.normalize('NFC');
      const previous = names.get(normalized);
      if (previous && previous !== prefix) {
        throw new LocalPathIdentityError(`The local and server names ${previous} and ${prefix} use different Unicode spellings. Sync stopped before changing files. Match the local filename to the server and retry.`);
      }
      names.set(normalized, prefix);
    }
  }
  const candidates = [...local].filter(path => !remote.has(path))
    .concat([...remote].filter(path => !local.has(path)));
  const listings = new Map<string, { files: string[]; folders: string[] }>();
  for (const path of candidates) {
    if (!await adapter.stat(path)) continue;
    let parent = '';
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      let listing = listings.get(parent);
      if (!listing) {
        listing = await adapter.list(parent);
        listings.set(parent, listing);
      }
      const next = parent ? `${parent}/${parts[i]}` : parts[i];
      if (!(i === parts.length - 1 && kind === 'file' ? listing.files : listing.folders).includes(next)) {
        throw new LocalPathIdentityError(`The local filesystem resolves ${path} to a differently spelled path. Sync stopped before changing files. Match the local filename to the server and retry.`);
      }
      parent = next;
    }
  }
}

/** stat() may resolve an alias; only raw directory entries prove an exact name. */
export async function hasExactLocalFile(adapter: Pick<LocalAdapter, 'list'>, path: string): Promise<boolean> {
  const parts = path.split('/');
  let parent = '';
  for (let i = 0; i < parts.length; i++) {
    const listing = await adapter.list(parent);
    const next = parent ? `${parent}/${parts[i]}` : parts[i];
    if (!(i === parts.length - 1 ? listing.files : listing.folders).includes(next)) return false;
    parent = next;
  }
  return true;
}

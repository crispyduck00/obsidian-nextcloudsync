import type { RemoteDirInfo, RemoteFileInfo } from '../../types';

/** Compare the complete included remote tree to the tracked remote sides. */
export function matchesTrackedRemote(
  files: readonly RemoteFileInfo[], dirs: readonly RemoteDirInfo[],
  trackedFiles: readonly RemoteFileInfo[], trackedDirs: readonly RemoteDirInfo[], isExcluded: (path: string) => boolean,
): boolean {
  const match = <T extends { path: string; fileId: string | null }>(
    live: readonly T[], tracked: readonly T[], same: (old: T, current: T) => boolean,
  ): boolean => {
    const included = new Map(tracked.filter(item => !isExcluded(item.path)).map(item => [item.path, item]));
    for (const item of live) {
      if (isExcluded(item.path)) continue;
      const old = included.get(item.path);
      if (!old || !item.fileId || old.fileId !== item.fileId || !same(old, item)) return false;
      included.delete(item.path);
    }
    return included.size === 0;
  };
  return match(files, trackedFiles, (old, current) => old.size === current.size && old.lastModified === current.lastModified
    && (!old.etag || old.etag === current.etag)
    && (!!old.checksum && old.checksum === current.checksum || !!old.etag && old.etag === current.etag))
    && match(dirs, trackedDirs, () => true);
}

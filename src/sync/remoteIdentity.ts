import { FileState, RemoteFileInfo } from '../types';

// Single definition of the remote identity: checksum, else ETag, else size. Recording and classifying
// must share it, or a plain WebDAV server reads every uploaded file back as changed (docs/spec.md §5.9).
export function remoteIdOf(remote: RemoteFileInfo): { remoteId: string; idType: FileState['idType'] } {
  if (remote.checksum) return { remoteId: remote.checksum, idType: 'sha256' };
  if (remote.etag) return { remoteId: remote.etag, idType: 'etag' };
  return { remoteId: String(remote.size), idType: 'size' };
}

/** Nextcloud can retain the previous checksum after restoring a version. */
export function withTrustedChecksum(remote: RemoteFileInfo, base?: FileState): RemoteFileInfo {
  if (!base || !remote.checksum || !remote.etag) return remote;
  const previousEtag = base.remoteEtag;
  const baselineMtime = Math.floor(Math.max(base.remoteMtime ?? 0, base.mtime) / 1000) * 1000;
  const revisionChanged = previousEtag ? previousEtag !== remote.etag
    : remote.lastModified > 0 && remote.lastModified < baselineMtime;
  const stale = base.idType === 'etag'
    ? !!previousEtag && (revisionChanged || remote.checksum !== base.localHash)
    : base.idType === 'sha256' && remote.checksum === base.remoteId && (revisionChanged || remote.size !== base.size);
  // The existing ETag path reads the body where needed and keeps normal checksum fast paths intact.
  return stale ? { ...remote, checksum: null } : remote;
}

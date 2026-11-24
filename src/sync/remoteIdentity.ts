import { FileState, RemoteFileInfo } from '../types';

// Single definition of the remote identity: checksum, else ETag, else size. Recording and classifying
// must share it, or a plain WebDAV server reads every uploaded file back as changed (docs/spec.md §5.9).
export function remoteIdOf(remote: RemoteFileInfo): { remoteId: string; idType: FileState['idType'] } {
  if (remote.checksum) return { remoteId: remote.checksum, idType: 'sha256' };
  if (remote.etag) return { remoteId: remote.etag, idType: 'etag' };
  return { remoteId: String(remote.size), idType: 'size' };
}

/** A version restore can retain the checksum from an intermediate revision this device never saw. */
export function withTrustedChecksum(remote: RemoteFileInfo, base?: FileState, verifyFirstContact = false): RemoteFileInfo {
  if (!remote.checksum || !remote.etag) return remote;
  const previous = base?.remoteEtag;
  if (!base) return verifyFirstContact ? { ...remote, checksum: null } : remote;
  const baselineMtime = Math.floor(Math.max(base.remoteMtime ?? 0, base.mtime) / 1000) * 1000;
  const unverified = previous ? previous !== remote.etag || base.idType === 'etag'
    : verifyFirstContact || (remote.lastModified > 0 && remote.lastModified < baselineMtime);
  const inconsistent = base.idType === 'sha256' && (remote.checksum === base.remoteId && remote.size !== base.size
    || !!previous && (remote.checksum !== base.remoteId || base.localHash !== base.remoteId));
  const replaced = !!base.remoteFileId && !!remote.fileId && base.remoteFileId !== remote.fileId && verifyFirstContact;
  return unverified || inconsistent || replaced ? { ...remote, checksum: null } : remote;
}

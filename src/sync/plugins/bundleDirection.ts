import type { FileState, RemoteFileInfo } from '../../types';
import { checksumProvesIdentical } from '../identity/contentIdentity';
import { remoteRevisionChanged } from '../remoteIdentity';
import { compareSemver } from '../../util/version';

export type BundleDirection = 'local' | 'remote' | 'hold' | null;

export interface ManifestSide {
  version: string | null; // null when the version cannot be parsed
  mtime: number; // local: stat mtime (ms); remote: RemoteFileInfo.lastModified (ms)
}

export interface BundleDirectionInput {
  local: ManifestSide | null; // null when the local manifest.json is missing
  remote: ManifestSide | null; // null when the remote listing has no manifest.json
  localChanged: boolean;
  remoteChanged: boolean;
  sameContent: boolean; // present on both sides and provably identical
}

export interface BundleFileState {
  localPresent: boolean;
  remotePresent: boolean;
  tracked: boolean; // the state DB has an entry for the path
  sameContent: boolean; // present on both sides and provably identical
}

export type BundleFileAction = 'download' | 'upload' | 'skip' | 'hold' | 'normal';

/** Whether one side changed since the tracked base. A tracked file that vanished counts as a change. */
export function sideChanged(present: boolean, currentId: string | null, baseId: string | null): boolean {
  if (baseId === null) return present;
  if (!present) return true;
  return currentId !== baseId;
}

/** True only when the two sides are provably identical; otherwise false (unknown counts as different). */
export function fileSameContent(input: {
  localHash: string | null;
  remote: RemoteFileInfo | null;
  base: FileState | null;
  localChanged: boolean;
}): boolean {
  const { localHash, remote, base, localChanged } = input;
  if (localHash === null || remote === null) return false;
  if (checksumProvesIdentical(remote, localHash)) return true;
  return base !== null && !localChanged && !remoteRevisionChanged(remote, base);
}

function newerSide(local: ManifestSide, remote: ManifestSide): BundleDirection {
  const byVersion = compareSemver(local.version ?? '', remote.version ?? '');
  if (byVersion !== 0) return byVersion > 0 ? 'local' : 'remote';
  // The remote getlastmodified has second precision, so compare whole seconds.
  const localSec = Math.floor(local.mtime / 1000);
  const remoteSec = Math.floor(remote.mtime / 1000);
  if (localSec === remoteSec) return 'hold';
  return localSec > remoteSec ? 'local' : 'remote';
}

/** Decide which side's bundle wins; rows are evaluated top to bottom. */
export function decideBundleDirection(input: BundleDirectionInput): BundleDirection {
  const { local, remote, localChanged, remoteChanged } = input;
  if (local === null && remote === null) return null;
  if (input.sameContent) return null;
  if (localChanged && !remoteChanged) return 'local';
  if (!localChanged && remoteChanged) return 'remote';
  if (!localChanged && !remoteChanged) return null;
  if (local === null) return 'remote';
  if (remote === null) return 'local';
  return newerSide(local, remote);
}

/** Map a bundle direction and one file's state to the action for that file. */
export function planBundleFileAction(direction: BundleDirection, file: BundleFileState): BundleFileAction {
  if (direction === null) return 'normal';
  if (direction === 'hold') {
    if (!file.localPresent || !file.remotePresent) return 'skip';
    return file.sameContent ? 'normal' : 'hold';
  }
  const srcPresent = direction === 'remote' ? file.remotePresent : file.localPresent;
  const dstPresent = direction === 'remote' ? file.localPresent : file.remotePresent;
  const transfer: BundleFileAction = direction === 'remote' ? 'download' : 'upload';
  if (srcPresent && !dstPresent) return transfer;
  if (srcPresent) return file.sameContent ? 'normal' : transfer;
  if (dstPresent) return file.tracked ? 'normal' : 'skip';
  return 'normal';
}

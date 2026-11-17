// Pure predicates (no network, disk or engine state): every input arrives as an argument, including
// ambient values such as the clock, so the safety-window boundaries are directly testable.
import { FileState } from '../../types';
import { SIGNATURE_SAFETY_WINDOW_MS } from '../../util/limits';
import { isUnderExcludedFolder, HARD_EXCLUDED_FOLDERS } from '../../util/excludedFolders';
import { isSyncTmpPath } from '../../data/LocalAdapter';
import { DIR_BREAKER_REPORT_FILENAME, FILE_BREAKER_REPORT_FILENAME } from '../../ui/breakerReport';
import { isMarkdown } from '../../util/mergeableExtensions';

export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function isDotName(path: string): boolean {
  const i = path.lastIndexOf('/');
  return (i < 0 ? path : path.slice(i + 1)).startsWith('.');
}

// Mtime granularity is coarse (1-2 s on some mobile storage), so a same-size in-place edit inside it is
// indistinguishable from no edit by stat alone and must not be treated as unchanged.
export function withinSafetyWindow(mtime: number, ref: number): boolean {
  return Math.abs(ref - mtime) < SIGNATURE_SAFETY_WINDOW_MS;
}

// Compares against the stat signature captured right after the plugin's own write. A downloaded mtime is
// set at write time via DataWriteOptions.mtime, and the real post-write stat (not the requested value) is
// the reference, so it holds on every device. Returns false (must hash)
// when the signature is absent, size or mtime differs, or mtime is inside the safety window around `now`
// or `lastSync`. `clock` is accessors, not values, so the common early-return path never reads the state DB.
export function isLocallyUnchanged(
  base: FileState,
  stat: { mtime: number; size: number },
  clock: { now(): number; lastSyncTime(): number },
): boolean {
  if (base.localMtime == null || base.localSize == null) return false;
  if (stat.size !== base.localSize) return false;
  if (stat.mtime !== base.localMtime) return false;
  const now = clock.now();
  const lastSync = clock.lastSyncTime();
  if (withinSafetyWindow(stat.mtime, now)) return false;
  if (lastSync > 0 && withinSafetyWindow(stat.mtime, lastSync)) return false;
  return true;
}

/**
 * True when Compare may safely decode a file as text.
 *
 * Markdown is always text-eligible even though upstream change intentionally removed `md` from
 * `autoMergeFileTypes`: markdown has its own frontmatter/body merge rules and must not lose the
 * Compare line diff merely because it no longer participates in that extension classification.
 */
export function isTextEligible(path: string, autoMergeFileTypes: readonly string[]): boolean {
  if (isMarkdown(path)) return true;
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return autoMergeFileTypes.includes(ext);
}

// Declared here rather than importing the engine's options, so policy knows nothing about SyncEngine.
export interface SystemExclusionContext {
  excludedFolders: readonly string[];
  isUnderConfigDir(path: string): boolean;
  isConfigPathIncluded(path: string): boolean;
  isActiveLogFile?(path: string): boolean;
}

// Also the scope guard for remote deletions: a fabricated server deletion for `.obsidian/...` would
// otherwise reach a raw filesystem remove.
export function isSystemExcluded(path: string, ctx: SystemExclusionContext): boolean {
  // Atomic-write temp files: the watchers already filter them, but a leftover must not be uploaded.
  // The plugin's own atomic-write temp files are never sync content (defense in depth:
  // the vault watchers already filter them, but a leftover tmp must not be uploaded either).
  if (isSyncTmpPath(path)) return true;
  // Breaker report notes are device-local snapshots, regenerated on every open.
  if (path === DIR_BREAKER_REPORT_FILENAME || path === FILE_BREAKER_REPORT_FILENAME) return true;
  // The active log file is appended to during sync, so syncing it races the append (Obsidian's rename
  // throws "Destination file already exists!"). Other devices' logs stay syncable (docs/spec.md §9.1).
  if (ctx.isActiveLogFile?.(path)) return true;
  // `.git` piecewise sync corrupts the repo (discussion #6); `.trash` is device-local (docs/spec.md §9.3a).
  if (isUnderExcludedFolder(path, HARD_EXCLUDED_FOLDERS)) return true;
  // Applied before the config-folder logic so it covers ordinary vault files; the hard exclusions above win.
  if (isUnderExcludedFolder(path, ctx.excludedFolders)) return true;
  // Ordinary vault files (outside the config folder) are never system-excluded.
  if (!ctx.isUnderConfigDir(path)) return false;
  // This plugin's own folder is always excluded; community plugins sync only the four files of plugins in
  // `syncedCommunityPlugins` (docs/spec.md §7). ConfigSyncResolver decides, so the deletion guard follows it.
  return !ctx.isConfigPathIncluded(path);
}

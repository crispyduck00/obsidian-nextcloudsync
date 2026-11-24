import type { DataWriteOptions } from 'obsidian';
import type { CreationTimeSupport } from './creationTimeProbe';
import { isValidCreationMs } from '../util/creationTime';
import { DataAdapter, FileView, Notice, TFile, Vault, Workspace, normalizePath } from 'obsidian';

export interface LocalFileEntry { path: string; size: number; mtime: number; }

export interface LocalStat { size: number; mtime: number; ctime?: number }

export type CreationTimeSupportSource = () => Promise<CreationTimeSupport>;

// Atomic-write temp suffix, kept short: the temp file lives in the target's own directory and each path component is
// capped at NAME_MAX bytes (255 on ext4/F2FS), so the temp name must not inherit the target's length (see tmpPathFor).
// LEGACY_TMP_SUFFIX is only recognised, never produced, so stale temp files from older versions are still ignored and cleaned up.
const TMP_SUFFIX = '.ncs.tmp';
const LEGACY_TMP_SUFFIX = '.nextcloudsync.tmp';
const NAME_MAX_BYTES = 255;
const IGNORE_TIMEOUT_MS = 5000;
// A stored creation time further than this from the requested one is treated as not applied (docs/spec.md §9.7).
const CTIME_TOLERANCE_MS = 1000;

// Trailing write-options argument carrying the file's modification time (docs/spec.md §9.6). Without a positive mtime
// the argument is omitted, not passed as undefined, so the API applies its default (the write time). `ctime` carries the
// creation time (docs/spec.md §9.7); the caller passes it only on a platform where it is settable.
function writeOptionsArgs(mtime: number | undefined, ctime?: number): [] | [DataWriteOptions] {
  const hasMtime = mtime !== undefined && mtime > 0;
  if (hasMtime && ctime !== undefined) return [{ mtime, ctime }];
  if (hasMtime) return [{ mtime }];
  if (ctime !== undefined) return [{ ctime }];
  return [];
}

// NAME_MAX is measured in bytes, not UTF-16 code units.
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Non-cryptographic 32-bit FNV-1a -> base36; it only needs to make per-target temp names unique within a directory.
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Short, fixed-length hidden temp name in the target's own directory: hash-derived so it stays within NAME_MAX even for
// near-limit targets, and same-directory so the final rename stays atomic.
export function tmpPathFor(targetPath: string): string {
  const lastSlash = targetPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? targetPath.slice(0, lastSlash) : '';
  const tmpName = `.${shortHash(targetPath)}${TMP_SUFFIX}`;
  return dir ? `${dir}/${tmpName}` : tmpName;
}

// Rewrites a raw write error when the target's final name itself exceeds NAME_MAX (unstorable); other errors pass through
// unmasked. Only consulted from a catch block.
function translateNameTooLong(err: unknown, targetPath: string): unknown {
  const name = targetPath.slice(targetPath.lastIndexOf('/') + 1);
  const bytes = utf8ByteLength(name);
  if (bytes > NAME_MAX_BYTES) {
    return new Error(
      `File name too long (${bytes} bytes / max ${NAME_MAX_BYTES} bytes): "${name}". Shorten the file name.`,
    );
  }
  return err;
}

// This plugin's own atomic-write temp files (current and legacy suffix), never user content.
export function isSyncTmpPath(path: string): boolean {
  return path.endsWith(TMP_SUFFIX) || path.endsWith(LEGACY_TMP_SUFFIX);
}

// Uses the Adapter API rather than the Vault API: it gives tmp-write -> rename atomicity, reaches paths the Vault index
// does not track (state/log files), and reads raw bytes. Remote->local paths go through normalizePath() at the boundary.
export class LocalAdapter {
  private ignoreList: Map<string, number> = new Map();
  private creationTimeSupportPromise: Promise<CreationTimeSupport> | undefined = undefined;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly vault?: Vault,
    private readonly workspace?: Workspace,
    private readonly creationTimeSupportSource?: CreationTimeSupportSource,
  ) {}

  /** Memoized result of the platform probe (docs/spec.md §9.7). Never rejects: a failing source yields 'untrusted'. */
  creationTimeSupport(): Promise<CreationTimeSupport> {
    if (!this.creationTimeSupportPromise) {
      const source = this.creationTimeSupportSource;
      const pending: Promise<CreationTimeSupport> = source ? Promise.resolve().then(source) : Promise.resolve('untrusted');
      this.creationTimeSupportPromise = pending.catch((): CreationTimeSupport => 'untrusted');
    }
    return this.creationTimeSupportPromise;
  }

  // The ctime to put in write options: only on a settable platform and only when valid.
  private async effectiveCtime(ctime: number | undefined): Promise<number | undefined> {
    if (!isValidCreationMs(ctime)) return undefined;
    return (await this.creationTimeSupport()) === 'settable' ? ctime : undefined;
  }

  // Windows file-time tunneling can keep the replaced file's creation time; re-apply it when the stored value is off.
  // Failures are logged and swallowed: the write itself succeeded and the next sync compares again.
  private async correctTunneling(targetPath: string, ctime: number | undefined): Promise<void> {
    if (ctime === undefined) return;
    try {
      const st = await this.adapter.stat(targetPath);
      if (st && Math.abs((st.ctime ?? 0) - ctime) >= CTIME_TOLERANCE_MS) {
        await this.setCreationTime(targetPath, ctime);
      }
    } catch (err) {
      console.warn(`creation time correction failed for ${targetPath}`, err);
    }
  }

  /**
   * Sets only the creation time, leaving content and mtime unchanged (DataAdapter.append with '' and
   * { ctime, mtime: current mtime }). Callers check creationTimeSupport() === 'settable' first.
   * @returns 'applied' when the re-stat ctime is within 1000 ms of ctimeMs, 'ineffective' otherwise,
   *          'absent' when the file does not exist. Rejects on an adapter error (caller treats it as transient).
   */
  async setCreationTime(path: string, ctimeMs: number): Promise<'applied' | 'ineffective' | 'absent'> {
    const normalized = normalizePath(path);
    const before = await this.adapter.stat(normalized);
    if (!before) return 'absent';
    this.ignore(normalized);
    await this.adapter.append(normalized, '', { ctime: ctimeMs, mtime: before.mtime });
    const after = await this.adapter.stat(normalized);
    return after?.ctime !== undefined && Math.abs(after.ctime - ctimeMs) < CTIME_TOLERANCE_MS ? 'applied' : 'ineffective';
  }

  // Resolves `path` to the TFile held by an open leaf, or null. A DEFERRED leaf (background tab, Obsidian >= 1.7.2) carries a
  // DeferredView that is not a FileView, so its path is read from the serialized view state and looked up via the Vault;
  // missing it sends the write down the destructive remove -> rename path that detaches the leaf (issues #15, #32).
  private findOpenTFile(path: string): TFile | null {
    if (!this.workspace) return null;
    let found: TFile | null = null;
    this.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (view instanceof FileView && view.file?.path === path) {
        found = view.file;
        return;
      }
      if (!leaf.isDeferred || !this.vault) return;
      const statePath = leaf.getViewState()?.state?.file;
      if (typeof statePath === 'string' && statePath === path) {
        // getFileByPath returns null for a folder or a missing path, which correctly falls through
        // to the tmp-write path rather than pretending the file is open.
        found = this.vault.getFileByPath(path);
      }
    });
    return found;
  }

  ignore(path: string): void {
    const existing = this.ignoreList.get(path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => this.ignoreList.delete(path), IGNORE_TIMEOUT_MS);
    // Node timers keep the process alive in tests: unref when present (window.setTimeout returns a number in Electron).
    (timer as unknown as { unref?: () => void }).unref?.();
    this.ignoreList.set(path, timer);
  }

  // Not consumed on read: one atomicWrite fires several Vault events (create/delete/rename) for the same path, so consuming
  // on the first would leak the rest as user edits. Entries expire by timeout.
  shouldIgnore(path: string): boolean {
    return this.ignoreList.has(path);
  }

  // Call from onunload so pending timers cannot fire after teardown or leak across reloads.
  dispose(): void {
    for (const timer of this.ignoreList.values()) window.clearTimeout(timer);
    this.ignoreList.clear();
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash > 0) {
      const dir = filePath.slice(0, lastSlash);
      // Mark the parent folder as our own write BEFORE creating it, so watch mode does not propagate the folder-create
      // back to the server as a spurious MKCOL.
      this.ignore(dir);
      await this.adapter.mkdir(dir);
    }
  }

  // An open leaf is updated in place via Vault.modify (no delete event, so Obsidian never detaches it, issue #15);
  // otherwise tmp-write -> remove existing -> rename.
  async atomicWrite(targetPath: string, content: string, mtime?: number, ctime?: number): Promise<void> {
    targetPath = normalizePath(targetPath);
    const effCtime = await this.effectiveCtime(ctime);
    const openFile = this.findOpenTFile(targetPath);
    if (openFile) {
      this.ignore(targetPath);
      await this.vault!.modify(openFile, content, ...writeOptionsArgs(mtime, effCtime));
      await this.correctTunneling(targetPath, effCtime);
      return;
    }
    const tmpPath = tmpPathFor(targetPath);
    this.ignore(tmpPath);
    this.ignore(targetPath);
    let targetRemoved = false;
    try {
      await this.ensureParentDir(targetPath);
      await this.adapter.write(tmpPath, content, ...writeOptionsArgs(mtime, effCtime));
      if (await this.adapter.exists(targetPath)) {
        await this.adapter.remove(targetPath);
        targetRemoved = true;
      }
      await this.adapter.rename(tmpPath, targetPath);
    } catch (err) {
      // If remove(targetPath) already succeeded before rename threw, tmpPath is the ONLY surviving copy of the new content:
      // clean up tmp only when the destructive remove() never happened.
      if (!targetRemoved && await this.adapter.exists(tmpPath)) {
        await this.adapter.remove(tmpPath);
      }
      throw translateNameTooLong(err, targetPath);
    }
    await this.correctTunneling(targetPath, effCtime);
  }

  // Same open-file in-place path as atomicWrite (Vault.modifyBinary); otherwise tmp-write -> remove -> rename with read-back verification.
  async atomicWriteBinary(targetPath: string, data: ArrayBuffer, mtime?: number, ctime?: number): Promise<void> {
    targetPath = normalizePath(targetPath);
    const effCtime = await this.effectiveCtime(ctime);
    const openFile = this.findOpenTFile(targetPath);
    if (openFile) {
      this.ignore(targetPath);
      await this.vault!.modifyBinary(openFile, data, ...writeOptionsArgs(mtime, effCtime));
      await this.correctTunneling(targetPath, effCtime);
      return;
    }
    const tmpPath = tmpPathFor(targetPath);
    this.ignore(tmpPath);
    this.ignore(targetPath);
    let targetRemoved = false;
    try {
      await this.ensureParentDir(targetPath);
      await this.adapter.writeBinary(tmpPath, data, ...writeOptionsArgs(mtime, effCtime));
      if (await this.adapter.exists(targetPath)) {
        await this.adapter.remove(targetPath);
        targetRemoved = true;
      }
      await this.adapter.rename(tmpPath, targetPath);
      // Read-back verification (docs/spec.md §9.2): fsync is unavailable through the adapter, so confirm the byte length;
      // a truncated write throws so the caller leaves Base unadvanced and re-syncs.
      const written = await this.adapter.stat(targetPath);
      if (!written || written.size !== data.byteLength) {
        throw new Error(`write-back verification failed for ${targetPath}: expected ${data.byteLength} bytes, found ${written ? written.size : 'none'}`);
      }
    } catch (err) {
      // See atomicWrite(): once remove(targetPath) has run, tmpPath may be the only copy and must not be deleted;
      // if rename already succeeded, tmp is gone and this is a no-op.
      if (!targetRemoved && await this.adapter.exists(tmpPath)) {
        await this.adapter.remove(tmpPath);
      }
      throw translateNameTooLong(err, targetPath);
    }
    await this.correctTunneling(targetPath, effCtime);
  }

  async read(path: string): Promise<string> {
    return this.adapter.read(normalizePath(path));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(normalizePath(path));
  }

  async isFolder(path: string): Promise<boolean> {
    return (await this.adapter.stat(normalizePath(path)))?.type === 'folder';
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }

  /** adapter.stat plus `ctime` only when trusted (support !== 'untrusted') and valid. null when absent. */
  async stat(path: string): Promise<LocalStat | null> {
    const st = await this.adapter.stat(normalizePath(path));
    if (!st) return null;
    if ((await this.creationTimeSupport()) !== 'untrusted' && isValidCreationMs(st.ctime)) {
      return { size: st.size, mtime: st.mtime, ctime: st.ctime };
    }
    return { size: st.size, mtime: st.mtime };
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.adapter.list(normalizePath(path));
  }

  // Tmp files only: never call remove on user files.
  async removeTmp(tmpPath: string): Promise<void> {
    if (isSyncTmpPath(tmpPath) && await this.adapter.exists(tmpPath)) {
      await this.adapter.remove(tmpPath);
    }
  }

  showNotice(message: string, timeout = 4000): void {
    new Notice(message, timeout);
  }

  // Reads Vault.getFiles()/TFile.stat from Obsidian's in-memory index to avoid native-bridge round trips on mobile.
  // The config folder is not Vault-tracked and is excluded (callers inject it). Returns [] when no Vault was injected (unit tests).
  listVaultFiles(): LocalFileEntry[] {
    if (!this.vault) return [];
    return this.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }
}

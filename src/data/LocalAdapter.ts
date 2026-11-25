import type { DataWriteOptions } from 'obsidian';
import type { CreationTimeSupport } from './creationTimeProbe';
import { isValidCreationMs } from '../util/creationTime';
import { sha256 } from '../util/hash';
import { DataAdapter, FileView, Notice, TFile, Vault, Workspace, normalizePath } from 'obsidian';

export interface LocalFileEntry { path: string; size: number; mtime: number; }

export interface LocalStat { size: number; mtime: number; ctime?: number }

export interface LocalWriteExpectation {
  stat: LocalStat | null;
  hash?: string;
  canWrite?: () => boolean;
  beforeCommit?: () => void;
}

export class LocalFileChangedError extends Error {
  readonly requiresManualResolution: boolean;

  constructor(path: string, readonly retainedCopy?: string) {
    super(retainedCopy
      ? `Local file changed during sync: ${path}. The previous copy is in ${retainedCopy}.`
      : `Local file changed during sync: ${path}.`);
    this.requiresManualResolution = retainedCopy !== undefined;
  }
}

export type CreationTimeSupportSource = () => Promise<CreationTimeSupport>;

// Atomic-write temp suffix, kept short: the temp file lives in the target's own directory and each path component is
// capped at NAME_MAX bytes (255 on ext4/F2FS), so the temp name must not inherit the target's length (see tmpPathFor).
// LEGACY_TMP_SUFFIX is only recognised, never produced, so stale temp files from older versions are still ignored and cleaned up.
const TMP_SUFFIX = '.ncs.tmp';
const LEGACY_TMP_SUFFIX = '.nextcloudsync.tmp';
const PREVIOUS_SUFFIX = '.ncs.previous.ncs.tmp';
const BINARY_PREVIOUS_PATTERN = /\.ncs-previous-(?:0|1-[^./]*)$/;
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

// Unlike a downloadable temp file, a staged previous file may contain the only copy of an edit.
async function previousPathFor(path: string): Promise<string> {
  const slash = path.lastIndexOf('/') + 1;
  const fileName = path.slice(slash);
  const name = '.' + fileName + PREVIOUS_SUFFIX;
  return path.slice(0, slash) + (utf8ByteLength(name) <= NAME_MAX_BYTES
    ? name
    : '.' + await sha256(new TextEncoder().encode(fileName).buffer) + PREVIOUS_SUFFIX);
}

// A single backup extension preserves basename-based folder-note hooks during binary renames.
function binaryPreviousPathFor(path: string): string | undefined {
  const slash = path.lastIndexOf('/') + 1, dot = path.lastIndexOf('.');
  const name = path.slice(slash, dot >= slash ? dot : undefined);
  const extension = dot >= slash ? '1-' + path.slice(dot + 1) : '0';
  const backup = name + '.ncs-previous-' + extension;
  return utf8ByteLength(backup) <= NAME_MAX_BYTES ? path.slice(0, slash) + backup : undefined;
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
  return path.endsWith(TMP_SUFFIX) || path.endsWith(LEGACY_TMP_SUFFIX) || BINARY_PREVIOUS_PATTERN.test(path);
}

// Uses the Adapter API rather than the Vault API: it gives tmp-write -> rename atomicity, reaches paths the Vault index
// does not track (state/log files), and reads raw bytes. Remote->local paths go through normalizePath() at the boundary.
export class LocalAdapter {
  private ignoreList = new Map<string, {
    timer: number; deletion: boolean; onExpire?: (isCurrent: () => boolean) => Promise<void>;
  }>();
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

  ignore(path: string, deletion = false): void {
    const existing = this.ignoreList.get(path);
    if (existing) window.clearTimeout(existing.timer);
    const entry = { timer: 0, deletion, onExpire: deletion ? undefined : existing?.onExpire };
    const timer = window.setTimeout(() => {
      entry.timer = 0;
      const check = entry.onExpire;
      const finish = (): void => { if (this.ignoreList.get(path) === entry) this.ignoreList.delete(path); };
      if (!check) finish();
      else void check(() => this.ignoreList.get(path) === entry && entry.onExpire === check).finally(finish);
    }, IGNORE_TIMEOUT_MS);
    // Node timers keep the process alive in tests: unref when present (window.setTimeout returns a number in Electron).
    (timer as unknown as { unref?: () => void }).unref?.();
    entry.timer = timer;
    this.ignoreList.set(path, entry);
  }

  // Not consumed on read: one atomicWrite fires several Vault events (create/delete/rename) for the same path, so consuming
  // on the first would leak the rest as user edits. Entries expire by timeout.
  shouldIgnore(path: string): boolean {
    return !!this.ignoreList.get(path)?.timer;
  }

  // A real user deletion can follow our write within the echo window. Reuse its
  // existing timer for one final-state check; repeated events do not add work.
  afterIgnore(path: string, onExpire: (isCurrent: () => boolean) => Promise<void>): void {
    const entry = this.ignoreList.get(path);
    if (entry && !entry.deletion) entry.onExpire = onExpire;
  }

  // A later rename supersedes absence at the old path, including its children.
  cancelAfterIgnore(path: string, folder = false): void {
    for (const [current, entry] of this.ignoreList) {
      if (current === path || (folder && current.startsWith(path + '/'))) entry.onExpire = undefined;
    }
  }

  // Call from onunload so pending timers cannot fire after teardown or leak across reloads.
  dispose(): void {
    for (const entry of this.ignoreList.values()) window.clearTimeout(entry.timer);
    this.ignoreList.clear();
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash > 0) {
      const dir = filePath.slice(0, lastSlash);
      // Mark the parent folder as our own write BEFORE creating it, so watch mode does not propagate the folder-create
      // back to the server as a spurious MKCOL.
      this.ignore(dir);
      // mkdir can also create missing ancestors. Their create events must not cancel the
      // user's earlier folder deletion while a download is restoring part of that tree.
      const parents = dir.split('/');
      parents.pop();
      if (parents.length && !await this.adapter.exists(dir)) {
        while (parents.length) {
          const parent = parents.join('/');
          if (await this.adapter.exists(parent)) break;
          this.ignore(parent);
          parents.pop();
        }
      }
      await this.adapter.mkdir(dir);
    }
  }

  // Update open notes in place so Obsidian keeps the leaf attached (issue #15).
  async atomicWrite(targetPath: string, content: string, mtime?: number, ctime?: number, expected?: LocalWriteExpectation): Promise<void> {
    targetPath = normalizePath(targetPath);
    const effCtime = await this.effectiveCtime(ctime);
    const openFile = this.findOpenTFile(targetPath);
    if (openFile && !expected) {
      this.ignore(targetPath);
      await this.vault!.modify(openFile, content, ...writeOptionsArgs(mtime, effCtime));
    } else if (!(expected && await this.processTextFile(openFile, targetPath, content, expected, mtime, effCtime))) {
      await this.stageWrite(targetPath, tmp => this.adapter.write(tmp, content, ...writeOptionsArgs(mtime, effCtime)),
        expected, expected ? utf8ByteLength(content) : undefined);
    }
    await this.correctTunneling(targetPath, effCtime);
  }

  // Text updates keep the indexed path stable for editor leaves and other plugins' rename hooks.
  async atomicWriteBinary(targetPath: string, data: ArrayBuffer, mtime?: number, ctime?: number, expected?: LocalWriteExpectation): Promise<LocalStat | void> {
    targetPath = normalizePath(targetPath);
    const effCtime = await this.effectiveCtime(ctime);
    const openFile = this.findOpenTFile(targetPath);
    const text = expected ? this.decodeUtf8(data) : undefined;
    if (expected && text !== undefined && await this.processTextFile(openFile, targetPath, text, expected, mtime, effCtime)) {
      const written = await this.adapter.stat(targetPath);
      await this.correctTunneling(targetPath, effCtime);
      return written ?? undefined;
    }
    if (openFile) {
      if (expected) await this.readExpectedTarget(targetPath, expected);
      expected?.beforeCommit?.();
      this.ignore(targetPath);
      await this.vault!.modifyBinary(openFile, data, ...writeOptionsArgs(mtime, effCtime));
      const written = expected ? await this.adapter.stat(targetPath) : null;
      await this.correctTunneling(targetPath, effCtime);
      return written ?? undefined;
    }
    const written = await this.stageWrite(targetPath,
      tmp => this.adapter.writeBinary(tmp, data, ...writeOptionsArgs(mtime, effCtime)), expected, data.byteLength);
    await this.correctTunneling(targetPath, effCtime);
    return expected ? written : undefined;
  }

  private async stageWrite(
    target: string, writeTemp: (tmp: string) => Promise<void>, expected?: LocalWriteExpectation, size?: number,
  ): Promise<LocalStat | undefined> {
    const tmp = tmpPathFor(target);
    this.ignore(tmp);
    if (!expected) this.ignore(target);
    let targetRemovalAttempted = false;
    try {
      await this.ensureParentDir(target);
      await writeTemp(tmp);
      if (expected) {
        if (size !== undefined) await this.verifyWrite(tmp, size);
        await this.commitGuardedWrite(tmp, target, expected);
      } else {
        if (await this.adapter.exists(target)) {
          targetRemovalAttempted = true;
          this.ignore(target, true);
          await this.adapter.remove(target);
        }
        await this.adapter.rename(tmp, target);
        this.ignore(target);
      }
      return size === undefined ? undefined : await this.verifyWrite(target, size);
    } catch (err) {
      // A rejected remove may already have unlinked the target. Keep its only surviving replacement.
      const targetMissing = targetRemovalAttempted && !await this.adapter.exists(target);
      if (!targetMissing && await this.adapter.exists(tmp)) await this.adapter.remove(tmp);
      throw translateNameTooLong(err, target);
    }
  }

  private async verifyWrite(path: string, size: number): Promise<LocalStat> {
    const written = await this.adapter.stat(path);
    if (!written || written.size !== size) {
      throw new Error(`write-back verification failed for ${path}: expected ${size} bytes, found ${written ? written.size : 'none'}`);
    }
    return written;
  }

  private decodeUtf8(bytes: ArrayBuffer): string | undefined {
    // Keep the BOM and line endings. A binary or invalid UTF-8 payload must never go through text APIs.
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return undefined; }
  }

  private async processTextFile(
    file: TFile | null, path: string, incoming: string, expected: LocalWriteExpectation, mtime?: number, ctime?: number,
  ): Promise<boolean> {
    if (!file && typeof this.adapter.process !== 'function') return false;
    const bytes = await this.readExpectedTarget(path, expected, true);
    const original = bytes && this.decodeUtf8(bytes);
    if (original === undefined) return false;
    const previous = await previousPathFor(path);
    const retained = await this.retainedCopyFor(path);
    if (retained) throw new LocalFileChangedError(path, retained);
    const indexed = file ?? this.vault?.getAbstractFileByPath?.(path);
    let writing = false, completed = false;
    try {
      // Keep recovery bytes without exposing a rename of the user's note to other plugins.
      this.ignore(previous);
      await this.adapter.writeBinary(previous, bytes!, ...writeOptionsArgs(expected.stat?.mtime,
        await this.effectiveCtime(expected.stat?.ctime)));
      if (await sha256(await this.adapter.readBinary(previous)) !== (expected.hash ?? await sha256(bytes!))) {
        throw new Error(`Recovery copy verification failed: ${path}.`);
      }
      const replace = (current: string): string => {
        if ((indexed && indexed.path !== path) || current !== original || expected.canWrite?.() === false) {
          throw new LocalFileChangedError(path);
        }
        expected.beforeCommit?.();
        this.ignore(path);
        writing = true;
        return incoming;
      };
      if (file) await this.vault!.process(file, replace, ...writeOptionsArgs(mtime, ctime));
      else await this.adapter.process(path, replace, ...writeOptionsArgs(mtime, ctime));
      await this.verifyWrite(path, utf8ByteLength(incoming));
      completed = true;
    } catch (err) {
      if (writing) throw new LocalFileChangedError(path, previous);
      throw err;
    } finally {
      if ((!writing || completed) && await this.adapter.exists(previous)) await this.adapter.remove(previous);
    }
    return true;
  }

  private async readExpectedTarget(
    path: string, expected: LocalWriteExpectation, readBody = false,
  ): Promise<ArrayBuffer | undefined> {
    const current = await this.adapter.stat(path);
    if (expected.canWrite?.() === false || (expected.stat === null
      ? current !== null
      : !current || current.type !== 'file' || current.size !== expected.stat.size || current.mtime !== expected.stat.mtime)) {
      throw new LocalFileChangedError(path);
    }
    if (current === null || (!readBody && expected.hash === undefined)) return undefined;
    const body = await this.adapter.readBinary(path);
    if ((expected.hash !== undefined && await sha256(body) !== expected.hash) || expected.canWrite?.() === false) {
      throw new LocalFileChangedError(path);
    }
    return body;
  }

  private async commitGuardedWrite(tmp: string, target: string, expected: LocalWriteExpectation): Promise<void> {
    const previous = expected.stat === null ? null : binaryPreviousPathFor(target);
    if (previous === undefined) {
      throw Object.assign(new Error(`Shorten the filename before replacing ${target}: its safe binary recovery name exceeds ${NAME_MAX_BYTES} bytes.`), { requiresManualResolution: true });
    }
    const retained = await this.retainedCopyFor(target);
    if (retained) throw new LocalFileChangedError(target, retained);
    await this.readExpectedTarget(target, { ...expected, hash: undefined });
    this.ignore(target);
    if (!previous) {
      // A new file or restore must use Obsidian's collision-checked rename without removing its destination.
      expected.beforeCommit?.();
      try { await this.adapter.rename(tmp, target); }
      catch (err) {
        if (await this.adapter.exists(target)) throw new LocalFileChangedError(target);
        throw err;
      }
      return;
    }

    // Verify the exact file displaced by the rename. An edit made after the stat above is still recoverable.
    await this.adapter.rename(target, previous);
    try {
      await this.readExpectedTarget(previous, expected);
      expected.beforeCommit?.();
      await this.adapter.rename(tmp, target);
    } catch (err) {
      if (await this.adapter.exists(target)) throw new LocalFileChangedError(target, previous);
      try { await this.adapter.rename(previous, target); }
      catch { throw new LocalFileChangedError(target, previous); }
      if (err instanceof LocalFileChangedError) throw new LocalFileChangedError(target);
      throw err;
    }
    await this.adapter.remove(previous);
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

  async isFile(path: string): Promise<boolean> {
    return (await this.adapter.stat(normalizePath(path)))?.type === 'file';
  }

  private async retainedCopyFor(path: string): Promise<string | undefined> {
    let found: string | undefined;
    for (const copy of [await previousPathFor(path), binaryPreviousPathFor(path)]) {
      if (!copy || !await this.adapter.exists(copy)) continue;
      if (found) throw new LocalFileChangedError(path, found);
      found = copy;
    }
    return found;
  }

  /** adapter.stat plus `ctime` only when trusted (support !== 'untrusted') and valid. null when absent. */
  async stat(path: string): Promise<LocalStat | null> {
    const normalized = normalizePath(path);
    let st = await this.adapter.stat(normalized);
    if (!isSyncTmpPath(normalized)) {
      // Recover a vacant target; a remaining snapshot beside a live file needs a manual decision.
      // Neither state may be classified as a new edit or deletion after a failed replacement.
      const previous = await this.retainedCopyFor(normalized);
      if (previous) {
        if (st) throw new LocalFileChangedError(normalized, previous);
        if ((await this.adapter.stat(previous))?.type !== 'file') return null;
        this.ignore(normalized);
        try { await this.adapter.rename(previous, normalized); }
        catch { if (!await this.adapter.exists(normalized)) throw new LocalFileChangedError(normalized, previous); }
        st = await this.adapter.stat(normalized);
      }
    }
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
    if (isSyncTmpPath(tmpPath) && !tmpPath.endsWith(PREVIOUS_SUFFIX) && !BINARY_PREVIOUS_PATTERN.test(tmpPath) && await this.adapter.exists(tmpPath)) {
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

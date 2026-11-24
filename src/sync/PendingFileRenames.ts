import type { LocalAdapter } from '../data/LocalAdapter';
import type { StateDB } from '../data/StateDB';
import type { IWebDAVClient } from '../network/IWebDAVClient';
import { isSafeVaultRelativePath } from '../network/remotePath';
import { ConflictError, NetworkError, type FileRenameIssue, type FileState, type PendingFileRename, type RemoteFileInfo } from '../types';
import { AsyncMutex } from '../util/AsyncMutex';
import { sha256 } from '../util/hash';
import { MAX_HASH_SIZE } from '../util/limits';
import { parentDir } from './policy';
import { remoteIdOf } from './remoteIdentity';

const issueMessages: Record<FileRenameIssue, string> = {
  locked: 'Nextcloud has locked the file. The rename will be retried.',
  'read-only': 'Nextcloud reports read-only access. The rename is waiting for write access.',
  denied: 'Nextcloud denied the rename. Check access to the source and destination.',
  conflict: 'The original file or destination changed on Nextcloud. Review both paths.',
  'local-missing': 'The renamed local file is missing. Restore it or move it back to the original path.',
  scope: 'The rename is outside the current sync target or included folders.',
  retry: 'The rename could not finish. It will be checked again during sync.',
};

export function fileRenameStatus(rename: PendingFileRename): string {
  if (rename.unconfirmedCreate) {
    return 'The first upload could not be confirmed. Check the original path on the server and move the local file back to its original path to resume sync safely.';
  }
  return rename.issue ? issueMessages[rename.issue] : 'Waiting to sync the rename.';
}

function validFilePath(path: string): boolean {
  return !!path && isSafeVaultRelativePath(path);
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function pathsOf(rename: PendingFileRename): string[] {
  return rename.attemptedDestination
    ? [rename.source, rename.destination, rename.attemptedDestination]
    : [rename.source, rename.destination];
}

function issueFor(error: unknown): FileRenameIssue {
  if (error instanceof NetworkError) {
    if (error.status === 423) return 'locked';
    if (error.status === 403) return 'denied';
  }
  return error instanceof ConflictError ? 'conflict' : 'retry';
}

interface RenamePorts {
  state: Pick<StateDB, 'getPendingFileRenames' | 'setPendingFileRenames' | 'getFile' | 'save'>;
  local: Pick<LocalAdapter, 'isFile'>;
  scope(): string;
  isExcluded(path: string): boolean;
  canMove?(source: string, destination: string): Promise<void>;
  move(source: string, destination: string, etag: string): Promise<void>;
  moveTracking(source: string, destination: string, file: FileState): void;
  isCancelled(): boolean;
}

/** Records the user's local rename before either path can fall into normal upload/deletion. */
export class PendingFileRenames {
  private readonly mutex = new AsyncMutex();

  constructor(private readonly deps: RenamePorts) {}

  list(): readonly PendingFileRename[] {
    return this.deps.state.getPendingFileRenames?.() ?? [];
  }

  holds(path: string): boolean {
    return this.list().some(rename => pathsOf(rename).some(root => within(path, root)));
  }

  touchesFolder(path: string): boolean {
    return this.list().some(rename => pathsOf(rename).some(candidate => within(candidate, path)));
  }

  /** Recording is synchronous so an already-running sync can see the hold at its next write. */
  capture(
    oldPath: string, newPath: string, origin: 'observed' | 'inferred' = 'observed',
    trackedSource = oldPath, firstUploadInFlight = false,
  ): boolean {
    if (oldPath === newPath || !validFilePath(oldPath) || !validFilePath(newPath)) return false;
    if (origin === 'inferred' && (this.holds(oldPath) || this.holds(newPath))) return false;
    const scope = this.deps.scope();
    const chain = this.list().find(rename => rename.destination === oldPath && rename.scope === scope);
    if (chain) {
      // An attempted MOVE may have reached the server even after a lost response. Verify before undoing.
      this.replace(chain.source, newPath === chain.source && !chain.attemptedDestination
        ? null : { ...chain, destination: newPath, issue: undefined });
      return true;
    }
    if (this.holds(trackedSource) || this.deps.isExcluded(trackedSource) || this.deps.isExcluded(newPath)) return false;
    const base = this.deps.state.getFile(trackedSource);
    if (!base && !firstUploadInFlight) return false;
    const intent: PendingFileRename = { source: trackedSource, destination: newPath, scope, fileId: base?.remoteFileId ?? null };
    if (origin === 'observed') intent.observed = true;
    if (!base) intent.unconfirmedCreate = true;
    this.deps.state.setPendingFileRenames([...this.list(), intent]);
    return true;
  }

  finishFirstUpload(path: string, file: FileState | null): boolean {
    const rename = this.current(path);
    if (!rename?.unconfirmedCreate || rename.scope !== this.deps.scope()) return false;
    // null is a deliberate skip before the request. A failed or missing response never calls this.
    this.replace(path, file ? { ...rename, fileId: file.remoteFileId, unconfirmedCreate: undefined } : null);
    return true;
  }

  captureFolder(oldPath: string, newPath: string): boolean {
    const scope = this.deps.scope();
    const existing = this.list();
    const updated = existing.flatMap(rename => {
      if (rename.scope !== scope) return [rename];
      const destination = rename.destination.startsWith(`${oldPath}/`) ? newPath + rename.destination.slice(oldPath.length) : rename.destination;
      if (!rename.attemptedDestination && !rename.unconfirmedCreate && rename.source.startsWith(`${oldPath}/`)
        && destination === newPath + rename.source.slice(oldPath.length)) return [];
      return [destination === rename.destination ? rename : { ...rename, destination }];
    });
    if (updated.length === existing.length && updated.every((rename, i) => rename === existing[i])) return false;
    this.deps.state.setPendingFileRenames(updated);
    return true;
  }

  rebaseAfterFolderMove(source: string, destination: string): void {
    const scope = this.deps.scope();
    const rebase = (path: string): string => path.startsWith(`${source}/`) ? destination + path.slice(source.length) : path;
    this.deps.state.setPendingFileRenames(this.list().flatMap(rename => {
      if (rename.scope !== scope) return [rename];
      const nextSource = rebase(rename.source);
      const attemptedDestination = rename.attemptedDestination ? rebase(rename.attemptedDestination) : undefined;
      if (nextSource === rename.destination && (!attemptedDestination || attemptedDestination === nextSource)) return [];
      return [{ ...rename, source: nextSource, attemptedDestination }];
    }));
  }

  retry(client: IWebDAVClient, shouldRetry: (rename: PendingFileRename) => boolean = () => true): Promise<boolean> {
    return this.mutex.run(async () => {
      let moved = false;
      for (const rename of this.list()) {
        if (this.deps.isCancelled()) break;
        if (!shouldRetry(rename)) continue;
        moved = await this.attempt(client, rename) || moved;
      }
      return moved;
    });
  }

  private async attempt(client: IWebDAVClient, rename: PendingFileRename): Promise<boolean> {
    const { source, destination, attemptedDestination } = rename;
    if (this.current(source) !== rename || rename.unconfirmedCreate) return false;
    const paths = pathsOf(rename);
    if (rename.scope !== this.deps.scope() || paths.some(path => !validFilePath(path) || this.deps.isExcluded(path))) {
      return this.recordIssue(source, 'scope');
    }
    if (this.list().some(other => other !== rename && pathsOf(other).some(held =>
      paths.some(path => within(path, held) || within(held, path))))) {
      return this.recordIssue(source, 'conflict');
    }
    const base = this.deps.state.getFile(source);
    if (!base || base.remoteFileId !== rename.fileId) return this.recordIssue(source, 'conflict');

    try {
      const [original, target, attempted] = await Promise.all([
        client.statFile(source, true),
        source !== destination ? client.statFile(destination) : Promise.resolve(null),
        attemptedDestination && attemptedDestination !== destination && attemptedDestination !== source
          ? client.statFile(attemptedDestination) : Promise.resolve(null),
      ]);
      if (this.current(source) !== rename) return false;
      const sameSource = original !== null && this.matchesOriginal(original, base);
      const arrived = [target, attempted].find(remote => remote !== null && rename.fileId && remote.fileId === rename.fileId);
      // An acknowledged or discovered MOVE may leave a new object at the old path. Its different identity is safe to leave alone.
      const normalizedArrival = arrived && source !== arrived.path
        && source.normalize('NFC') === arrived.path.normalize('NFC')
        && !await this.deps.local.isFile(source) && await this.deps.local.isFile(arrived.path);
      if ((!sameSource || normalizedArrival) && arrived) {
        await this.finishMove(rename, arrived.path, normalizedArrival ? { ...base, localMtime: undefined, localSize: undefined } : base);
        return true;
      }
      if (!sameSource || !original?.etag || target) return this.recordIssue(source, 'conflict');
      if (source === destination) {
        this.replace(source, null);
        await this.deps.state.save();
        return false;
      }
      if (!(await this.deps.local.isFile(destination))) return this.recordIssue(source, 'local-missing');
      // The absence of all file-change rights is a useful explicit signal. The actual MOVE still decides
      // for mixed permissions and for servers that omit the property.
      if (original.permissions && !/[DNVW]/.test(original.permissions)) return this.recordIssue(source, 'read-only');
      // A full scan (or an older queue entry with unknown origin) may mistake a delete plus a new
      // file for a rename. Keep the server file in place if its content or parent no longer match.
      if (!rename.observed && (parentDir(source) !== parentDir(destination) ||
          !(await this.hasTrackedContent(client, original, base)))) return this.recordIssue(source, 'conflict');
      await this.deps.canMove?.(source, destination);
      if (this.current(source) !== rename || this.deps.isCancelled()) return false;
      const prepared = { ...rename, attemptedDestination: destination };
      this.replace(source, prepared);
      await this.deps.state.save();
      const localFileExists = await this.deps.local.isFile(destination);
      if (this.current(source) !== prepared || this.deps.isCancelled() || prepared.scope !== this.deps.scope()) return false;
      if (!localFileExists) return this.recordIssue(source, 'local-missing');
      await this.deps.move(source, destination, original.etag);
      await this.finishMove(prepared, destination, base);
      return true;
    } catch (error) {
      return this.recordIssue(source, issueFor(error));
    }
  }

  private async hasTrackedContent(client: IWebDAVClient, original: RemoteFileInfo, base: FileState): Promise<boolean> {
    if (base.isConflicted || original.size !== base.size || base.size > MAX_HASH_SIZE) return false;
    if (original.checksum) return original.checksum === base.localHash;
    if (base.idType === 'etag' && original.etag === base.remoteId) return true;
    const bytes = await client.downloadFile(original.path);
    return bytes.byteLength === base.size && await sha256(bytes) === base.localHash;
  }

  private matchesOriginal(remote: RemoteFileInfo, base: FileState): boolean {
    if (base.remoteFileId) return remote.fileId === base.remoteFileId;
    const revision = remoteIdOf(remote);
    return revision.idType !== 'size' && revision.idType === base.idType && revision.remoteId === base.remoteId;
  }

  private async finishMove(rename: PendingFileRename, destination: string, base: FileState): Promise<void> {
    const current = this.current(rename.source);
    if (!current || current.scope !== rename.scope) return;
    this.deps.moveTracking(rename.source, destination, base);
    this.replace(rename.source, current.destination === destination ? null : {
      ...current, source: destination, attemptedDestination: undefined, issue: undefined,
    });
    await this.deps.state.save();
  }

  private current(source: string): PendingFileRename | undefined {
    return this.list().find(rename => rename.source === source);
  }

  private replace(source: string, next: PendingFileRename | null): void {
    const remaining = this.list().filter(rename => rename.source !== source);
    this.deps.state.setPendingFileRenames(next ? [...remaining, next] : remaining);
  }

  private async recordIssue(source: string, issue: FileRenameIssue): Promise<false> {
    const current = this.current(source);
    if (current && current.issue !== issue) {
      this.replace(source, { ...current, issue });
      await this.deps.state.save();
    }
    return false;
  }
}

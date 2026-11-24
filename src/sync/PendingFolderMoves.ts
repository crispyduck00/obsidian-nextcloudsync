import type { LocalAdapter } from '../data/LocalAdapter';
import type { StateDB } from '../data/StateDB';
import type { IWebDAVClient } from '../network/IWebDAVClient';
import { isSafeVaultRelativePath } from '../network/remotePath';
import { FolderMoveBlockedError, NetworkError, type FolderMoveIssue, type PendingFolderMove } from '../types';

const messages: Record<FolderMoveIssue, string> = {
  locked: 'Nextcloud has locked the folder or a file inside it. Sync will retry the move.',
  protected: 'Nextcloud reports restricted access or a storage boundary. Review the move in Nextcloud or move the local folder back.',
  conflict: 'The source or destination has changed. Review both paths in Nextcloud or move the local folder back.',
  'local-missing': 'The renamed local folder is missing. Restore it or move it back before syncing.',
  scope: 'The folder contains paths outside the current sync scope. Move it back or review the exclusions.',
  unsupported: 'This server could not protect the folder move. If the original folder is present, move it to the same destination in Nextcloud or move the local folder back.',
  unobserved: 'This folder may have moved while Obsidian was closed. Verify the original folder and complete the move in Nextcloud, or move the local folder back.',
  retry: 'Sync could not confirm the folder move. It will check again on the next sync.',
};

export function folderMoveStatus(move: PendingFolderMove): string {
  return move.issue ? messages[move.issue] : 'Waiting to sync the folder move.';
}

export function inFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function pathsOf(move: PendingFolderMove): string[] {
  return move.attemptedDestination ? [move.source, move.destination, move.attemptedDestination] : [move.source, move.destination];
}

function validPath(path: string): boolean {
  return !!path && isSafeVaultRelativePath(path) && path.split('/').every(segment => segment && segment !== '.');
}

function issueFor(error: unknown): FolderMoveIssue {
  if (error instanceof FolderMoveBlockedError) return error.issue;
  if (error instanceof NetworkError) {
    if (error.status === 423) return 'locked';
    if (error.status === 403) return 'protected';
    if (error.status === 412 || error.status === 404) return 'conflict';
  }
  return 'retry';
}

interface FolderMovePorts {
  state: Pick<StateDB, 'getPendingFolderMoves' | 'setPendingFolderMoves' | 'getDir' | 'getAllDirs' | 'getAllFiles' | 'save'>;
  local: Pick<LocalAdapter, 'isFolder'>;
  scope(): string;
  isExcluded(path: string): boolean;
  containsExcludedFolder(path: string): boolean;
  canWrite(client: IWebDAVClient, source: string, destination: string): Promise<void>;
  prepareTracking(source: string, destination: string): Promise<{ commit(): void; cleanOldCaches(): void }>;
  isCancelled(): boolean;
}

/** Keeps both trees out of ordinary reconciliation until the original collection is located. */
export class PendingFolderMoves {
  constructor(private readonly deps: FolderMovePorts) {}

  list(): readonly PendingFolderMove[] {
    return this.deps.state.getPendingFolderMoves?.() ?? [];
  }

  holds(path: string): boolean {
    return this.list().some(move => pathsOf(move).some(folder => inFolder(path, folder)));
  }

  touchesFolder(path: string): boolean {
    return this.list().some(move => pathsOf(move).some(folder => inFolder(path, folder) || inFolder(folder, path)));
  }

  coversChildEvent(oldPath: string, newPath: string): boolean {
    return this.list().some(move => oldPath !== move.source && inFolder(oldPath, move.source)
      && newPath === move.destination + oldPath.slice(move.source.length));
  }

  originalPath(path: string): string {
    const root = this.list().filter(move => move.scope === this.deps.scope() && inFolder(path, move.destination))
      .sort((a, b) => b.destination.length - a.destination.length)[0];
    return root ? root.source + path.slice(root.destination.length) : path;
  }

  capture(oldPath: string, newPath: string, inferred = false): boolean {
    if (oldPath === newPath || !validPath(oldPath) || !validPath(newPath) || this.coversChildEvent(oldPath, newPath)) return false;
    const scope = this.deps.scope();
    const existing = this.list();
    const chain = existing.find(move => move.scope === scope && move.destination === oldPath);
    const ancestor = existing.filter(move => move.scope === scope && inFolder(oldPath, move.destination))
      .sort((a, b) => b.destination.length - a.destination.length)[0];
    const source = chain?.source ?? (ancestor ? ancestor.source + oldPath.slice(ancestor.destination.length) : oldPath);
    const base = this.deps.state.getDir(source);
    if (!chain && (this.current(source) || (!base && !this.deps.state.getAllFiles().some(file => inFolder(file.path, source))
      && !this.deps.state.getAllDirs().some(dir => inFolder(dir.path, source))))) return false;

    const next: PendingFolderMove = { ...chain, source, destination: newPath, scope,
      fileId: chain?.fileId ?? base?.remoteFileId ?? null, issue: inferred ? 'unobserved' : undefined,
      inferred: inferred || chain?.inferred ? true : undefined };
    const remaining = existing.filter(move => move !== chain && !(move.scope === scope && !move.attemptedDestination
      && inFolder(move.source, source) && move.destination === newPath + move.source.slice(source.length)));
    this.deps.state.setPendingFolderMoves([...remaining.map(move => move.scope === scope && inFolder(move.destination, oldPath)
      ? { ...move, destination: newPath + move.destination.slice(oldPath.length) } : move), next]);
    return true;
  }

  // Called inside the full-sync gate. Capturing later user events stays synchronous while a request is in flight.
  async retry(client: IWebDAVClient): Promise<void> {
    const ordered = [...this.list()].sort((a, b) => a.source.length - b.source.length);
    for (const move of ordered) {
      if (this.deps.isCancelled()) break;
      if (this.current(move.source) === move) await this.attempt(client, move);
    }
  }

  private async attempt(client: IWebDAVClient, move: PendingFolderMove): Promise<void> {
    const { source, destination, fileId, attemptedDestination } = move;
    const paths = pathsOf(move);
    if (move.scope !== this.deps.scope() || paths.some(path => !validPath(path))) return this.recordIssue(move, 'scope');
    if (source === destination && !attemptedDestination && await this.deps.local.isFolder(source)) {
      if (this.current(source) === move) {
        this.replace(move, null);
        await this.deps.state.save();
      }
      return;
    }
    if (!fileId || !client.statFolderMovePath) return this.recordIssue(move, 'unsupported');
    if (source !== destination && (inFolder(destination, source) || inFolder(source, destination))) return this.recordIssue(move, 'conflict');
    if (this.list().some(other => other !== move && pathsOf(other).some(path => paths.some(folder =>
      (inFolder(path, folder) || inFolder(folder, path)) && !(!other.attemptedDestination && other.source !== source
        && inFolder(other.source, source)))))) return this.recordIssue(move, 'conflict');

    let arrived: string | undefined;
    try {
      const probes = [...new Set(paths)];
      const results = new Map(await Promise.all(probes.map(async path => [path, await client.statFolderMovePath!(path)] as const)));
      if (this.current(source) !== move) return;
      const original = results.get(source)?.directoryId === fileId;
      const arrivals = probes.filter(path => path !== source && results.get(path)?.directoryId === fileId);
      if (arrivals.length > 1 || (original && arrivals.length)) return this.recordIssue(move, 'conflict');
      if (!original && arrivals.length === 1) {
        arrived = arrivals[0];
      } else if (!original || (source !== destination && results.get(destination))) {
        return this.recordIssue(move, 'conflict');
      } else if ((source === destination || (move.inferred && !await this.deps.local.isFolder(destination)))
        && await this.deps.local.isFolder(source)) {
        if (this.current(source) === move) {
          this.replace(move, null);
          await this.deps.state.save();
        }
        return;
      } else {
        if (move.inferred) return this.recordIssue(move, 'unobserved');
        if (!client.moveTrackedFolder) return this.recordIssue(move, 'unsupported');
        if (paths.some(path => this.deps.isExcluded(path) || this.deps.containsExcludedFolder(path))) return this.recordIssue(move, 'scope');
        if (!await this.deps.local.isFolder(destination)) return this.recordIssue(move, 'local-missing');
        if (this.trackingOccupied(destination)) return this.recordIssue(move, 'conflict');
        await this.deps.canWrite(client, source, destination);
        if (this.current(source) !== move || this.deps.isCancelled()) return;
        const prepared = { ...move, attemptedDestination: destination };
        this.replace(move, prepared);
        await this.deps.state.save();
        const canSend = async (): Promise<boolean> => {
          await this.deps.canWrite(client, source, destination);
          return await this.deps.local.isFolder(destination) && this.current(source) === prepared
            && !this.deps.isCancelled() && prepared.scope === this.deps.scope()
            && !paths.some(path => this.deps.isExcluded(path) || this.deps.containsExcludedFolder(path));
        };
        if (!(await canSend())) return;
        await client.moveTrackedFolder(source, destination, fileId, canSend, path => this.deps.isExcluded(path));
        if ((await client.statFolderMovePath(destination))?.directoryId !== fileId) throw new FolderMoveBlockedError('conflict');
        arrived = destination;
      }
    } catch (error) {
      const current = this.current(source);
      if (current?.destination === destination && current.scope === move.scope) await this.recordIssue(current, issueFor(error));
      return;
    }

    if (this.trackingOccupied(arrived)) return this.recordIssue(this.current(source) ?? move, 'conflict');
    const tracking = await this.deps.prepareTracking(source, arrived);
    const current = this.current(source);
    if (!current || current.scope !== this.deps.scope()) return;
    tracking.commit();
    const updated = this.list().filter(other => other !== current).map(other => other.scope === current.scope
      && other.source !== source && inFolder(other.source, source)
      ? { ...other, source: arrived + other.source.slice(source.length) } : other);
    if (current.destination !== arrived) updated.push({ ...current, source: arrived, attemptedDestination: undefined, issue: undefined });
    this.deps.state.setPendingFolderMoves(updated);
    await this.deps.state.save();
    tracking.cleanOldCaches();
  }

  private trackingOccupied(path: string): boolean {
    return this.deps.state.getAllDirs().some(dir => inFolder(dir.path, path))
      || this.deps.state.getAllFiles().some(file => inFolder(file.path, path));
  }

  private current(source: string): PendingFolderMove | undefined {
    return this.list().find(move => move.source === source);
  }

  private replace(current: PendingFolderMove, next: PendingFolderMove | null): void {
    this.deps.state.setPendingFolderMoves(this.list().flatMap(move => move === current ? (next ? [next] : []) : [move]));
  }

  private async recordIssue(move: PendingFolderMove, issue: FolderMoveIssue): Promise<void> {
    if (move.issue === issue || this.current(move.source) !== move) return;
    this.replace(move, { ...move, issue });
    await this.deps.state.save();
  }
}

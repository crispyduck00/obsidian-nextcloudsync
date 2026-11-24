// Three-way comparison (local / remote / tracked) applied to folder creation and remote-to-local removal
// (docs/spec.md §8a, docs/plan.md §16). A partial remote listing looks like
// "the user deleted most folders", so beyond the mass-delete threshold the destructive half of the plan is
// refused wholesale and recorded as a session error; the resolve* methods settle those paths on demand.
import { TFolder, normalizePath, Vault, App } from 'obsidian';
import { SyncSessionSummary, RemoteDirInfo } from '../../types';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import {
  classifyDirectories, shouldTripMassDeleteBreaker, breakerDenominator,
} from './classify';
import { dropSubtreeTracking } from '../deletion/subtreeTracking';
import { removeEmptyLocalDirectory } from '../deletion/removeEmptyLocalDirectory';
import { ancestorMatching } from '../policy';
import { FileLogger } from '../../util/FileLogger';

export interface DirectoryDeps {
  app: App;
  stateDB: Pick<StateDB,
    'getAllDirs' | 'setDir' | 'deleteDir' | 'requestSave' | 'getAllFiles' | 'deleteFile'>;
  journal: SyncJournal;
  // Dropped alongside the file state when a trashed folder's subtree stops being tracked.
  mergeBase: Pick<MergeBaseRecorder, 'drop'>;
  dropCleanSnapshot(path: string): void;
  // Registers a path so the vault event this plugin causes is not fed back to the watcher. Required: an
  // unwired no-op here turns a plugin trash back into a server DELETE.
  markOwnEvent: (path: string) => void;
  isSystemExcluded(path: string): boolean;
  hasRenameInFolder?(path: string): boolean;
  isRenameHeld?(path: string): boolean;
  massDeleteLimit(): number;
  // Checked between directory operations so a cancel takes effect promptly.
  isCancelled(): boolean;
  logger?: Pick<FileLogger, 'log'>;
}

export class DirectoryReconciler {
  constructor(private readonly deps: DirectoryDeps) {}

  async reconcileDirectories(
    client: IWebDAVClient, summary: SyncSessionSummary, cachedDirs?: RemoteDirInfo[], skipLocalRemovals = false,
    isHeld: (path: string) => boolean = () => false,
  ): Promise<void> {
    let remoteDirInfos: RemoteDirInfo[];
    if (cachedDirs) {
      // Root-ETag short-circuit: the remote is unchanged since the last real scan, so the tracked set IS the
      // remote set (docs/spec.md §8a.5); skip the Depth:infinity PROPFIND.
      remoteDirInfos = cachedDirs;
    } else {
      try {
        remoteDirInfos = await client.getDirectories('');
      } catch (err) {
        void this.deps.logger?.log(`dir-sync: listing failed — skip this session: ${(err as Error).message}`);
        return; // self-heals next sync
      }
    }

    const norm = (p: string): string => p.replace(/\/+$/, '');
    const remoteDirs = new Map(remoteDirInfos.map(d => [norm(d.path), d]));
    const localDirs = this.localDirectories();
    const tracked = new Map(this.deps.stateDB.getAllDirs().map(d => [d.path, d]));

    const plan = classifyDirectories(remoteDirs, localDirs, tracked, p =>
      isHeld(p) || this.deps.isSystemExcluded(p) || this.deps.isRenameHeld?.(p) === true);
    plan.trashLocal = plan.trashLocal.filter(path => !this.deps.hasRenameInFolder?.(path));
    const { mkcolRemote, mkdirLocal, deleteRemote, trashLocal, ensureTracked, dropTracked } = plan;

    // Circuit breaker: a partial listing would make many dirs look deleted.
    if (shouldTripMassDeleteBreaker({ ...plan, deleteRemote: [] }, breakerDenominator(remoteDirs, localDirs, tracked), this.deps.massDeleteLimit())) {
      void this.deps.logger?.log(`dir-sync: SKIPPED ${trashLocal.length} local dir deletions — exceeds safety limit; likely a partial listing`);
      // Recorded as an error so the root-ETag convergence gate invalidates the stored etag and the next sync
      // re-scans instead of short-circuiting on stale state (docs/spec.md §8a.5).
      const skippedTrashLocal = [...trashLocal];
      this.deps.journal.recordError(
        summary, '(dir mass-delete breaker)',
        new Error(`Skipped ${trashLocal.length} local dir deletions — exceeds safety limit`),
        undefined,
        { deleteRemote: [], trashLocal: skippedTrashLocal },
      );
      trashLocal.length = 0;
    }

    const shallowFirst = (a: string, b: string): number => a.split('/').length - b.split('/').length;
    const deepFirst = (a: string, b: string): number => b.split('/').length - a.split('/').length;

    // Parents before children.
    for (const p of mkcolRemote.sort(shallowFirst)) {
      if (this.deps.isCancelled()) break;
      if (this.deps.isRenameHeld?.(p)) continue;
      if (ancestorMatching(p, parent => tracked.has(parent) && !remoteDirs.has(parent))) continue;
      try {
        await client.createDirectory(p);
        const current = await client.statFolderMovePath?.(p);
        if (this.deps.isRenameHeld?.(p)) continue;
        this.deps.stateDB.setDir({ path: p, remoteFileId: current?.directoryId ?? remoteDirs.get(p)?.fileId ?? null });
        this.deps.journal.recordHistory(p, 'uploaded');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir create (remote) failed: ${(err as Error).message}` });
      }
    }
    // Parents before children.
    for (const p of mkdirLocal.sort(shallowFirst)) {
      if (this.deps.isCancelled()) break;
      if (this.deps.isRenameHeld?.(p)) continue;
      try {
        await this.deps.app.vault.adapter.mkdir(normalizePath(p));
        this.deps.stateDB.setDir({ path: p, remoteFileId: remoteDirs.get(p)?.fileId ?? null });
        this.deps.journal.recordHistory(p, 'downloaded');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir create (local) failed: ${(err as Error).message}` });
      }
    }
    // WebDAV DELETE on a collection is recursive, with no portable "only if empty" condition.
    // Keep the tracking entries so a known local removal does not re-create the folder on this device.
    for (const path of deleteRemote) void this.deps.logger?.log(`dir-sync: remote folder retained → ${path}`);
    // Children before parents.
    for (const p of trashLocal.sort(deepFirst)) {
      if (skipLocalRemovals || this.deps.isCancelled()) break;
      // A folder absent from the listing is a reason to look, not to delete (issue #46): one missing folder
      // is below the mass-delete breaker. remoteExists treats everything but a definitive 404 as present, and
      // a rejecting client likewise: no proof, no deletion. The folder stays tracked for the next listing.
      let confirmedGone = false;
      try { confirmedGone = !(await client.remoteExists(p)); } catch { confirmedGone = false; }
      if (!confirmedGone) {
        void this.deps.logger?.log(`dir-sync: listing omitted ${p} but the server still has it — keeping it (not trashed)`);
        continue;
      }
      if (this.deps.hasRenameInFolder?.(p)) continue;
      try {
        if (!(await removeEmptyLocalDirectory(this.deps.app, p, this.deps.markOwnEvent))) {
          if (!summary.errors.some(error => error.path === p)) {
            this.deps.journal.recordError(summary, p, new Error('The remote folder is missing or inaccessible. Local items were kept.'));
          }
          continue;
        }
        this.forgetSubtree(p);
        this.deps.journal.recordHistory(p, 'deleted');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir delete (local) failed: ${(err as Error).message}` });
      }
    }
    for (const d of ensureTracked) this.deps.stateDB.setDir(d);
    for (const p of dropTracked) this.deps.stateDB.deleteDir(p);
  }

  private localDirectories(): Set<string> {
    const vault = this.deps.app.vault as Vault & { getAllFolders?: (includeRoot?: boolean) => TFolder[] };
    return new Set((vault.getAllFolders?.() ?? []).map(f => f.path).filter(p => p && p !== '/'));
  }

  countMissingLocalCopies(remotePaths: ReadonlySet<string>, isHeld: (path: string) => boolean): number {
    const local = this.localDirectories();
    return this.deps.stateDB.getAllDirs().filter(d => local.has(d.path)
      && !remotePaths.has(d.path) && !isHeld(d.path) && !this.deps.hasRenameInFolder?.(d.path) && !this.deps.isSystemExcluded(d.path)).length;
  }

  // Only ever called after a successful trash.
  private forgetSubtree(path: string): void {
    const dropped = dropSubtreeTracking(this.deps, path);
    if (dropped.files + dropped.dirs > 0) {
      void this.deps.logger?.log(
        `dir-sync: plugin trash — dropped tracking for ${dropped.files} files / ${dropped.dirs} dirs under ${path} (not a local deletion)`,
      );
    }
  }

  // Resolves one breaker-skipped directory immediately. `category` is the side reconcileDirectories would have
  // deleted from (`deleteRemote`: local absent/remote present; `trashLocal`: the reverse). `choice` "remote" makes
  // local match remote, "local" the reverse. Recreated directories get `remoteFileId: null`; the next full sync
  // fills in the real id. Throws without touching StateDB; resolveAllSkippedDirs isolates per-path failures.
  async resolveSkippedDir(
    client: IWebDAVClient,
    path: string,
    category: 'deleteRemote' | 'trashLocal',
    choice: 'remote' | 'local',
  ): Promise<void> {
    if (this.deps.hasRenameInFolder?.(path)) throw new Error('This folder contains a pending rename.');
    if (category === 'deleteRemote') {
      if (choice === 'remote') {
        // Remote is correct: undo the apparent local deletion by recreating the folder locally.
        await this.deps.app.vault.adapter.mkdir(normalizePath(path));
        this.deps.stateDB.setDir({ path, remoteFileId: null });
      } else {
        throw new Error('Remove the folder in Nextcloud to remove it from the shared vault.');
      }
    } else {
      if (choice === 'remote') {
        // Remote absence is correct: let the deletion proceed locally.
        if (await client.remoteExists(path)) throw new Error('The folder is visible on Nextcloud again. Run Sync now.');
        if (!(await removeEmptyLocalDirectory(this.deps.app, path, this.deps.markOwnEvent))) {
          throw new Error('The local folder still contains files or folders. Review them before removing it.');
        }
        this.forgetSubtree(path);

      } else {
        // Local is correct: undo the apparent remote deletion by recreating it on the remote.
        await client.createDirectory(path);
        this.deps.stateDB.setDir({ path, remoteFileId: null });
      }
    }
    this.deps.stateDB.requestSave();
  }

  // Applies one choice to every path in the `(dir mass-delete breaker)` error's `dirBreakerSkipped`, tallying
  // per-path failures instead of throwing. Mutates the caller's summary errors IN PLACE (removes the entry, or
  // narrows it to the failed paths) because getStatusReport() returns the same `lastSummary` reference.
  // The caller must refuse to run this during a full sync: reconcileDirectories uses the same StateDB rows.
  async resolveAllSkippedDirs(
    client: IWebDAVClient,
    lastSummary: SyncSessionSummary | null,
    choice: 'remote' | 'local',
  ): Promise<{ resolved: number; failed: number }> {
    const errors = lastSummary?.errors;
    const entry = errors?.find((e) => e.path === '(dir mass-delete breaker)' && e.dirBreakerSkipped);
    if (!entry?.dirBreakerSkipped) return { resolved: 0, failed: 0 };

    const candidates: { path: string; category: 'deleteRemote' | 'trashLocal' }[] = [
      ...entry.dirBreakerSkipped.deleteRemote.map((path) => ({ path, category: 'deleteRemote' as const })),
      ...entry.dirBreakerSkipped.trashLocal.map((path) => ({ path, category: 'trashLocal' as const })),
    ];

    let resolved = 0;
    const failedDeleteRemote: string[] = [];
    const failedTrashLocal: string[] = [];
    for (const { path, category } of candidates) {
      try {
        await this.resolveSkippedDir(client, path, category, choice);
        resolved++;
      } catch {
        (category === 'deleteRemote' ? failedDeleteRemote : failedTrashLocal).push(path);
      }
    }

    const failed = failedDeleteRemote.length + failedTrashLocal.length;
    if (failed === 0) {
      const idx = errors!.indexOf(entry);
      if (idx >= 0) errors!.splice(idx, 1);
    } else {
      entry.dirBreakerSkipped = { deleteRemote: failedDeleteRemote, trashLocal: failedTrashLocal };
    }
    return { resolved, failed };
  }
}

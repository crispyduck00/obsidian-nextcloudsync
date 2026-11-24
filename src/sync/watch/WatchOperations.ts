// Watch-mode single-file and single-folder operations: one file saved, deleted, renamed; one folder created,
// deleted, renamed. Each touches one path and avoids the full-vault scan and remote listing (docs/spec.md §5.7).
//
// Unlike the other extracted modules this one CALLS INTO the sync loop: deciding what to do with a changed
// file is the full sync's classifier, reached through the `processFile` port rather than an engine import.
//
// Rules that run through all of it:
//   Never run alongside a full sync. A multi-step resolve must not interleave with the full sync writing the
//   same file. Edits are DEFERRED (re-evaluated when the run ends); deletions are DROPPED, since the running
//   scan already propagates a tracked path that vanished locally and queuing one risks a second delete.
//   Stay silent unless the user has to know: only a failure or a genuine divergence raises a notice.
//   Respect "Wi-Fi only": on cellular each operation does nothing, and the next full sync's scan picks the
//   change up (docs/spec.md §5.7c).
import { Notice } from 'obsidian';
import { FileState, RemoteFileInfo, SyncSessionSummary, NetworkError } from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { SyncHistoryStore } from '../../data/SyncHistoryStore';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy } from '../upload/IUploadStrategy';
import { IStatusBar } from '../../ui/StatusBarItem';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { TransferService } from '../transfer/TransferService';
import { DeletionService } from '../deletion/DeletionService';
import { ResolutionService } from '../resolution/ResolutionService';
import { isLocallyUnchanged } from '../policy';
import { FileLogger } from '../../util/FileLogger';
import { sha256 } from '../../util/hash';
import { AsyncMutex } from '../../util/AsyncMutex';
import { assertTrackedParentReadable, type RemoteFolderGuard } from '../directory/RemoteFolderGuard';

// Operation names used in the "skipped on cellular" log line.
type WatchOpName = 'sync' | 'delete' | 'rename' | 'folder-create' | 'folder-delete' | 'folder-rename';

export interface Connection {
  client: IWebDAVClient;
  uploadStrategy: IUploadStrategy;
}

/** Result of one remote-triggered single-file reconciliation. */
export type RemoteFileReconcileResult = 'done' | 'deferred' | 'plugin-pending' | 'busy' | 'full-sync';

export interface WatchDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'readBinary'>;
  stateDB: Pick<StateDB, 'getFile' | 'deleteFile' | 'getDir' | 'setDir' | 'deleteDir' | 'requestSave' | 'getLastSyncTime'>
    & Partial<Pick<StateDB, 'getRemoteRootFileId'>>;
  historyStore?: Pick<SyncHistoryStore, 'save'>;
  statusBar: IStatusBar;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  transfer: TransferService;
  deletion: DeletionService;
  remoteFolders?: RemoteFolderGuard;
  resolution: Pick<ResolutionService, 'dropCleanSnapshot'>;
  isSystemExcluded(path: string): boolean;
  reconcileFolderMove?(): Promise<void>;
  // Plugin files sync only in full runs; watch mode never handles them.
  isPluginPath(path: string): boolean;
  connect(): Promise<Connection>;
  isRenameHeld?(path: string): boolean;
  hasRenameInFolder?(path: string): boolean;
  retryFileRename(client: IWebDAVClient, source: string, destination: string): Promise<boolean>;

  // The SAME "Wi-Fi only" decision the full sync makes at its entry. True skips the operation entirely: no
  // network, no local write, no StateDB change.
  isBlockedByWifiOnly(): boolean;
  isSyncRunning(): boolean;
  /** Run one lightweight operation under the engine's shared activity gate. */
  runNonFullSyncOperation<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * The full sync's per-file classifier. Injected as a port rather than imported: upstream change (C-3)
   * settled that watch mode and "Sync now" must reach identical results, which means watch mode runs
   * the same decision code instead of a second copy of it.
   */
  processFile(remote: RemoteFileInfo, summary: SyncSessionSummary): Promise<void>;
  // Outbound port: this path needs another attempt on the next sync.
  queueRetry(path: string): void;
  /** Number of paths currently waiting for an ordinary-sync retry. */
  retryQueueLength?(): number;
  /** How many conflicts the engine has encountered so far (see notifyWatchOutcome). */
  conflictEncounters(): number;
  logger?: Pick<FileLogger, 'log'>;
  // Injected so the outcome rules can be exercised without an Obsidian runtime.
  notify?(message: string, timeout?: number): void;
}

export class WatchOperations {
  // Watch-mode ops currently propagating to the remote; drives the status bar.
  private inFlight = 0;

  // One mutex per path so two watch cycles for the SAME file never interleave: a cycle that PROPFINDs after its
  // predecessor's upload but before its baseline write sees a phantom remote change and would resolve a conflict
  // over the file being edited (issue #42, docs/spec.md §5.7b). Keyed by path, not global, because syncing is
  // mostly network wait and one lock would serialize every file. Entries are not evicted: the map is bounded by
  // paths touched per session, and a wrong eviction predicate would silently drop exclusion.
  private readonly pathLocks = new Map<string, AsyncMutex>();

  // Paths whose single-file sync arrived while a full sync was running, drained when the run finishes (deferred,
  // not dropped, since the full sync may already have passed that file). In memory only: losing them on reload is
  // harmless because the next full sync detects the same change, and persisting would add a second source of truth.
  private readonly pendingPaths = new Set<string>();

  constructor(private readonly deps: WatchDeps) {}

  // Guarded by the running check so it never fights a concurrent full sync, which owns the status during its run.
  private begin(): void {
    this.inFlight++;
    if (!this.deps.isSyncRunning()) this.deps.statusBar.setStatus('syncing', { automatic: true });
  }

  private end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0 && !this.deps.isSyncRunning()) this.deps.statusBar.setStatus('idle');
  }

  // Decided at execution time, before any lock, StateDB read or network call, so a skip leaves nothing behind:
  // the next full sync finds the change on its own scan. Silent apart from one log line.
  private skippedOnCellular(op: WatchOpName, target: string): boolean {
    if (!this.deps.isBlockedByWifiOnly()) return false;
    void this.deps.logger?.log(`watch: skipped ${op} ${target} — Wi-Fi only is on and the connection is cellular`);
    return true;
  }

  private withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.pathLocks.get(path);
    if (!lock) { lock = new AsyncMutex(); this.pathLocks.set(path, lock); }
    return lock.run(fn);
  }

  // Locks are taken in lexicographic order: renames crossing in opposite directions (a to b and b to a) would
  // otherwise each hold what the other waits for.
  private withTwoPathLocks<T>(a: string, b: string, fn: () => Promise<T>): Promise<T> {
    if (a === b) return this.withPathLock(a, fn);
    const [first, second] = a < b ? [a, b] : [b, a];
    return this.withPathLock(first, () => this.withPathLock(second, fn));
  }

  // Fetches the remote's current state, then hands it to the SAME classifier the full sync uses (processFile), so
  // a blind PUT can never overwrite another device's edit silently (issue #23). No decision lives here.
  async syncSingleFile(path: string): Promise<void> {
    if (this.deps.isRenameHeld?.(path)) return;
    if (this.deps.isSystemExcluded(path) || this.deps.isPluginPath(path)) return;
    if (this.skippedOnCellular('sync', path)) return;
    // The early exits stay OUTSIDE the lock: neither touches shared state and a no-op must not queue behind real work.
    return this.withPathLock(path, () => this.syncSingleFileLocked(path));
  }

  /**
   * Reconcile ONE file named by Nextcloud Client Push. Unlike syncSingleFile, this intentionally does
   * not use the local-unchanged fast path: the trigger itself says the REMOTE side may have changed.
   * The path lock is shared with local watch operations so a local edit and a remote push for the
   * same note cannot classify against half-written state.
   */
  async reconcileRemoteFile(path: string, expectedRemoteFileId: string): Promise<RemoteFileReconcileResult> {
    if (this.deps.isPluginPath(path)) return 'plugin-pending';
    if (this.deps.isSystemExcluded(path)) return 'done';
    return this.withPathLock(path, () => this.reconcileRemoteFileLocked(path, expectedRemoteFileId));
  }

  private async reconcileRemoteFileLocked(
    path: string,
    expectedRemoteFileId: string,
  ): Promise<RemoteFileReconcileResult> {
    // If the full sync requested exclusivity first, let the push scheduler retain this ID and retry
    // afterwards. If we acquire shared activity first, the full sync gate waits for us.
    if (this.deps.isSyncRunning()) return 'busy';
    const work = (): Promise<RemoteFileReconcileResult> => this.reconcileRemoteFileActive(path, expectedRemoteFileId);
    return this.deps.runNonFullSyncOperation ? this.deps.runNonFullSyncOperation(work) : work();
  }

  private async reconcileRemoteFileActive(
    path: string,
    expectedRemoteFileId: string,
  ): Promise<RemoteFileReconcileResult> {
    const summary = this.deps.journal.newSummary();
    const conflictsBefore = this.deps.conflictEncounters();
    const retriesBefore = this.deps.retryQueueLength?.() ?? 0;
    let result: RemoteFileReconcileResult = 'done';
    this.begin();
    try {
      const conn = await this.deps.connect();
      const remote = await conn.client.statFile(path);
      if (!remote) {
        // A known file disappeared at its old path: delete vs rename/move is ambiguous from one
        // file-ID notification alone. The ordinary full sync already has safe deletion/rename logic.
        void this.deps.logger?.log(`client-push: ${path} no longer exists at tracked path → full reconciliation`);
        result = 'full-sync';
      } else if (remote.fileId !== expectedRemoteFileId) {
        // The old path may have been re-used after a rename. Never classify a different Nextcloud
        // object under stale StateDB identity; let the full scan/rename tracker repair the mapping.
        void this.deps.logger?.log(
          `client-push: file id mismatch at ${path} (expected ${expectedRemoteFileId}, got ${remote.fileId ?? 'none'}) → full reconciliation`,
        );
        result = 'full-sync';
      } else {
        if (conn.client.inspectDirectory) await assertTrackedParentReadable(conn.client, this.deps.stateDB, path);
        void this.deps.logger?.log(`client-push: remote state fetched → classifying ${path}`);
        await this.deps.processFile(remote, summary);
        this.deps.stateDB.requestSave();
        await this.deps.historyStore?.save();

        // processFileWithRetry intentionally contains many failures instead of throwing, and a
        // remote->local write can also be deferred while the user is typing. Neither outcome may
        // certify the push root ETag as fully processed. The ordinary sync/retry queue remains the
        // authority for that unresolved work. Size-limit skips also leave the notified file unapplied.
        if (
          summary.errorCount > 0 || summary.conflictedCount > 0 || summary.oversizeSkippedPaths.size > 0
          || (this.deps.retryQueueLength?.() ?? retriesBefore) > retriesBefore
        ) {
          result = 'deferred';
        }
      }
    } catch (err) {
      // Match watch-mode failure semantics: keep the path for the next ordinary sync on transport
      // failure, record the error, and never bypass the established classifier with an ad-hoc write.
      console.warn(`[SyncEngine] Remote push reconcile failed for ${path}:`, err);
      void this.deps.logger?.log(`client-push: FAILED ${path} — ${(err as Error).message}`, 'error');
      this.deps.journal.recordError(summary, path, err);
      if (err instanceof NetworkError) this.deps.queueRetry(path);
      result = 'deferred';
    } finally {
      this.end();
    }
    this.notifyWatchOutcome(path, summary, conflictsBefore);
    return result;
  }


  private async syncSingleFileLocked(path: string): Promise<void> {
    if (this.deps.isRenameHeld?.(path)) return;
    // Never run alongside a full sync: defer the path and re-evaluate it when the run finishes. Deferring, not
    // dropping, keeps the edit from being missed if the full sync already passed this file.
    if (this.deps.isSyncRunning()) {
      this.pendingPaths.add(path);
      void this.deps.logger?.log(`watch: full sync in progress → deferred ${path}`);
      return;
    }
    return this.deps.runNonFullSyncOperation(() => this.syncSingleFileActive(path));
  }

  private async syncSingleFileActive(path: string): Promise<void> {
    const stat = await this.deps.localAdapter.stat(path);
    if (!stat) return; // already deleted before the debounce fired
    const base = this.deps.stateDB.getFile(path);
    // Decide "nothing changed" from LOCAL data only, before touching the network: the stat-signature fast path
    // answers most saves without reading the file, and a miss falls back to hashing.
    if (base && this.locallyUnchanged(base, stat)) return;
    const data = await this.deps.localAdapter.readBinary(path);
    const localHash = await sha256(data);
    if (base && localHash === base.localHash) return; // content unchanged (e.g. mtime-only touch)

    const conn = await this.deps.connect();
    // A real summary: its counters decide whether to notify the user, and processFile maintains them as in a full sync.
    const summary = this.deps.journal.newSummary();
    const conflictsBefore = this.deps.conflictEncounters();
    this.begin();
    try {
      if (conn.client.inspectDirectory) await assertTrackedParentReadable(conn.client, this.deps.stateDB, path);
      const remote = await conn.client.statFile(path);
      if (remote) {
        void this.deps.logger?.log(`watch: remote state fetched → classifying ${path}`);
        await this.deps.processFile(remote, summary);
      } else {
        if (base) throw new Error('The remote file is missing or inaccessible. Local changes were kept.');
        if (!conn.client.inspectDirectory) await assertTrackedParentReadable(conn.client, this.deps.stateDB, path);
        // Not on the server at all: a plain create. If-Match against a non-existent resource always fails,
        // so keep the synthetic null etag.
        void this.deps.logger?.log(`watch: not on remote → upload as new ${path}`);
        await this.deps.transfer.uploadFile(
          conn.client, conn.uploadStrategy,
          path, localHash, localHash, 'sha256',
          { path, fileId: null, checksum: null, etag: null, size: stat.size, lastModified: stat.mtime, creationTime: 0 },
          summary, true,
        );
      }
      // Coalesced via a trailing debounce so rapid edits do not each rewrite the state file; onunload flushes it.
      this.deps.stateDB.requestSave();
      await this.deps.historyStore?.save();
    } catch (err) {
      // Never lose the edit: a network failure queues the path for the next sync; the local file is untouched.
      console.warn(`[SyncEngine] Single-file sync failed for ${path}:`, err);
      void this.deps.logger?.log(`watch: FAILED ${path} — ${(err as Error).message}`, 'error');
      this.deps.journal.recordError(summary, path, err);
      if (err instanceof NetworkError) this.deps.queueRetry(path);
    } finally {
      this.end();
    }
    this.notifyWatchOutcome(path, summary, conflictsBefore);
  }

  // Runs the SAME guard as the full sync (applyLocalDeletion): delete only while the server's recomputed checksum
  // still matches our base, else restore the remote copy. `deleteFile`'s expected-id argument is ignored by
  // every client (blind DELETE), so it cannot serve as the guard.
  async deleteSingleFile(path: string): Promise<void> {
    if (this.deps.isRenameHeld?.(path)) return;
    if (this.deps.isSystemExcluded(path) || this.deps.isPluginPath(path)) return;
    if (this.skippedOnCellular('delete', path)) return;
    // Same lock as syncSingleFile: an upload and a delete crossing on one path would otherwise decide by timing.
    return this.withPathLock(path, () => this.deleteSingleFileLocked(path));
  }

  private async deleteSingleFileLocked(path: string): Promise<void> {
    if (this.deps.isRenameHeld?.(path)) return;
    const base = this.deps.stateDB.getFile(path);
    if (!base) return; // not tracked, nothing to do on the remote
    // During a full sync do nothing, and do NOT defer: the running scan propagates the deletion itself, so
    // queuing it here would only risk a second delete.
    if (this.deps.isSyncRunning()) {
      void this.deps.logger?.log(`watch: full sync in progress → deletion of ${path} left to the running scan`);
      return;
    }
    return this.deps.runNonFullSyncOperation(() => this.deleteSingleFileActive(path));
  }

  private async deleteSingleFileActive(path: string): Promise<void> {
    const base = this.deps.stateDB.getFile(path);
    if (!base) return; // not tracked — nothing to do on remote
    const conn = await this.deps.connect();
    const summary = this.deps.journal.newSummary();
    const conflictsBefore = this.deps.conflictEncounters();
    this.begin();
    try {
      if (conn.client.inspectDirectory) await assertTrackedParentReadable(conn.client, this.deps.stateDB, path);
      // The same decision the full scan makes for a path missing from its listing (ask the server, forget on 404,
      // else demand a checksum match). It owns the StateDB cleanup, keeping the entry when the DELETE fails so
      // the delete is retried instead of coming back as a re-download.
      await this.deps.deletion.deleteLocallyMissing(conn.client, path, base, summary);
      this.deps.stateDB.requestSave();
      await this.deps.historyStore?.save();
    } catch (err) {
      console.warn(`[SyncEngine] Single-file delete failed for ${path}:`, err);
      void this.deps.logger?.log(`watch: delete FAILED ${path} — ${(err as Error).message}`, 'error');
      this.deps.journal.recordError(summary, path, err);
    } finally {
      this.end();
    }
    this.notifyWatchOutcome(path, summary, conflictsBefore);
  }

  async renameSingleFile(oldPath: string, newPath: string): Promise<void> {
    if (this.deps.isPluginPath(oldPath) || this.deps.isPluginPath(newPath)) return;
    if (this.deps.isSystemExcluded(oldPath) || this.deps.isSystemExcluded(newPath)) return;
    if (this.skippedOnCellular('rename', `${oldPath} → ${newPath}`)) return;
    // Both ends are locked: a rename moves state between two paths, so one lock leaves the other open to a
    // concurrent cycle acting on a half-applied move.
    return this.withTwoPathLocks(oldPath, newPath, () => this.renameSingleFileLocked(oldPath, newPath));
  }

  private async renameSingleFileLocked(oldPath: string, newPath: string): Promise<void> {
    if (this.deps.isSyncRunning()) return;
    return this.deps.runNonFullSyncOperation(async () => {
      this.begin();
      try {
        const { client } = await this.deps.connect();
        if (!this.deps.isSyncRunning()) await this.deps.retryFileRename(client, oldPath, newPath);
      } catch (err) {
        console.warn(`[SyncEngine] Single-file rename failed ${oldPath} → ${newPath}:`, err);
      } finally {
        this.end();
      }
    });
  }

  // MKCOL is idempotent (405 swallowed), which also makes it safe against a stray download-created-folder event.
  async createSingleFolder(path: string): Promise<void> {
    if (this.deps.isRenameHeld?.(path)) return;
    if (this.deps.isSystemExcluded(path) || this.deps.isPluginPath(path)) return;
    if (this.skippedOnCellular('folder-create', path)) return;
    return this.deps.runNonFullSyncOperation(async () => {
      const conn = await this.deps.connect();
      this.begin();
      try {
        await assertTrackedParentReadable(conn.client, this.deps.stateDB, path, true);
        if (this.deps.isRenameHeld?.(path)) return;
        await conn.client.createDirectory(path); // idempotent: existing folder → harmless
        if (!this.deps.stateDB.getDir(path)?.remoteFileId) {
          const current = await conn.client.statFolderMovePath?.(path);
          if (!this.deps.isRenameHeld?.(path)) this.deps.stateDB.setDir({ path, remoteFileId: current?.directoryId ?? null });
        }
        this.deps.stateDB.requestSave(); // coalesced watch-mode save
        void this.deps.logger?.log(`watch: folder created → MKCOL ${path}`);
      } catch (err) {
        console.warn(`[SyncEngine] Single-folder create failed for ${path}:`, err);
      } finally {
        this.end();
      }
    });
  }

  // File events reconcile the children. A WebDAV collection DELETE would also remove newly added children.
  async deleteSingleFolder(path: string): Promise<void> {
    if (this.deps.hasRenameInFolder?.(path)) return;
    if (this.deps.isSystemExcluded(path) || this.deps.isPluginPath(path)) return;
    if (this.skippedOnCellular('folder-delete', path)) return;
    if (this.deps.stateDB.getDir(path)) {
      await this.deps.logger?.log(`watch: folder removed locally; remote folder retained → ${path}`);
    }
  }

  async renameSingleFolder(oldPath: string, newPath: string): Promise<void> {
    if (this.deps.isPluginPath(oldPath) || this.deps.isPluginPath(newPath)) return;
    if (this.deps.isSystemExcluded(oldPath) || this.deps.isSystemExcluded(newPath)) return;
    if (this.skippedOnCellular('folder-rename', `${oldPath} → ${newPath}`) || this.deps.isSyncRunning()) return;
    await this.deps.reconcileFolderMove?.();
  }

  // Called once the run has finished. The set is drained into a local copy first so re-entry cannot loop.
  // Failures are per-path and already handled inside syncSingleFile.
  async drainPending(): Promise<void> {
    if (this.pendingPaths.size === 0) return;
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    void this.deps.logger?.log(`watch: full sync finished → re-evaluating ${paths.length} deferred path(s)`);
    for (const p of paths) {
      await this.syncSingleFile(p);
    }
  }

  // `conflictsBefore` is conflictEncounters captured before the operation: a conflict settled by a deterministic
  // strategy shows up in NO summary counter (it is recorded as a plain upload/download) yet drops one side's
  // content, so notifying only on merged/conflicted would stay silent about the most destructive resolution.
  private notifyWatchOutcome(path: string, summary: SyncSessionSummary, conflictsBefore: number): void {
    if (summary.errorCount > 0) {
      this.notify(`❌ Sync failed: ${path}`, 6000);
      return;
    }
    if (summary.conflictedCount > 0) {
      this.notify(`⚠️ Conflict in ${path} — the note holds both versions; review and resolve it.`, 8000);
      return;
    }
    if (summary.mergedCount > 0) {
      this.notify(`🔀 Merged remote changes into ${path}`, 6000);
      return;
    }
    if (this.deps.conflictEncounters() > conflictsBefore) {
      this.notify(`🔀 ${path} changed on both sides — resolved by your conflict settings.`, 6000);
    }
  }

  private locallyUnchanged(base: FileState, stat: { mtime: number; size: number }): boolean {
    return isLocallyUnchanged(base, stat, {
      now: () => Date.now(),
      lastSyncTime: () => this.deps.stateDB.getLastSyncTime(),
    });
  }

  private notify(message: string, timeout?: number): void {
    if (this.deps.notify) this.deps.notify(message, timeout);
    else new Notice(message, timeout);
  }
}

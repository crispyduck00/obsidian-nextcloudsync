import type { StateDB } from '../../data/StateDB';
import type { DirState } from '../../types';
import type { FileLogger } from '../../util/FileLogger';
import type { RemoteFileReconcileResult } from '../watch/WatchOperations';

export type RemoteBatchReconcileResult = 'done' | 'deferred' | 'untracked' | 'busy' | 'full-sync';

export interface RemotePushBatch {
  fileIds: readonly string[];
  /** Root collection identity learned by the scope probe for this exact batch. */
  rootFileId: string | null;
}

export interface RemotePushReconcilerDeps {
  stateDB: Pick<StateDB, 'getFileByRemoteId' | 'getAllDirs'>;
  isFullSyncRunning(): boolean;
  reconcileFile(path: string, expectedRemoteFileId: string): Promise<RemoteFileReconcileResult>;
  logger?: Pick<FileLogger, 'log'>;
}

/**
 * Resolves notify_push IDs only far enough to select an existing upstream sync path.
 *
 * Known files are handed to the ordinary per-file classifier. Known directory IDs are accepted only
 * when they can be explained as parent/ancestor ETag propagation for a known file in the same push
 * batch; the directory itself is never synchronized here. An all-unknown batch is returned as
 * `untracked` so the scheduler can compare its already-fetched vault-root ETag with the transient
 * push checkpoint. Unknown mixed with known vault state, directory-only events, inconsistent identity,
 * rename/delete ambiguity, and every other structural case still fall back to the existing full sync.
 */
export class RemotePushReconciler {
  constructor(private readonly deps: RemotePushReconcilerDeps) {}

  async reconcileFileIds(batch: RemotePushBatch): Promise<RemoteBatchReconcileResult> {
    if (this.deps.isFullSyncRunning()) return 'busy';

    const ids = [...new Set(batch.fileIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    if (ids.length === 0) return 'full-sync';
    const rootFileId = batch.rootFileId?.trim() || null;

    const dirsById = this.directoryIndex();
    if (dirsById == null) return 'full-sync';

    const work: Array<{ path: string; fileId: string }> = [];
    const pushedDirs: DirState[] = [];
    const paths = new Map<string, string>();
    const unknownIds: string[] = [];
    let sawKnownScopeId = false;

    // Classify the complete batch before touching the network. Unknown-only is kept distinct so the
    // scheduler can combine it with the already-fetched vault-root ETag; unknown mixed with any known
    // vault identity remains structural/ambiguous and therefore requires the authoritative full sync.
    for (const fileId of ids) {
      const file = this.deps.stateDB.getFileByRemoteId(fileId);
      const dir = dirsById.get(fileId);

      if (rootFileId === fileId) {
        // StateDB intentionally excludes the configured vault root from getAllDirs(). Treat the
        // positively identified root as a synthetic ancestor only for this push batch. Any collision
        // with tracked state means identity is inconsistent and must fall back to the full scanner.
        if (file || dir) {
          void this.deps.logger?.log(`client-push: vault root id ${fileId} collides with tracked state → full reconciliation`);
          return 'full-sync';
        }
        void this.deps.logger?.log(`client-push: remote id ${fileId} → vault root`);
        sawKnownScopeId = true;
        pushedDirs.push({ path: '', remoteFileId: fileId });
        continue;
      }

      if (file && dir) {
        void this.deps.logger?.log(`client-push: remote id ${fileId} maps to both file and directory state → full reconciliation`);
        return 'full-sync';
      }

      if (file) {
        if (file.remoteFileId !== fileId) {
          void this.deps.logger?.log(`client-push: inconsistent remote file id ${fileId} → full reconciliation`);
          return 'full-sync';
        }
        const priorId = paths.get(file.path);
        if (priorId && priorId !== fileId) {
          void this.deps.logger?.log(`client-push: multiple remote ids map to ${file.path} → full reconciliation`);
          return 'full-sync';
        }
        sawKnownScopeId = true;
        if (!priorId) {
          paths.set(file.path, fileId);
          work.push({ path: file.path, fileId });
          void this.deps.logger?.log(`client-push: remote id ${fileId} → file ${file.path}`);
        }
        continue;
      }

      if (dir) {
        void this.deps.logger?.log(`client-push: remote id ${fileId} → directory ${dir.path}`);
        sawKnownScopeId = true;
        pushedDirs.push(dir);
        continue;
      }

      unknownIds.push(fileId);
    }

    if (unknownIds.length > 0) {
      if (!sawKnownScopeId) {
        void this.deps.logger?.log(
          `client-push: ${unknownIds.length} remote id(s) are not tracked in this vault → scope remains untracked`,
        );
        return 'untracked';
      }
      void this.deps.logger?.log(
        `client-push: untracked remote id(s) accompany known vault state → full reconciliation`,
      );
      return 'full-sync';
    }

    // A folder-only push may mean create/delete/rename/move (including an empty folder). That is
    // intentionally left to DirectoryReconciler/full sync. Folder IDs are ignorable only when every
    // one is explained by a known pushed file below it, which is the normal Nextcloud parent ETag case.
    if (work.length === 0) {
      void this.deps.logger?.log('client-push: directory-only notification → full reconciliation');
      return 'full-sync';
    }
    for (const dir of pushedDirs) {
      if (!work.some((item) => this.isDescendant(item.path, dir.path))) {
        void this.deps.logger?.log(`client-push: directory ${dir.path} is not explained by a pushed child file → full reconciliation`);
        return 'full-sync';
      }
    }

    let sawDeferred = false;
    for (const item of work) {
      if (this.deps.isFullSyncRunning()) return 'busy';
      const result = await this.deps.reconcileFile(item.path, item.fileId);
      if (result === 'done') continue;
      if (result === 'deferred') {
        // A lock/retry on one file must not silently postpone unrelated known files from the same
        // push batch. Preserve the unresolved outcome, but continue with the remaining independent
        // paths. The scheduler will deliberately NOT advance the observed root ETag for this batch.
        sawDeferred = true;
        continue;
      }
      return result;
    }

    return sawDeferred ? 'deferred' : 'done';
  }

  private directoryIndex(): Map<string, DirState> | null {
    const index = new Map<string, DirState>();
    for (const dir of this.deps.stateDB.getAllDirs()) {
      const fileId = dir.remoteFileId?.trim();
      if (!fileId) continue;
      if (index.has(fileId)) {
        void this.deps.logger?.log(`client-push: duplicate tracked directory id ${fileId} → full reconciliation`);
        return null;
      }
      index.set(fileId, dir);
    }
    return index;
  }

  private isDescendant(path: string, directory: string): boolean {
    const dir = directory.replace(/\/+$/, '');
    return dir.length === 0 ? path.length > 0 : path.startsWith(`${dir}/`);
  }
}

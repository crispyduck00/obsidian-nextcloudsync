// Deletion propagation in both directions. applyLocalDeletion deletes on the server ONLY when a real content
// hash proves the server copy never diverged. processRemoteDeletion applies a server deletion locally through
// the user's "Deleted files" setting and never outside sync scope (docs/spec.md §8).
import { Notice, TFile, TFolder, normalizePath, App } from 'obsidian';
import { FileState, RemoteFileInfo, SyncSessionSummary, NetworkError } from '../../types';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { TransferService } from '../transfer/TransferService';
import { FileLogger } from '../../util/FileLogger';
import { isSafeVaultRelativePath } from '../../network/remotePath';
import { dropSubtreeTracking } from './subtreeTracking';
import { removeEmptyLocalDirectory } from './removeEmptyLocalDirectory';
import { sha256 } from '../../util/hash';
import type { LocalAdapter } from '../../data/LocalAdapter';
import type { RemoteFolderGuard } from '../directory/RemoteFolderGuard';

// What a local deletion did; a caller that must report failures (the mirror) reads it, an ordinary sync ignores it.
export type RemoteDeletionOutcome =
  | { status: 'deleted' }
  | { status: 'absent' }
  | { status: 'ignored' }
  | { status: 'failed'; message: string };

export interface DeletionDeps {
  assertLocalVaultAvailable?(): Promise<void>;
  app: App;
  localAdapter: Pick<LocalAdapter, 'readBinary' | 'stat'>;
  isBeingEdited?(path: string): boolean;
  remoteFolders?: RemoteFolderGuard;
  stateDB: Pick<StateDB, 'deleteFile' | 'getFile' | 'getAllFiles' | 'getAllDirs' | 'deleteDir'>;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  transfer: TransferService;
  isSystemExcluded(path: string): boolean;
  isRenameHeld?(path: string): boolean;
  hasRenameInFolder?(path: string): boolean;
  dropCleanSnapshot(path: string): void;
  // Registers a path so the vault event this plugin causes is not fed back to the watcher. Required: an
  // unwired no-op here turns a plugin trash back into a server DELETE.
  markOwnEvent: (path: string) => void;
  logger?: Pick<FileLogger, 'log'>;
}

export class DeletionService {
  constructor(private readonly deps: DeletionDeps) {}


  async applyLocalDeletion(
    client: IWebDAVClient,
    remote: RemoteFileInfo, base: FileState, remoteId: string, idType: FileState['idType'],
    summary: SyncSessionSummary,
  ): Promise<'deleted' | 'restored' | 'kept'> {
    if (!remote.etag && client.inspectDirectory) {
      // A root-ETag cache entry may have the old checksum but no per-file ETag for a conditional DELETE.
      const live = await client.statFile(remote.path);
      if (!live?.etag) throw new Error('Nextcloud did not confirm the current revision for deletion.');
      remote = live;
    }
    // Decide only from a real content hash: a SHA-256 match with the last synced base is the only proof the
    // server copy is unchanged.
    let serverHash = remote.checksum ?? null;
    if (!serverHash) {
      try { serverHash = await client.recalcChecksum(remote.path); } catch { serverHash = null; }
    }

    const identityChanged = !!base.remoteFileId && !!remote.fileId && remote.fileId !== base.remoteFileId;
    if (serverHash && serverHash === base.localHash && !identityChanged) {
      await this.deps.remoteFolders?.assertRemovalAllowed(client, remote.path, false, summary);
      if (await this.deps.localAdapter.stat(remote.path) || this.deps.isRenameHeld?.(remote.path)) return 'kept';
      await this.deps.assertLocalVaultAvailable?.();
      if (this.deps.isRenameHeld?.(remote.path)) return 'kept';
      void this.deps.logger?.log(`delete-remote: local deletion (server checksum matches base) → ${remote.path}`);
      try {
        if (remote.etag) await client.deleteFile(remote.path, serverHash, remote.etag);
        else await client.deleteFile(remote.path, base.remoteId);
        summary.deletedCount++;
        this.deps.journal.recordHistory(remote.path, 'deleted', undefined, {
          localHash: base.localHash, remoteId, remoteIdType: idType,
          localSize: base.size, remoteSize: remote.size,
        });
      } catch (err) {
        if (!(err instanceof NetworkError && err.status === 404)) throw err;
      }
      this.deps.stateDB.deleteFile(remote.path);
      this.deps.mergeBase.drop(remote.path);
      return 'deleted';
    }
    if (serverHash && (serverHash !== base.localHash || identityChanged)) {
      // The server copy diverged after our base; restore it so a remote edit is never dropped.
      void this.deps.logger?.log(`conflict(local-delete vs remote-edit): restoring remote → ${remote.path}`);
      if (await this.deps.localAdapter.stat(remote.path)) return 'kept';
      await this.deps.transfer.downloadFile(client, remote, remote.checksum ?? remote.etag ?? remoteId,
        remote.checksum ? 'sha256' : remote.etag ? 'etag' : idType, summary);
      return 'restored';
    }
    // Without a reliable checksum (plain WebDAV, or recalc failed) do NOT delete: etag/size do not prove
    // unchanged content. The deletion still propagates via the incremental token path.
    void this.deps.logger?.log(`delete-remote: SKIPPED — no reliable server checksum to confirm unchanged → ${remote.path}`);
    return 'kept';
  }

  // For a file absent locally and from the remote listing (not a rename). The listing can be incomplete
  // (issue #46), so a Depth 0 PROPFIND decides: gone (forget it), present (hand to the proof path),
  // unanswerable (keep and retry next sync).
  async deleteLocallyMissing(
    client: IWebDAVClient, path: string, base: FileState, summary: SyncSessionSummary,
  ): Promise<'deleted' | 'untracked' | 'restored' | 'kept'> {
    // A throw reaches the caller, which keeps the tracking entry: an unanswerable probe must never be read as
    // "gone", or an outage would quietly discard the file's history.
    const remote = await client.statFile(path);
    if (this.deps.isRenameHeld?.(path)) return 'kept';
    if (!remote) {
      void this.deps.logger?.log(`delete-remote: not on the server (Depth:0 404) — dropping tracking, no DELETE → ${path}`);
      this.deps.journal.recordHistory(path, 'deleted');
      this.dropTracking(path);
      return 'untracked';
    }

    void this.deps.logger?.log(`delete-remote: absent from the listing but present on the server — proving before delete → ${path}`);
    const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
    const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
    const outcome = await this.applyLocalDeletion(client, remote, base, remoteId, idType, summary);
    // applyLocalDeletion never drops the clean sides; drop them here so no snapshot outlives the path.
    if (outcome === 'deleted') this.deps.dropCleanSnapshot(path);
    return outcome;
  }

  private dropTracking(path: string): void {
    this.deps.stateDB.deleteFile(path);
    this.deps.mergeBase.drop(path);
    this.deps.dropCleanSnapshot(path);
  }

  async processRemoteDeletion(
    path: string, summary: SyncSessionSummary, mode: 'unchanged-file' | 'file' | 'empty-directory' = 'unchanged-file',
  ): Promise<RemoteDeletionOutcome> {
    if (this.deps.isRenameHeld?.(path)) return { status: 'ignored' };
    // Security boundary at the delete sink: a compromised server could fabricate a deletion for
    // `.obsidian/...`, which would otherwise reach the raw fs remove below. Enforced here for all callers.
    if (!isSafeVaultRelativePath(path) || this.deps.isSystemExcluded(path)) {
      void this.deps.logger?.log(`delete-local: ignored out-of-scope remote deletion → ${path}`);
      return { status: 'ignored' };
    }
    void this.deps.logger?.log(`delete-local: applying remote deletion → ${path}`);
    const file = this.deps.app.vault.getAbstractFileByPath(path);
    const normalized = normalizePath(path);
    let removed = false;
    try {
      if (mode === 'empty-directory') {
        if (this.deps.hasRenameInFolder?.(path)) return { status: 'ignored' };
        if (!(await removeEmptyLocalDirectory(this.deps.app, path, this.deps.markOwnEvent))) {
          return { status: 'failed', message: 'The local folder still contains files or folders.' };
        }
        removed = file instanceof TFolder;
      } else if (file instanceof TFolder) {
        return { status: 'failed', message: 'A local folder now occupies the file path.' };
      } else if (file instanceof TFile || await this.deps.app.vault.adapter.exists(normalized)) {
        if (mode === 'unchanged-file') {
          const base = this.deps.stateDB.getFile(path);
          if (!base || base.isConflicted || this.deps.isBeingEdited?.(path)
              || await sha256(await this.deps.localAdapter.readBinary(path)) !== base.localHash
              || this.deps.isBeingEdited?.(path)) {
            return { status: 'failed', message: 'The remote path is missing or inaccessible. Local changes were kept.' };
          }
        }
        this.deps.markOwnEvent(path);
        if (file instanceof TFile) await this.deps.app.fileManager.trashFile(file);
        else await this.deps.app.vault.adapter.remove(normalized);
        removed = true;
      }
      if (removed) {
        summary.downloadedCount++;
        this.deps.journal.recordHistory(path, 'deleted');
      }
      // Already gone locally: fall through to state cleanup.
    } catch (err) {
      // One failed deletion must not abort the session; keep the StateDB entry so the next sync retries.
      new Notice(`❌ Failed to delete ${path}: ${(err as Error).message}`, 6000);
      return { status: 'failed', message: (err as Error).message };
    }
    this.deps.stateDB.deleteFile(path);
    this.deps.mergeBase.drop(path);
    this.deps.dropCleanSnapshot(path);
    if (mode === 'empty-directory') dropSubtreeTracking(this.deps, path);
    return { status: removed ? 'deleted' : 'absent' };
  }
}

// One upload, one download, and the locking and size guards around them. It decides nothing about WHICH files
// move, only how a single file crosses. The WebDAV client and upload strategy are PARAMETERS, never fields:
// SyncEngine creates both lazily and can replace them, so a captured one would go stale.
import { FileState, RemoteFileInfo, SyncSessionSummary } from '../../types';
import { FileLockedError, FeatureUnsupportedError, NetworkError } from '../../types';
import { LocalAdapter, LocalFileChangedError, type LocalStat, type LocalWriteExpectation } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy, type UploadOutcome } from '../upload/IUploadStrategy';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { invalidateLocalSignature, withLocalSignature } from '../../data/localSignature';
import { FileLogger } from '../../util/FileLogger';
import { FIXED } from '../../util/fixedSyncConfig';
import { isAnomalousRemoteContent, isOverFileSizeLimit } from '../../util/limits';
import { sha256 } from '../../util/hash';
import { remoteIdOf } from '../remoteIdentity';
import { uploadCreationTimeMs, writeCreationTimeMs } from '../../util/creationTime';
import { bytesEqual } from '../identity/contentIdentity';
import { hasCompleteMarkerSet } from '../ConflictResolver';
import type { LocalWritePort } from '../plugins/PluginSyncCoordinator';
import type { CreationTimePort } from '../ctime/CreationTimeAligner';

export interface TransferDeps {
  isBeingEdited?(path: string): boolean;
  // Aligns the creation time of files whose body this sync left unchanged (docs/spec.md §9.7). Optional so tests
  // can omit it; the engine always passes one.
  creationTime?: CreationTimePort;
  localAdapter: Pick<LocalAdapter, 'stat' | 'readBinary' | 'atomicWriteBinary'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile'> & Partial<Pick<StateDB, 'setSyncToken'>>;
  // Chooses the mtime of a fetched body and is told after each write (a plugin's data.json gets the write time).
  localWrite: LocalWritePort;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  // Read at call time: the cap is a live setting.
  maxFileSizeMB(): number;
  hasFilesLocking(): boolean;
  isRenameHeld?(path: string): boolean;
  beginFirstUpload?(path: string): (outcome?: UploadOutcome, createdFileId?: string) => void;
  // Asks which client is running, not what the server said: `StandardWebDAVClient` hardcodes `checksum: null`,
  // so recording a SHA-256 against plain WebDAV would mismatch what the next sync reads back (docs/spec.md §4.1).
  // Deliberately NOT the server's `hasChecksums` capability, which is false on the official Docker image even
  // though PROPFIND returns checksums.
  clientReportsChecksums(): boolean;
  // An outbound port, not a call back into the sync loop: transfer says a file needs another attempt, not when.
  queueRetry(path: string): void;
  logger?: Pick<FileLogger, 'log'>;
}

export class TransferService {
  // Held locks keyed by path; only acquire/release read it.
  private readonly heldLocks = new Map<string, string>();

  constructor(private readonly deps: TransferDeps) {}

  async uploadFile(
    client: IWebDAVClient, uploadStrategy: IUploadStrategy,
    path: string, localHash: string, remoteId: string,
    idType: FileState['idType'], remote: RemoteFileInfo,
    summary: SyncSessionSummary, onlyIfAbsent = false,
  ): Promise<void> {
    if (this.deps.isRenameHeld?.(path)) return;
    const stat = await this.deps.localAdapter.stat(path);
    if (!stat) return;

    const data = await this.deps.localAdapter.readBinary(path);

    // A path locked by someone else is skipped and queued for retry.
    let token: string | null;
    try {
      token = await this.acquireLock(client, path);
    } catch (err) {
      if (err instanceof FileLockedError) {
        this.deps.queueRetry(path);
        return;
      }
      throw err;
    }

    let finish: ReturnType<NonNullable<TransferDeps['beginFirstUpload']>> | undefined;
    let recorded: UploadOutcome | undefined;
    let createdFileId: string | undefined;
    let uploadedEtag: string | undefined;
    try {
      let outcome: 'uploaded' | 'skipped';
      try {
        if (this.deps.isRenameHeld?.(path)) return;
        // If-Match with the known remote etag makes a remote changed since our baseline return 412
        // (PreconditionFailedError, a conflict). A new path must still be absent to create it.
        finish = onlyIfAbsent ? this.deps.beginFirstUpload?.(path) : undefined;
        outcome = await uploadStrategy.upload(client, path, data, stat.mtime, {
          ifMatchEtag: remote.etag,
          ...(remote.checksum ? { expectedRemoteChecksum: remote.checksum } : {}),
          ...(onlyIfAbsent ? { onlyIfAbsent, onCreatedFileId: (id: string) => { createdFileId = id; } } : {}),
          onUploadedEtag: etag => { uploadedEtag = etag; },
          ctime: uploadCreationTimeMs(stat.ctime, remote.creationTime),
        });
      } finally {
        await this.releaseLock(client, path, token);
      }

      if (outcome === 'skipped') {
        recorded = outcome;
        // Over the size limit: recorded for the end-of-sync count (docs/spec.md §9.4a), no retry.
        this.deps.journal.recordOversizeSkip(summary, {
          path, sizeBytes: data.byteLength, limitMB: this.deps.maxFileSizeMB(), direction: 'upload',
        });
        return;
      }
      summary.uploadedCount++;
      // Record the state the server holds now, not before the PUT. Both strategies send `OC-Checksum: SHA256:<localHash>`
      // and Nextcloud returns it as oc:checksums, so the remote id IS localHash; keeping the pre-upload id would make
      // every later sync download the file just uploaded. Only true where the client can read a checksum back: on
      // plain WebDAV the next PROPFIND yields an ETag, so ask the server and record that instead.
      let uploadedRemoteId = localHash;
      let uploadedIdType: FileState['idType'] = 'sha256';
      let uploadedFileId = createdFileId ?? remote.fileId;
      const reportsChecksums = this.deps.clientReportsChecksums();
      let uploadedRemoteMtime = uploadedEtag ? Math.floor(stat.mtime / 1000) * 1000 : remote.lastModified;
      if (!reportsChecksums || (onlyIfAbsent && !uploadedFileId)) {
        try {
          const fresh = await client.statFile(path);
          if (fresh && !reportsChecksums) {
            // Plain WebDAV tracks the server's ETag. On a failed stat keep the SHA-256 baseline.
            ({ remoteId: uploadedRemoteId, idType: uploadedIdType } = remoteIdOf(fresh));
          } else if (fresh?.fileId && fresh.checksum === localHash) {
            // A new Nextcloud file gets its ID on the server. Only index the ID if the stat
            // still describes the uploaded bytes; a peer may already have replaced the path.
            uploadedFileId = fresh.fileId;
            uploadedEtag ??= fresh.etag ?? undefined;
            uploadedRemoteMtime = fresh.lastModified;
          }
        } catch (err) {
          void this.deps.logger?.log(`upload: could not re-read ${path} after upload — ${(err as Error).message}`);
        }
      }
      this.deps.journal.recordHistory(path, 'uploaded', undefined, {
        localHash, remoteId: uploadedRemoteId, remoteIdType: uploadedIdType,
        localSize: stat.size, remoteSize: remote.size,
      });

      this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
        path, localHash, remoteId: uploadedRemoteId, idType: uploadedIdType,
        size: stat.size, mtime: stat.mtime,
        remoteFileId: uploadedFileId, isConflicted: false,
        remoteEtag: uploadedEtag,
      }, uploadedRemoteMtime));
      // The remote now equals the uploaded body, so it is the new merge base.
      this.deps.mergeBase.recordBytes(path, data);
      recorded = outcome;
    } finally {
      finish?.(recorded, createdFileId);
    }
  }

  async downloadFile(
    client: IWebDAVClient,
    remote: RemoteFileInfo, remoteId: string,
    idType: FileState['idType'], summary: SyncSessionSummary, expected?: LocalWriteExpectation,
  ): Promise<void> {
    if (this.deps.isRenameHeld?.(remote.path)) return;
    // Skip oversized remote files BEFORE the GET, covering the normal download and the local-delete-vs-remote-edit
    // restore. Local and Base stay untouched and no retry is queued: the skip is permanent until the cap is
    // raised, then the next reconcile downloads it. Not an error (docs/spec.md §9.4). Counted for the
    // end-of-sync notice (docs/spec.md §9.4a).
    if (this.isRemoteOverSizeLimit(remote)) {
      this.deps.journal.recordOversizeSkip(summary, {
        path: remote.path, sizeBytes: remote.size, limitMB: this.deps.maxFileSizeMB(), direction: 'download',
      });
      return;
    }
    const data = await client.downloadFile(remote.path);
    // Refuse to overwrite local with a body whose length differs from the advertised size (0-byte or truncated
    // body from a buggy server). Local and Base stay untouched and the file is retried; an advertised size 0
    // is not flagged.
    if (isAnomalousRemoteContent(remote.size, data.byteLength)) {
      this.deps.journal.recordError(summary, remote.path, new Error(`Refused remote overwrite: server advertised ${remote.size} bytes but returned ${data.byteLength} (server anomaly)`));
      this.deps.queueRetry(remote.path);
      const base = this.deps.stateDB.getFile(remote.path);
      if (base) this.deps.stateDB.setFile({ ...base, isConflicted: true });
      void this.deps.logger?.log(`download: REFUSED anomalous remote (size ${remote.size}≠${data.byteLength}) → kept local, queued retry → ${remote.path}`);
      return;
    }
    // A fetched body equal to the local file is not written (docs/spec.md §5.3a): the mtime stays and no vault event fires.
    const localStat = await this.deps.localAdapter.stat(remote.path);
    const canWrite = () => !this.deps.isBeingEdited?.(remote.path) && !this.deps.isRenameHeld?.(remote.path);
    // Check the decision made before the GET. A newly present note is a local change even if the
    // current sync would normally have treated the path as remote-only.
    if (expected && (!canWrite() || (expected.stat === null
      ? localStat !== null
      : !localStat || localStat.size !== expected.stat.size || localStat.mtime !== expected.stat.mtime))) {
      this.deferLocalWrite(remote.path, summary);
      return;
    }
    if (localStat && localStat.size === data.byteLength
        && bytesEqual(await this.deps.localAdapter.readBinary(remote.path), data)) {
      const sameHash = await sha256(data);
      const isConflicted = this.deps.stateDB.getFile(remote.path)?.isConflicted === true
        && hasCompleteMarkerSet(new TextDecoder().decode(data));
      this.deps.stateDB.setFile({
        path: remote.path, localHash: sameHash, remoteId, idType,
        size: remote.size, mtime: remote.lastModified || localStat.mtime,
        remoteFileId: remote.fileId, isConflicted,
        remoteEtag: remote.etag ?? undefined,
        localSize: localStat.size, localMtime: localStat.mtime, remoteMtime: remote.lastModified,
      });
      if (!isConflicted) this.deps.mergeBase.recordBytes(remote.path, data);
      void this.deps.logger?.log(`download: body identical to the local file → state converged, no write → ${remote.path}`);
      await this.deps.creationTime?.align(client, remote, localStat);
      return;
    }
    if (this.deps.isRenameHeld?.(remote.path)) return;
    const writeMtime = this.deps.localWrite.mtimeFor(remote.path, remote.lastModified || undefined);
    const writeCtime = writeCreationTimeMs(localStat?.ctime, remote.creationTime);
    let written: LocalStat | void;
    try {
      written = await this.deps.localAdapter.atomicWriteBinary(remote.path, data, writeMtime, writeCtime,
        ...(expected ? [{ ...expected, canWrite }] : []));
    } catch (err) {
      if (!(err instanceof LocalFileChangedError)) throw err;
      this.deferLocalWrite(remote.path, summary, err);
      return;
    }
    this.deps.localWrite.written(remote.path);
    summary.downloadedCount++;

    const localHash = await sha256(data);
    this.deps.journal.recordHistory(remote.path, 'downloaded', undefined, {
      localHash, remoteId, remoteIdType: idType,
      localSize: data.byteLength, remoteSize: remote.size,
    });
    const mtime = remote.lastModified || written?.mtime || Date.now();
    const state: FileState = {
      path: remote.path, localHash, remoteId, idType,
      size: remote.size, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
      remoteEtag: remote.etag ?? undefined,
      remoteMtime: remote.lastModified,
    };
    if (expected) {
      // A later stat could belong to an edit made after the write. Only use the receipt from the
      // adapter and discard it if the write's requested mtime or byte length was no longer visible.
      if (written && written.mtime === writeMtime && written.size === data.byteLength) {
        state.localMtime = written.mtime;
        state.localSize = written.size;
      }
      this.deps.stateDB.setFile(state);
    } else {
      this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, state, remote.lastModified));
    }
    // Local now equals the remote body, so it is the new merge base.
    this.deps.mergeBase.recordBytes(remote.path, data);
    await this.deps.creationTime?.align(client, remote);
  }

  deferLocalWrite(path: string, summary: SyncSessionSummary, error?: LocalFileChangedError): void {
    if (error?.retainedCopy) this.deps.journal.recordError(summary, path, error);
    // A same-size edit can keep the old mtime. Preserve the base and hash the actual bytes on retry.
    invalidateLocalSignature(this.deps.stateDB, path);
    this.deps.stateDB.setSyncToken?.(null);
    this.deps.queueRetry(path);
    void this.deps.logger?.log(`sync: local file changed during a write, kept both revisions and queued retry → ${path}`);
  }

  // Decided BEFORE any GET from the PROPFIND-advertised size; `maxFileSizeMB` 0 means unlimited. The single
  // decision point for every remote-body fetch: `requestUrl` buffers the whole body (and Android base64-encodes
  // it), so a large file would OOM the app (issue #8, docs/spec.md §9.4).
  isRemoteOverSizeLimit(remote: RemoteFileInfo): boolean {
    return isOverFileSizeLimit(remote.size, this.deps.maxFileSizeMB());
  }

  // Returns null if locking is disabled/unsupported; on 423 retries with backoff, then throws FileLockedError.
  // Public because the conflict-resolution and clean-side write paths take the same lock around their writes.
  async acquireLock(client: IWebDAVClient, path: string): Promise<string | null> {
    // File locking is always off: lost-update safety is the If-Match precondition, without LOCK/UNLOCK
    // round-trips. The mechanism is retained but not engaged by the normal sync path (docs/spec.md §6.5).
    if (!FIXED.fileLockingEnabled || !this.deps.hasFilesLocking()) return null;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const token = await client.lockFile(path);
        if (token) this.heldLocks.set(path, token);
        return token;
      } catch (err) {
        if (err instanceof FileLockedError) {
          if (attempt < maxAttempts - 1) {
            await this.sleep(500 * Math.pow(2, attempt));
            continue;
          }
          throw err;
        }
        if (err instanceof FeatureUnsupportedError) return null;
        // A NetworkError (e.g. 404 for a file not yet on the server) must not abort the sync; proceed without a lock.
        if (err instanceof NetworkError) return null;
        throw err;
      }
    }
    return null;
  }

  async releaseLock(client: IWebDAVClient, path: string, token: string | null): Promise<void> {
    if (!token) return;
    await client.unlockFile(path, token);
    this.heldLocks.delete(path);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}

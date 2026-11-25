// Produces the remote side of a full scan: a real listing, or the same listing rebuilt from State when the
// vault root ETag proves nothing changed (docs/spec.md §8a.5). Both are complete, so callers treat them alike.
// The WebDAV client is a PARAMETER on every method, never a field: SyncEngine creates it lazily and can
// replace it, so a captured one would go stale.
import { RemoteFileInfo, RemoteDirInfo } from '../../types';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { FORCE_FULL_SCAN_EVERY } from '../../util/limits';
import { FileLogger } from '../../util/FileLogger';

// `isNextcloud` and `networkConcurrency` are accessors because both change during an engine's life
// (capabilities arrive on connect, settings can be edited).
export interface RemoteListingDeps {
  stateDB: Pick<StateDB,
    'getAllFiles' | 'getAllDirs' | 'getRemoteRootEtag'
    | 'getFullScanSkipCount' | 'setFullScanSkipCount' | 'getRootSizeSkippedFiles'>;
  isNextcloud(): boolean;
  // The batching loop advances by this value, so it floors it again: a 0 would never terminate.
  networkConcurrency(): number;
  logger?: Pick<FileLogger, 'log'>;
}

export interface FullScanListing {
  remoteFiles: RemoteFileInfo[];
  cachedDirs: RemoteDirInfo[] | null;
  rootEtag: string | null;
}

export class RemoteListingSource {
  constructor(private readonly deps: RemoteListingDeps) {}

  // Returns cachedDirs only when short-circuited, so reconcileDirectories can skip getDirectories('').
  // A new root ETag is only a candidate until the caller finishes reconciliation of this listing.
  async obtainFullScanListing(client: IWebDAVClient): Promise<FullScanListing> {
    const db = this.deps.stateDB;
    const isNextcloud = this.deps.isNextcloud();
    const stored = db.getRemoteRootEtag();
    const skipCount = db.getFullScanSkipCount();
    const forced = skipCount >= FORCE_FULL_SCAN_EVERY;

    // Captured BEFORE listing so a real scan never stores a value NEWER than its listing: an interleaved remote
    // change yields a mismatch next sync (an extra scan, never a missed change). Null off Nextcloud.
    const cur = isNextcloud ? await client.getRootEtag() : null;

    if (cur != null && stored != null && cur === stored && !forced) {
      const remoteFiles = this.rebuildRemoteFilesFromState();
      const cachedDirs = this.rebuildRemoteDirsFromState();
      db.setFullScanSkipCount(skipCount + 1);
      void this.deps.logger?.log(
        `sync: root-ETag MATCH (${cur}) → SHORT-CIRCUIT full scan; rebuilt ${remoteFiles.length} files / ${cachedDirs.length} dirs from State (skip ${skipCount + 1}/${FORCE_FULL_SCAN_EVERY})`,
      );
      return { remoteFiles, cachedDirs, rootEtag: cur };
    }

    // A null ETag (non-Nextcloud, or fetch failure) just makes the next sync real-scan again.
    const remoteFiles = await client.getFiles('');
    db.setFullScanSkipCount(0);
    void this.deps.logger?.log(
      `sync: REAL full scan (remote=${remoteFiles.length}); rootEtag=${cur ?? 'null'}${forced ? ' (forced: skip budget reached)' : ''}`,
    );
    return { remoteFiles, cachedDirs: null, rootEtag: cur };
  }

  rebuildRemoteFilesFromState(verifyRevision = false): RemoteFileInfo[] {
    const files = this.deps.stateDB.getAllFiles().map((fs): RemoteFileInfo => ({
      path: fs.path,
      fileId: fs.remoteFileId,
      checksum: fs.idType === 'sha256' ? fs.remoteId : verifyRevision ? fs.remoteChecksum ?? null : null,
      reportedChecksum: fs.remoteChecksum,
      etag: fs.idType === 'etag' ? fs.remoteId : verifyRevision ? fs.remoteEtag ?? null : null,
      size: fs.size,
      lastModified: fs.remoteMtime ?? fs.mtime,
    }));

    const skipped = this.deps.stateDB.getRootSizeSkippedFiles();
    if (skipped.length === 0) return files;
    // A skipped download left the common base untouched. Keep that base for merge and file-ID lookup,
    // but use the observed server entry in the reconstructed listing, even for a path without a base.
    const filesByPath = new Map(files.map(file => [file.path, file]));
    // Creation time can change without an ETag change, so only a real listing supplies it.
    for (const file of skipped) filesByPath.set(file.path, { ...file, creationTime: undefined });
    return [...filesByPath.values()];
  }

  // reconcileDirectories only needs path/fileId; etag/lastModified are unused there.
  rebuildRemoteDirsFromState(): RemoteDirInfo[] {
    return this.deps.stateDB.getAllDirs().map((d) => ({
      path: d.path,
      fileId: d.remoteFileId,
      etag: null,
      lastModified: 0,
    }));
  }

  // Asks the server to compute SHA-256 on demand (no download). Best-effort: unsupported servers leave the
  // checksum null, so buildInitialPlan falls back to content-based conflict resolution.
  async resolveRemoteChecksums(
    client: IWebDAVClient,
    remoteFiles: RemoteFileInfo[],
    localFiles: Map<string, { size: number; mtime: number }>,
  ): Promise<void> {
    const targets = remoteFiles.filter(rf => !rf.checksum && localFiles.has(rf.path));
    const concurrency = Math.max(1, this.deps.networkConcurrency());
    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency);
      await Promise.all(batch.map(async (rf) => {
        try {
          const sum = await client.recalcChecksum(rf.path);
          if (sum) rf.checksum = sum;
        } catch { /* leave null; falls back to conflict resolution */ }
      }));
    }
  }
}

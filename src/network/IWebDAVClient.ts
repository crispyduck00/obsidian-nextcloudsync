import { NextcloudFeatures, RemoteFileInfo, RemoteDirInfo, SyncChanges, FileVersion, VaultRootOutcome } from '../types';

export interface RemoteRootInfo {
  /** Vault-root collection ETag, or null when unavailable. */
  etag: string | null;
  /** Nextcloud oc:fileid for the vault-root collection, or null when unavailable/unsupported. */
  fileId: string | null;
}

export interface IWebDAVClient {
  connect(): Promise<NextcloudFeatures>;
  /**
   * The COMPLETE listing beneath `path` (the vault root when `path` is '') (docs/spec.md §5.2).
   * 207 with no children yields [] (the folder is empty); a 404 on a subpath also yields [].
   * @throws RemoteRootMissingError on a 404 for the root.
   * @throws RemoteListingUnreadableError (a NetworkError) when a 207 body is not a well-formed multistatus.
   * @throws NetworkError on any other non-207.
   */
  getFiles(path: string): Promise<RemoteFileInfo[]>;
  /**
   * Remote state of ONE file (PROPFIND Depth:0), shaped like a full-scan listing entry; null when the
   * path holds no file (404 on the file or its parent, or the path is a collection) (docs/spec.md §5.7).
   * @throws NetworkError on any other non-207 (an ambiguous failure must not read as "absent").
   * @throws RemoteListingUnreadableError when a 207 body cannot be parsed.
   */
  statFile(remotePath: string): Promise<RemoteFileInfo | null>;
  /**
   * ETag of the sync-root collection, or null when unavailable or not meaningful for change detection
   * (standard WebDAV always returns null). Never throws: any failure, including an unreadable body, yields null.
   */
  getRootEtag(): Promise<string | null>;
  /**
   * Optional richer variant of {@link getRootEtag}. Nextcloud returns the root ETag and oc:fileid
   * from the same Depth:0 PROPFIND so Client Push can identify root-folder propagation without an
   * extra request. Standard WebDAV clients may omit this method. Implementations must not throw.
   */
  getRootInfo?(): Promise<RemoteRootInfo>;
  /**
   * List the directories (WebDAV collections) beneath `path` (recursive). Surfaced
   * separately from {@link getFiles} so directories are first-class entities the engine
   * can prune when they become empty. The base folder itself is excluded.
   *
   * Same unreadable-body contract as {@link getFiles} (upstream change): a 207 whose body cannot be
   * parsed as a listing throws RemoteListingUnreadableError rather than resolving to [].
   */
  getDirectories(path: string): Promise<RemoteDirInfo[]>;
  /**
   * True iff the collection at `path` has no children (one Depth:1 probe). Data-loss guard before
   * {@link deleteCollection}. An unreadable body resolves to false.
   */
  isRemoteDirEmpty(path: string): Promise<boolean>;
  /** Creates a directory and any missing ancestors via MKCOL; an existing collection is fine. */
  createDirectory(path: string): Promise<void>;
  /**
   * Creates the vault folder (sync root) and reports whether it had to be created. Missing ancestors
   * are created best-effort; only the vault folder itself is judged (docs/spec.md §5.2).
   * @returns 'created' (MKCOL 201), or 'exists' (MKCOL 405: the 404 listing was wrong, change nothing).
   * @throws NetworkError on any other MKCOL outcome.
   */
  createVaultRoot(): Promise<VaultRootOutcome>;
  /**
   * Deletes a collection; the DELETE is recursive, so callers MUST confirm emptiness via
   * {@link isRemoteDirEmpty} first. A 404 is treated as success.
   */
  deleteCollection(path: string): Promise<void>;
  /** Changes since `syncToken`. @throws RemoteListingUnreadableError when a 207 body cannot be parsed (never an empty change set). */
  getChanges(syncToken: string): Promise<SyncChanges>;
  /** Downloads a remote file and returns its bytes (returned, not stored in a field, so concurrent downloads cannot race). */
  downloadFile(remotePath: string): Promise<ArrayBuffer>;
  /**
   * Uploads via a single PUT.
   * @param mtime ms epoch; sent as X-OC-MTime so Nextcloud preserves the timestamp.
   * @param opts.precomputedSha256 reused for the OC-Checksum header instead of re-hashing.
   * @param opts.ifMatchEtag sent as `If-Match`; a changed remote yields 412 (PreconditionFailedError).
   */
  uploadFile(
    remotePath: string, data: ArrayBuffer, mtime?: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null; ctime?: number },
  ): Promise<void>;
  moveFile(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string, expectedRemoteId: string): Promise<void>;
  getSyncToken(): Promise<string | null>;
  /**
   * Existence check for one remote path (PROPFIND Depth 0). False only on a definitive 404;
   * any other/uncertain outcome returns true so an ambiguous result is never read as "deleted".
   */
  remoteExists(remotePath: string): Promise<boolean>;

  /**
   * Asks the server to compute and persist the SHA-256 of a remote file without downloading it.
   * Returns the lowercase hex digest, or null when unsupported/unavailable.
   */
  recalcChecksum(remotePath: string): Promise<string | null>;

  /** Lists the versions for fileId, newest first. Clients without version support throw FeatureUnsupportedError. */
  listVersions(fileId: string): Promise<FileVersion[]>;
  /** Retrieves the content of the given version. */
  getVersionContent(version: FileVersion, fileId: string): Promise<ArrayBuffer>;
  /** Restores the given version as the current file (MOVE restore). */
  restoreVersion(version: FileVersion, fileId: string): Promise<void>;

  /**
   * Uploads in chunks; the file appears atomically at the final path.
   * @param opts `ifMatchEtag` is applied to the assembling MOVE, so a changed remote yields 412 (PreconditionFailedError) as in {@link uploadFile}.
   */
  uploadChunked(
    remotePath: string, data: ArrayBuffer, chunkSizeBytes: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null; mtime?: number; ctime?: number },
  ): Promise<void>;

  /**
   * Sets the server creation time without sending the body (PROPPATCH nc:creation_time, docs/spec.md §9.7).
   * @param seconds Unix seconds, > MIN_VALID_CREATION_SECONDS
   * @returns 'applied' (207 with a 200 propstat for the property), 'rejected' (the server refused it, or the client cannot express it)
   * @throws NetworkError on a transport failure, 401, 404, 423, 5xx or any other status (transient: retried by the next real scan)
   */
  setCreationTime(remotePath: string, seconds: number): Promise<'applied' | 'rejected'>;

  /** Acquires a file lock and returns the token. @throws FileLockedError on HTTP 423. */
  lockFile(remotePath: string): Promise<string>;
  /** Releases the lock; best-effort, never throws. */
  unlockFile(remotePath: string, token: string): Promise<void>;
}

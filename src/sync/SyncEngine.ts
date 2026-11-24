import { App, Notice, Platform, TFolder, apiVersion } from 'obsidian';
import { hashLocalFile } from '../data/localSignature';
import { CreationTimeAligner } from './ctime/CreationTimeAligner';
import {
  DavSyncSettings,
  FileState,
  FileVersion,
  NextcloudFeatures,
  RemoteFileInfo,
  RemoteDirInfo,
  SyncSessionSummary,
  SyncFileOp,
  SyncHistoryDetail,
  SyncTokenExpiredError,
  NetworkError,
  type PendingFileRename,
  type PendingFolderMove,
  PreconditionFailedError,
  RemoteCompareResult,
  RemoteRootChangedError,
  RemoteRootMissingError,
  AppPasswordReader,
  CredentialsNotFoundError,
} from '../types';
import { LocalAdapter, type LocalStat, type LocalWriteExpectation } from '../data/LocalAdapter';
import { StateDB } from '../data/StateDB';
import type { MergeBaseStore } from '../data/MergeBaseStore';
import type { CleanSideStore } from '../data/CleanSideStore';
import type { CleanSideMetrics } from '../ui/compareResolution';
import {
  parentDir as parentDirOf,
  ancestorMatching,
  isTextEligible,
  isLocallyUnchanged as isLocallyUnchangedPure,
  isSystemExcluded as isSystemExcludedPure,
} from './policy';
import { LocalScanner } from './scan/LocalScanner';
import { RemoteListingSource, type FullScanListing } from './scan/RemoteListingSource';
import { SyncJournal } from './session/SyncJournal';
import { OversizeSkipNotifier } from './session/OversizeSkipNotifier';
import { MergeBaseRecorder } from './session/MergeBaseRecorder';
import { TransferService } from './transfer/TransferService';
import { VersionService, VersionComparison } from './versions/VersionService';
import { LineHistoryResult } from './versions/lineHistory';
import { remoteIdOf, withTrustedChecksum } from './remoteIdentity';
import { checksumProvesIdentical, convergedState } from './identity/contentIdentity';
import { DeletionService } from './deletion/DeletionService';
import { ResolutionService } from './resolution/ResolutionService';
import { ConflictApplier } from './conflict/ConflictApplier';
import { hasCompleteMarkerSet } from './ConflictResolver';
import { DirectoryReconciler } from './directory/DirectoryReconciler';
import { RemoteFolderGuard, assertTrackedParentReadable, replacedRemoteFolders } from './directory/RemoteFolderGuard';
import { WatchOperations } from './watch/WatchOperations';
import { LocalCreationGrace } from './watch/LocalCreationGrace';
import { SyncActivityGate } from './SyncActivityGate';
import { RemotePushReconciler, type RemoteBatchReconcileResult, type RemotePushBatch } from './push/RemotePushReconciler';
import type { ClientPushScopeResult } from './push/PushSyncScheduler';
import { matchesTrackedRemote } from './push/matchesTrackedRemote';
import { MirrorService } from './mirror/MirrorService';
import { SyncHistoryStore } from '../data/SyncHistoryStore';
import { IStatusBar } from '../ui/StatusBarItem';
import { WebDAVFactory } from '../network/WebDAVFactory';
import { IWebDAVClient, type RemoteRootInfo } from '../network/IWebDAVClient';
import { ancestorsOf } from '../network/RemoteDirCache';
import { RenameTracker } from './RenameTracker';
import { PendingFileRenames, fileRenameStatus } from './PendingFileRenames';
import { PendingFolderMoves, folderMoveStatus, inFolder } from './PendingFolderMoves';
import { prepareFolderMoveTracking } from './directory/folderMoveTracking';
import { findUnobservedFolderMoves } from './directory/inferFolderMoves';
import type { SyncStatusReport } from '../ui/statusFilter';
import { ConfigSyncResolver } from './ConfigSyncResolver';
import { PluginSyncCoordinator } from './plugins/PluginSyncCoordinator';
import { partitionPluginManifestsLast, pluginDirPath } from './plugins/pluginPaths';
import { fileSameContent } from './plugins/bundleDirection';
import { collectCommunityPluginCandidates, type PluginCandidateList } from './plugins/candidates';
import { computeSyncScopeFingerprint } from './plugins/scopeFingerprint';
import { dropSubtreeTracking } from './deletion/subtreeTracking';
import { sha256 } from '../util/hash';
import { FIXED, chunkThresholdMB } from '../util/fixedSyncConfig';
import { FileLogger } from '../util/FileLogger';
import {
  isCellularBlocked, MAX_HASH_SIZE,
  MAX_INFLIGHT_BYTES_DESKTOP, MAX_INFLIGHT_BYTES_MOBILE, effectiveMassDeleteLimit,
} from '../util/limits';
import { createLimiter, ByteSemaphore } from '../util/ConcurrencyLimiter';
import { MirrorPlan, MirrorResult } from './mirrorPlan';
import { IUploadStrategy } from './upload/IUploadStrategy';
import { SimpleUploadStrategy } from './upload/SimpleUploadStrategy';
import { ChunkedUploadStrategy } from './upload/ChunkedUploadStrategy';

interface InitialSyncPlan {
  uploads: string[];
  downloads: string[];
  conflicts: string[];
  deletes: string[];
  unchanged: string[];
}

interface SyncEngineOptions {
  app: App;
  settings: DavSyncSettings;
  localAdapter: LocalAdapter;
  stateDB: StateDB;
  baseStore?: MergeBaseStore;
  // Clean sides of marker-conflicted notes, so force-resolution restores real content instead of markers (docs/spec.md §6.4).
  cleanSideStore?: CleanSideStore;
  statusBar: IStatusBar;
  /** Optional status surface for lightweight watch operations. */
  lightweightStatusBar?: IStatusBar;
  /** Persisted per-file sync-history log for the status dialog. Optional (absent in some tests). */
  historyStore?: SyncHistoryStore;
  webdavFactory: WebDAVFactory;
  // Resolves the app password at the start of every sync, so a cleared secret fails before any request (docs/spec.md §15.2).
  readAppPassword?: AppPasswordReader;
  pluginDir: string;
  configDir: string;
  /** The host probes the installed plugin folder inside the vault. */
  isLocalVaultAvailable?: () => Promise<boolean>;
  /** Pause ordinary sync while the host plans or applies a remote mirror. */
  isRemoteMirrorOpen?: () => boolean;
  // Host-owned predicate for this device's active log files, which must stay out of sync (docs/spec.md §9.1).
  isActiveLogFile?: (path: string) => boolean;
  // True while the user is typing into `path`. Consulted before any REMOTE -> LOCAL write, because writing under the cursor
  // discards edits; uploads are unaffected (docs/spec.md §5.7b).
  isBeingEdited?: (path: string) => boolean;
  localCreationGrace?: LocalCreationGrace;
  logger?: FileLogger;
  // Lets the host persist the server version without coupling the engine to settings persistence.
  onFeatures?: (features: NextcloudFeatures) => void;
  onTeamMountDiscovered?: () => void;
  // Plugin ids whose code was written and that still need an Obsidian restart. Shared with the host so it
  // outlives engine re-creation; a fresh set when omitted.
  pluginsAwaitingRestart?: Set<string>;
}

type PushRootState = StateDB & {
  getRootListingGeneration?(): number;
  getRemoteRootFileId?(): string | null;
};

export class SyncEngine {
  private autoSyncHandle: number | null = null;
  private lastSummary: SyncSessionSummary | null = null;
  private retryQueue: string[] = [];
  private client: IWebDAVClient | null = null;
  private features: NextcloudFeatures | null = null;
  // The password the cached connection was made with; a different one rebuilds the connection (docs/spec.md §15.2).
  // Kept in memory only, never written to settings or logs.
  private connectedPassword: string | null = null;
  private uploadStrategy: IUploadStrategy | null = null;
  // Balking flag: a second syncManual() call returns immediately.
  private running = false;
  // Set by requestStop(): workers stop pulling new work, while the run's finally block still saves state.
  private cancelled = false;
  // Lets abortAndWait() await a running sync's wind-down (including its final state save) before a reset.
  private currentRun: Promise<boolean> | null = null;
  private readonly journal: SyncJournal;

  private readonly mergeBase: MergeBaseRecorder;
  // One aligner shared by transfer, resolution and conflicts (docs/spec.md §9.7).
  private readonly creationTime: CreationTimeAligner;
  private readonly transfer: TransferService;
  private readonly firstUploads = new Set<string>();
  private readonly firstDirectories = new Map<string, symbol>();

  private readonly versions: VersionService;

  private readonly deletion: DeletionService;

  private readonly resolution: ResolutionService;

  private readonly conflicts: ConflictApplier;

  private readonly directories: DirectoryReconciler;
  private readonly remoteFolders: RemoteFolderGuard;

  private readonly watch: WatchOperations;
  private readonly localCreations: LocalCreationGrace;
  private deferredRemoteThisRun = false;
  /** Shared/exclusive gate: lightweight path operations may overlap each other, never a full sync. */
  private readonly activityGate = new SyncActivityGate();
  /** Resolves notify_push IDs and delegates only safe known-file work to the existing classifier. */
  private readonly remotePush: RemotePushReconciler;
  private teamMountListing?: { client: IWebDAVClient; scope: string; root: RemoteRootInfo; ids: Set<string> };
  private observedPushRoot?: { etag: string; client: IWebDAVClient; scope: string; generation: number };

  private readonly mirror: MirrorService;
  // Turns each session's over-the-size-limit skip tally into the one end-of-sync notice (docs/spec.md §9.4a).
  private readonly oversizeSkips: OversizeSkipNotifier;
  private syncProgress = { processed: 0, total: 0 };
  // Monotonic; read as a delta around one watch operation to learn whether it touched a conflict.
  // Summary counters cannot say: conflicts settled by a deterministic strategy count as plain uploads/downloads.
  private conflictEncounters = 0;
  private renameTracker: RenameTracker | null = null;
  private readonly pendingFileRenames: PendingFileRenames;
  private readonly pendingFolderMoves: PendingFolderMoves;
  private readonly observedFolderDeletes = new Map<string, { scope: string; fileId: string | null }>();
  // Single source of truth for which config-folder paths sync (shared by isSystemExcluded, the remote filter
  // and the remote-deletion scope guard).
  private readonly configSync: ConfigSyncResolver;

  private readonly pluginsAwaitingRestart: Set<string>;
  // This plugin's own folder name, derived from `pluginDir` so there is a single source for it.
  private readonly ownPluginId: string;
  private readonly plugins: PluginSyncCoordinator;

  private readonly localScanner: LocalScanner;

  // Accessors, not values: capabilities arrive later (ensureClient) and settings can change.
  private readonly remoteListing: RemoteListingSource;

  constructor(private readonly opts: SyncEngineOptions) {
    this.localCreations = opts.localCreationGrace
      ?? new LocalCreationGrace(() => (opts.settings.newItemDelaySeconds ?? 0) * 1000);
    this.pluginsAwaitingRestart = opts.pluginsAwaitingRestart ?? new Set();
    // Tolerates a bare engine built without a plugin folder (some suites construct one with only the fields they use).
    const pluginDir: string = opts.pluginDir ?? '';
    this.ownPluginId = pluginDir.slice(pluginDir.lastIndexOf('/') + 1);
    this.plugins = new PluginSyncCoordinator({
      configDir: opts.configDir,
      ownId: this.ownPluginId,
      settings: opts.settings,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      awaitingRestart: this.pluginsAwaitingRestart,
      obsidianVersion: apiVersion,
      isMobile: () => Platform.isMobile,
      now: () => Date.now(),
      notify: (m, t) => { new Notice(m, t); },
      logger: opts.logger,
    });
    this.configSync = new ConfigSyncResolver({
      configDir: opts.configDir,
      settings: opts.settings,
      pluginDir: opts.pluginDir,
      localAdapter: opts.localAdapter,
      pluginGate: this.plugins,
    });
    this.pendingFileRenames = new PendingFileRenames({
      state: opts.stateDB,
      local: opts.localAdapter,
      scope: () => this.fileRenameScope(),
      isExcluded: (p) => this.isSystemExcluded(p) || this.plugins.isPluginPath(p),
      canMove: async (source, destination) => {
        const parent = parentDirOf(source);
        if (parent && this.opts.stateDB.getDir(parent) && !await this.opts.localAdapter.isFolder(parent)) {
          throw new Error('The file is inside a missing local folder. Reconcile the folder before renaming the file.');
        }
        if (this.pendingFolderMoves.holds(source) || this.pendingFolderMoves.holds(destination)) {
          throw new Error('Reconcile the pending folder move before renaming the file.');
        }
      },
      move: (source, destination, etag) => this.getOrCreateRenameTracker().moveRemoteFile(source, destination, etag),
      moveTracking: (source, destination, file) => this.moveFileTracking(source, destination, file),
      isCancelled: () => this.cancelled,
    });
    this.pendingFolderMoves = new PendingFolderMoves({
      state: opts.stateDB,
      local: opts.localAdapter,
      scope: () => this.fileRenameScope(),
      isExcluded: (p) => this.isSystemExcluded(p) || this.plugins.isPluginPath(p),
      containsExcludedFolder: (p) => this.opts.settings.excludedFolders?.some(path => inFolder(path, p)) ?? false,
      canWrite: async (client, _source, destination) => {
        await this.assertLocalVaultAvailable();
        await assertTrackedParentReadable(client, this.opts.stateDB, '');
        await assertTrackedParentReadable(client, this.opts.stateDB, destination);
      },
      prepareTracking: async (source, destination) => {
        const tracking = await prepareFolderMoveTracking(opts.stateDB, source, destination, opts.baseStore, opts.cleanSideStore);
        return { ...tracking, commit: () => {
          tracking.commit();
          this.pendingFileRenames.rebaseAfterFolderMove(source, destination);
        } };
      },
      isCancelled: () => this.cancelled,
    });
    this.localScanner = new LocalScanner({
      localAdapter: opts.localAdapter,
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      isUnderConfigDir: (p) => this.configSync.isUnderConfigDir(p),
      enumerateIncludedConfigPaths: () => this.configSync.enumerateIncludedPaths(),
    });
    this.journal = new SyncJournal({ historyStore: opts.historyStore, logger: opts.logger });
    this.mergeBase = new MergeBaseRecorder({
      baseStore: opts.baseStore,
      autoMergeFileTypes: () => this.opts.settings.autoMergeFileTypes,
      isPluginPath: (p) => this.plugins.isPluginPath(p),
    });
    this.creationTime = new CreationTimeAligner({
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      isBeingEdited: (p) => this.opts.isBeingEdited?.(p) ?? false,
      logger: opts.logger,
    });
    this.transfer = new TransferService({
      isBeingEdited: opts.isBeingEdited,
      isRenameHeld: (p) => this.isPathHeld(p),
      beginFirstUpload: path => this.beginFirstUpload(path),
      creationTime: this.creationTime,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      localWrite: this.plugins,
      journal: this.journal,
      mergeBase: this.mergeBase,
      maxFileSizeMB: () => this.opts.settings.maxFileSizeMB,
      hasFilesLocking: () => this.features?.hasFilesLocking === true,
      // Keyed on the connected client, not the server's self-report: only NextcloudClient fills in `checksum`.
      clientReportsChecksums: () => this.features?.isNextcloud === true,
      queueRetry: (p) => { this.retryQueue.push(p); },
      logger: opts.logger,
    });
    this.versions = new VersionService({
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      mergeBase: this.mergeBase,
      canApplyRestore: path => !this.isPathHeld(path) && !opts.isBeingEdited?.(path),
      flushMergeBase: () => this.opts.baseStore?.flush() ?? Promise.resolve(),
      // Markdown is always a mergeable text type in the sync engine even though `md` is
      // intentionally not stored in autoMergeFileTypes. Version compare/line history must mirror
      // that same policy: Markdown + every user-configured Auto Merge File type.
      isTextEligible: (path) => path.toLowerCase().endsWith('.md')
        || isTextEligible(path, this.opts.settings.autoMergeFileTypes),
    });
    this.remoteFolders = new RemoteFolderGuard(opts.app, opts.stateDB);
    this.deletion = new DeletionService({
      canDeleteMissingChild: (path, summary) => this.canDeleteMissingChild(path, summary),
      assertLocalVaultAvailable: () => this.assertLocalVaultAvailable(),
      isRenameHeld: (p) => this.isPathHeld(p),
      hasRenameInFolder: (p) => this.hasRenameInFolder(p),
      app: opts.app,
      localAdapter: opts.localAdapter,
      isBeingEdited: opts.isBeingEdited,
      remoteFolders: this.remoteFolders,
      stateDB: opts.stateDB,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      dropCleanSnapshot: (p) => this.resolution.dropCleanSnapshot(p),
      markOwnEvent: (p) => this.opts.localAdapter.ignore(p),
      logger: opts.logger,
    });
    this.resolution = new ResolutionService({
      creationTime: this.creationTime,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      historyStore: opts.historyStore,
      cleanSideStore: opts.cleanSideStore,
      localWrite: this.plugins,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      autoMergeFileTypes: () => this.opts.settings.autoMergeFileTypes,
      maxFileSizeMB: () => this.opts.settings.maxFileSizeMB,
      logger: opts.logger,
    });
    this.conflicts = new ConflictApplier({
      isRenameHeld: (p) => this.isPathHeld(p),
      isBeingEdited: opts.isBeingEdited,
      creationTime: this.creationTime,
      app: opts.app,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      baseStore: opts.baseStore,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      resolution: this.resolution,
      localWrite: this.plugins,
      pluginConflictRule: (p) => this.plugins.conflictRuleFor(p),
      resolverConfig: () => ({
        autoMergeFileTypes: this.opts.settings.autoMergeFileTypes,
        autoMergeFileStrategy: this.opts.settings.autoMergeFileStrategy,
        otherFileStrategy: this.opts.settings.otherFileStrategy,
        deviceId: this.opts.settings.deviceId,
        frontmatterStrategy: this.opts.settings.frontmatterStrategy,
        conflictStrategy: this.opts.settings.conflictStrategy,
      }),
      maxFileSizeMB: () => this.opts.settings.maxFileSizeMB,
      queueRetry: (p) => { this.retryQueue.push(p); },
      onConflictEncountered: () => { this.conflictEncounters++; },
      logger: opts.logger,
    });
    this.directories = new DirectoryReconciler({
      hasRenameInFolder: (p) => this.hasRenameInFolder(p),
      isRenameHeld: (p) => this.isPathHeld(p),
      app: opts.app,
      stateDB: opts.stateDB,
      journal: this.journal,
      mergeBase: this.mergeBase,
      dropCleanSnapshot: (p) => this.resolution.dropCleanSnapshot(p),
      markOwnEvent: (p) => this.opts.localAdapter.ignore(p),
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      massDeleteLimit: () => this.opts.settings.massDeleteLimit,
      isCancelled: () => this.cancelled,
      logger: opts.logger,
    });
    this.watch = new WatchOperations({
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      historyStore: opts.historyStore,
      statusBar: opts.lightweightStatusBar ?? opts.statusBar,
      journal: this.journal,
      mergeBase: this.mergeBase,
      transfer: this.transfer,
      deletion: this.deletion,
      remoteFolders: this.remoteFolders,
      resolution: this.resolution,
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      isPluginPath: (p) => this.plugins.isPluginPath(p),
      connect: () => this.connection(),
      isRenameHeld: (p) => this.isPathHeld(p),
      hasRenameInFolder: (p) => this.hasRenameInFolder(p),
      retryFileRename: (client, _source, destination) =>
        this.retryPendingFileRenames(client, rename => rename.destination === destination),
      isBlockedByWifiOnly: () => this.isBlockedByWifiOnly(),
      isSyncRunning: () => this.isSyncRunning(),
      isCancelled: () => this.cancelled,
      reconcileStructure: async () => {
        if (!this.cancelled) await this.syncManualWithResult();
      },
      runNonFullSyncOperation: (fn) => this.activityGate.runShared(fn),
      processFile: (remote, summary) => this.processFileWithRetry(remote, summary),
      queueRetry: (p) => { this.retryQueue.push(p); },
      retryQueueLength: () => this.retryQueue.length,
      conflictEncounters: () => this.conflictEncounters,
      logger: opts.logger,
    });
    this.remotePush = new RemotePushReconciler({
      isPluginPath: (p) => this.plugins.isPluginPath(p),
      stateDB: opts.stateDB,
      isFullSyncRunning: () => this.isSyncRunning(),
      reconcileFile: (path, expectedRemoteFileId) => this.watch.reconcileRemoteFile(path, expectedRemoteFileId),
      logger: opts.logger,
    });
    this.remoteListing = new RemoteListingSource({
      stateDB: opts.stateDB,
      isNextcloud: () => this.features?.isNextcloud === true,
      networkConcurrency: () => Math.max(1, this.opts.settings.networkConcurrency),
      logger: opts.logger,
    });
    this.oversizeSkips = new OversizeSkipNotifier({
      maxFileSizeMB: () => this.opts.settings.maxFileSizeMB,
      notify: (m, t) => { new Notice(m, t); },
      logger: opts.logger,
    });
    this.mirror = new MirrorService({
      hasPendingRenames: () => this.pendingFileRenames.list().length > 0 || this.pendingFolderMoves.list().length > 0,
      app: opts.app,
      localAdapter: opts.localAdapter,
      stateDB: opts.stateDB,
      statusBar: opts.statusBar,
      journal: this.journal,
      mergeBase: this.mergeBase,
      plugins: this.plugins,
      transfer: this.transfer,
      deletion: this.deletion,
      localScanner: this.localScanner,
      remoteListing: this.remoteListing,
      progress: {
        begin: (total) => { this.syncProgress = { processed: 0, total }; },
        tick: () => { this.tickProgress(); return this.syncProgress.processed; },
      },
      oversizeSkips: this.oversizeSkips,
      enumerateIncludedConfigPaths: () => this.configSync.enumerateIncludedPaths(),
      isSystemExcluded: (p) => this.isSystemExcluded(p),
      persist: async () => {
        await opts.stateDB.save();
        await opts.baseStore?.flush();
        await opts.historyStore?.save();
      },
      connect: async () => (await this.ensureClient()).client,
      logger: opts.logger,
    });
  }

  private async assertLocalVaultAvailable(): Promise<void> {
    if (this.opts.isLocalVaultAvailable && !(await this.opts.isLocalVaultAvailable())) {
      throw new Error('The local vault or plugin folder is unavailable. Reopen the vault and sync again.');
    }
  }

  private getOrCreateRenameTracker(): RenameTracker {
    if (!this.renameTracker) {
      const client = this.client!;
      this.renameTracker = new RenameTracker(this.opts.stateDB, client, async (source, destination) => {
        if (client.inspectDirectory) await assertTrackedParentReadable(client, this.opts.stateDB, source);
        await this.remoteFolders.assertRemovalAllowed(client, source);
        await assertTrackedParentReadable(client, this.opts.stateDB, destination);
      });
    }
    return this.renameTracker;
  }

  private fileRenameScope(): string {
    const { serverUrl, username } = this.opts.settings;
    let endpoint = serverUrl ?? '';
    try {
      const url = new URL(endpoint);
      endpoint = url.origin + url.pathname.replace(/\/+$/, '');
    } catch { endpoint = ''; }
    return JSON.stringify([endpoint, username, this.opts.app.vault?.getName?.()]);
  }

  private async retryPendingFileRenames(
    client: IWebDAVClient, shouldRetry?: (rename: PendingFileRename) => boolean,
  ): Promise<boolean> {
    const eligible = (rename: PendingFileRename): boolean => (shouldRetry?.(rename) ?? true)
      && !rename.unconfirmedCreate
      && !this.pendingFolderMoves.holds(rename.source) && !this.pendingFolderMoves.holds(rename.destination)
      && (!rename.attemptedDestination || !this.pendingFolderMoves.holds(rename.attemptedDestination))
      && !this.isCreationDeferred(rename.destination);
    if (!this.pendingFileRenames.list().some(eligible)) return false;
    if (client.inspectDirectory) await assertTrackedParentReadable(client, this.opts.stateDB, '');
    return this.pendingFileRenames.retry(client, eligible);
  }

  private isRenameHeld(path: string): boolean {
    return this.pendingFileRenames.holds(path) || this.pendingFolderMoves.holds(path);
  }

  private isPathHeld(path: string): boolean {
    return this.isRenameHeld(path) || this.isCreationDeferred(path);
  }

  private isCreationDeferred(path: string): boolean {
    return this.localCreations.readyAt(path) !== undefined;
  }

  /** Only a deferred remote observation makes the remote listing or sync token incomplete. */
  private deferRemotePath(path: string): boolean {
    if (!this.isCreationDeferred(path)) return false;
    if (this.running) this.deferredRemoteThisRun = true;
    return true;
  }

  rememberLocalCreation(path: string, folder: boolean): void {
    if (!this.opts.settings.newItemDelaySeconds || this.isSystemExcluded(path) || this.plugins.isPluginPath(path)) return;
    if (folder ? this.opts.stateDB.getDir(path) : this.opts.stateDB.getFile(path)) return;
    this.localCreations.add(path, folder);
  }

  retargetLocalCreation(source: string, destination: string, folder: boolean): boolean {
    if (!this.localCreations.rename(source, destination, folder) || this.isRenameHeld(source)
      || (folder ? this.isFirstDirectoryInFlight(source) : this.firstUploads.has(source))) return false;
    // New parents can already contain destinations of pending moves for tracked items.
    if (folder && this.hasRenameInFolder(source)) return false;
    return !(folder ? this.opts.stateDB.getDir(source) : this.opts.stateDB.getFile(source));
  }

  private beginFirstUpload(path: string): (outcome?: 'uploaded' | 'skipped', createdFileId?: string) => void {
    const scope = this.fileRenameScope();
    this.firstUploads.add(path);
    return (outcome, createdFileId) => {
      this.firstUploads.delete(path);
      if (!outcome || scope !== this.fileRenameScope()) return;
      // A later stat can identify a same-content replacement. Only the write response proves which Nextcloud ID we created.
      if (outcome === 'uploaded' && this.features?.isNextcloud && !createdFileId) return;
      const file = outcome === 'uploaded' ? this.opts.stateDB.getFile(path) : null;
      if (file !== undefined && this.pendingFileRenames.finishFirstUpload(path, file)) this.persistRenameIntent();
    };
  }

  private isFirstDirectoryInFlight(path: string): boolean {
    // A first PUT may still need to create its parents after an initial "missing parent" response.
    return this.firstDirectories.has(path) || [...this.firstUploads].some(file => file.startsWith(path + '/'));
  }

  private beginDirectoryCreation(client: IWebDAVClient, path: string): ((fileId: string | null) => void) | undefined {
    if (client !== this.client || this.opts.stateDB.getDir(path) || this.isSystemExcluded(path)) return undefined;
    const ticket = Symbol();
    const scope = this.fileRenameScope();
    this.firstDirectories.set(path, ticket);
    return fileId => {
      if (this.firstDirectories.get(path) !== ticket) return;
      this.firstDirectories.delete(path);
      if (!fileId || client !== this.client || scope !== this.fileRenameScope() || this.opts.stateDB.getDir(path)) return;
      this.opts.stateDB.setDir({ path, remoteFileId: fileId });
      if (this.pendingFolderMoves.confirmCreation(path, fileId)) this.persistRenameIntent();
    };
  }

  async retryMovesIntoFolder(path: string): Promise<void> {
    if (this.hasRenameInFolder(path)) await this.syncManual();
  }

  private hasRenameInFolder(path: string): boolean {
    return this.pendingFileRenames.touchesFolder(path) || this.pendingFolderMoves.touchesFolder(path);
  }

  private moveFileTracking(source: string, destination: string, file: FileState): void {
    this.opts.stateDB.deleteFile(source);
    this.opts.stateDB.setFile({ ...file, path: destination });
    this.opts.stateDB.setRemoteRootEtag(null);
    if (this.opts.baseStore) {
      const base = this.opts.baseStore.get(source);
      this.opts.baseStore.delete(source);
      this.opts.baseStore.delete(destination);
      if (base !== undefined) this.opts.baseStore.set(destination, base);
      this.opts.baseStore.requestSave();
    }
    if (this.opts.cleanSideStore) {
      const snapshot = this.opts.cleanSideStore.get(source);
      this.opts.cleanSideStore.delete(source);
      this.opts.cleanSideStore.delete(destination);
      if (snapshot) this.opts.cleanSideStore.set(destination, snapshot);
      this.opts.cleanSideStore.requestSave();
    }
  }

  /** Lists community plugins on this device and (when reachable) the server for the picker. */
  async listCommunityPluginCandidates(): Promise<PluginCandidateList> {
    let client: IWebDAVClient | null;
    try {
      await this.ensureClient();
      client = this.client;
    } catch (err) {
      void this.opts.logger?.log(`plugins: server unavailable for candidate listing — ${(err as Error).message}`);
      client = null;
    }
    return collectCommunityPluginCandidates({
      localAdapter: this.opts.localAdapter,
      client,
      configDir: this.opts.configDir,
      ownId: this.ownPluginId,
      isMobile: Platform.isMobile,
      logger: this.opts.logger,
    });
  }

  private async ensureClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
    const read = this.opts.readAppPassword;
    const password = read ? read() : null;
    if (read && !password) throw new CredentialsNotFoundError();
    // A connection made under another password may carry features derived from a failed authentication
    // (Nextcloud's connect() does not throw on 401), so rebuild it (docs/spec.md §15.2). The previous connection
    // stays in place until the replacement exists: a concurrent caller keeps a usable client, and a failed
    // reconnect leaves it for the next attempt.
    const rebuild = !!read && !!this.client && password !== this.connectedPassword;
    if (!this.client || !this.features || rebuild) {
      const { client, features } = await this.opts.webdavFactory.createClient();
      this.client = client;
      client.trackKnownDirectories?.(this.opts.stateDB, path => this.beginDirectoryCreation(client, path));
      if (features.isNextcloud && this.opts.onTeamMountDiscovered) {
        const accountScope = this.fileRenameScope();
        client.onTeamMountListing = (root, mounts) => {
          if (this.cancelled || client !== this.client || accountScope !== this.fileRenameScope() || !this.opts.settings.useClientPush) return;
          const scope = this.pushScopeKey();
          const ids = new Set([...mounts].filter(([path]) => !path || !this.isSystemExcluded(path)).map(([, id]) => id));
          const previous = this.teamMountListing;
          const discovered = [...ids].filter(id => previous?.client !== client || previous.scope !== scope || !previous.ids.has(id));
          this.teamMountListing = { client, scope, ids, root };
          if (!discovered.length) return;
          const notify = () => {
            const latest = this.teamMountListing;
            if (!this.cancelled && this.opts.settings.useClientPush && this.client === client && latest?.client === client
              && latest.scope === scope && scope === this.pushScopeKey() && this.hasCurrentClientCredentials(password)
              && discovered.some(id => latest.ids.has(id))) this.opts.onTeamMountDiscovered?.();
          };
          // A slow initial download must not consume the entire catch-up window while sync is busy.
          if (this.currentRun) void this.currentRun.then(notify).catch(() => { /* best-effort catch-up */ });
          else notify();
        };
      }
      this.renameTracker = null;
      this.features = features;
      this.connectedPassword = password;
      // Chunked upload needs the account-only uploads namespace, which a public link share lacks (docs/spec.md §3);
      // the threshold is platform-derived (docs/spec.md §15.1.2).
      const uploadConfig = { maxFileSizeMB: () => this.opts.settings.maxFileSizeMB, uploadChunkThresholdMB: chunkThresholdMB(Platform.isMobile) };
      this.uploadStrategy = (FIXED.chunkedUploadEnabled && features.isNextcloud && features.hasAccountDav)
        ? new ChunkedUploadStrategy(uploadConfig)
        : new SimpleUploadStrategy(uploadConfig);
      this.opts.onFeatures?.(features);
    }
    if (this.client.requireExistingVaultRoot) {
      if (this.opts.stateDB.hasObservedRemoteRoot()) this.rememberRemoteRoot(this.client);
      else this.client.requireExistingVaultRoot(false);
    }
    return { client: this.client, features: this.features };
  }

  // navigator.connection.type exists only on Chromium/Android: desktop leaves it undefined (never blocks)
  // and iOS has no navigator.connection (the setting is ignored there).
  private isBlockedByWifiOnly(): boolean {
    const conn = (navigator as Navigator & { connection?: { type?: string } }).connection;
    return isCellularBlocked(this.opts.settings.syncOnWifiOnly, Platform.isIosApp, conn?.type);
  }

  /** Whether a new Android foreground-watch operation may use the current network. */
  canRunWatchSync(): boolean {
    if (typeof navigator === 'undefined') return true;
    if (navigator.onLine === false) return false;
    return !this.isBlockedByWifiOnly();
  }

  /** True while full sync, persistence, or the host's remote-mirror dialog owns the vault. */
  isSyncRunning(): boolean {
    return this.running || this.currentRun !== null || this.opts.isRemoteMirrorOpen?.() === true;
  }

  /**
   * Client Push scope gate. Only a positively changed Nextcloud vault-root ETag is eligible for
   * targeted reconciliation. An unchanged root is ignored; every uncertain/stale-baseline case uses
   * the ordinary full sync. The changed result carries the CURRENT root ETag only as batch-local push
   * context; this method never updates StateDB, so only a real full scan advances the authoritative
   * stored root ETag.
   */
  async shouldReconcileClientPush(fileIds: readonly string[] = [], probeOnly?: true): Promise<ClientPushScopeResult> {
    const unknown: ClientPushScopeResult = probeOnly ? { kind: 'ignore' } : { kind: 'full-sync' };
    // An explicit hint for a pending move must survive Wi-Fi gating and an unchanged root.
    if (this.isPendingRenamePush(fileIds)) return { kind: 'full-sync', retryOnUnchanged: true };

    // Preserve the existing Wi-Fi-only behavior without making a new network request on cellular.
    if (this.isBlockedByWifiOnly()) return unknown;

    // Do not create/connect a client just for the optimization. The first ordinary sync establishes
    // the client and the root-ETag baseline; until then a push follows the original full-sync path.
    const client = this.client;
    const password = this.connectedPassword;
    if (!client || this.features?.isNextcloud !== true || !this.hasCurrentClientCredentials(password)) {
      return unknown;
    }
    const scope = this.pushScopeKey();

    // A token-capable server can advance StateDB without a real full scan, while remoteRootEtag is
    // deliberately updated only by full scans. Avoid using a potentially stale baseline there.
    if (this.opts.stateDB.getSyncToken()) return unknown;

    const db = this.opts.stateDB;
    const fingerprint = db.getSyncScopeFingerprint?.();
    if (fingerprint != null && fingerprint !== computeSyncScopeFingerprint(this.opts.settings)) return unknown;
    const listing = this.teamMountListing;
    if (probeOnly && (!listing?.ids.size || listing.client !== client || listing.scope !== scope)) return unknown;
    // The first sync may not yet have a stored ETag. Its own listing supplies a read-only baseline for this probe.
    const stored = db.getRemoteRootEtag() ?? (probeOnly ? listing?.root.etag : null);
    const generation = db.getRootListingGeneration?.();
    const observed = this.observedPushRoot;
    const observedEtag = observed?.client === client && observed.scope === scope && observed.generation === generation
      ? observed.etag : null;
    if (stored == null && observedEtag == null) return unknown;

    const root = client.getRootInfo
      ? await client.getRootInfo()
      : { etag: await client.getRootEtag(), fileId: null };
    // Capability and root information can go stale during a password change. Let the normal
    // sync path reconnect and establish the scope before using a targeted result.
    const expectedRoot = db.getRemoteRootFileId?.() ?? (probeOnly ? listing?.root.fileId : null);
    if (root.etag == null || (expectedRoot && root.fileId !== expectedRoot) || client !== this.client
      || (probeOnly && listing !== this.teamMountListing)
      || scope !== this.pushScopeKey() || generation !== db.getRootListingGeneration?.() || !this.hasCurrentClientCredentials(password)) {
      return unknown;
    }
    // A local move can be captured while the scope probe was in flight.
    if (this.isPendingRenamePush(fileIds)) return { kind: 'full-sync', retryOnUnchanged: true };
    if (root.etag !== stored && root.etag !== observedEtag) {
      void this.opts.logger?.log(`client-push: vault root ETag changed (${stored} → ${root.etag}) → reconciliation required`);
      return { kind: 'targeted', rootFileId: root.fileId?.trim() || null, rootEtag: root.etag };
    }

    void this.opts.logger?.log(`client-push: vault root ETag unchanged (${root.etag})`);
    return { kind: 'ignore' };
  }

  private isPendingRenamePush(fileIds: readonly string[]): boolean {
    if (!fileIds.length) return false;
    const scope = this.fileRenameScope();
    const ids = new Set(fileIds);
    if (this.pendingFileRenames.list().some(rename => rename.scope === scope && !!rename.fileId && ids.has(rename.fileId))) return true;
    const moves = this.pendingFolderMoves.list().filter(move => move.scope === scope);
    if (!moves.length) return false;
    const held = (path: string): boolean => moves.some(move => inFolder(path, move.source) || inFolder(path, move.destination)
      || (!!move.attemptedDestination && inFolder(path, move.attemptedDestination)));
    return moves.some(move => !!move.fileId && ids.has(move.fileId))
      || fileIds.some(id => {
        const file = this.opts.stateDB.getFileByRemoteId(id);
        return file !== undefined && held(file.path);
      })
      || this.opts.stateDB.getAllDirs().some(dir => !!dir.remoteFileId && ids.has(dir.remoteFileId) && held(dir.path));
  }

  private pushScopeKey(): string {
    return JSON.stringify([this.fileRenameScope(), computeSyncScopeFingerprint(this.opts.settings)]);
  }

  /** Read-only proof for unknown IDs, generic notifications and reconnect gaps after targeted sync. */
  async verifyClientPushRoot(root: Extract<ClientPushScopeResult, { kind: 'targeted' }>): Promise<boolean> {
    const client = this.client;
    if (!client?.getRootInfo || !root.rootFileId || this.features?.isNextcloud !== true || this.isSyncRunning()
      || !this.canRunWatchSync() || !this.hasCurrentClientCredentials(this.connectedPassword)
      || this.pendingFileRenames.list().length || this.pendingFolderMoves.list().length) return false;
    const db = this.opts.stateDB;
    if (db.getSyncToken() || db.getRemoteRootEtag() == null || this.retryQueue.length) return false;
    const generation = db.getRootListingGeneration();
    const scope = this.pushScopeKey();
    const password = this.connectedPassword;
    const [files, dirs] = await Promise.all([client.getFiles(''), client.getDirectories('')]);
    const latest = await client.getRootInfo();
    if (latest.etag !== root.rootEtag || latest.fileId !== root.rootFileId || client !== this.client
      || this.isSyncRunning() || !this.canRunWatchSync() || generation !== db.getRootListingGeneration() || scope !== this.pushScopeKey()
      || !this.hasCurrentClientCredentials(password) || this.retryQueue.length
      || this.pendingFileRenames.list().length || this.pendingFolderMoves.list().length) return false;
    if (!matchesTrackedRemote(files, dirs, this.rebuildRemoteFilesFromState(), this.rebuildRemoteDirsFromState(), path => this.isSystemExcluded(path))) return false;
    this.observedPushRoot = { etag: root.rootEtag, client, scope, generation };
    return true;
  }

  private hasCurrentClientCredentials(password: string | null): boolean {
    const read = this.opts.readAppPassword;
    return !read || (password !== null && read() === password);
  }

  async syncManual(opts: { manual?: boolean; refreshRemote?: boolean } = {}): Promise<void> {
    await this.syncManualWithResult(opts);
  }

  /** Client Push fallback needs to know whether an authoritative full-sync attempt really completed. */
  async syncForClientPush(): Promise<boolean> {
    return this.syncManualWithResult();
  }

  private async syncManualWithResult(opts: { manual?: boolean; refreshRemote?: boolean } = {}): Promise<boolean> {
    // Mobile has no status bar; sync state (progress + result) is surfaced via NoticeStatusBar,
    // which implements IStatusBar and is driven uniformly for every run. The two early-return
    // guidance notices below still need an explicit mobile notice because those paths return
    // before any syncing toast is created. Desktop keeps using the status bar (no popups).
    void this.opts.logger?.log(`sync: start (manual=${opts.manual === true})`);
    // Prevent concurrent runs (avoid clashing with watch mode or scheduled sync).
    if (this.isSyncRunning()) {
      void this.opts.logger?.log('sync: skipped — already running');
      // Automatic triggers (startup / interval / resume) may legitimately race another full sync.
      // That is a normal no-op, not something that should interrupt a mobile user with a toast.
      // Keep the guidance only for an explicit user-initiated "Sync now" action.
      if (Platform.isMobile && opts.manual === true) new Notice('⏳ A sync is already in progress.');
      return false;
    }
    if (this.isBlockedByWifiOnly()) { // "Wi-Fi only" enabled and on cellular
      void this.opts.logger?.log('sync: skipped — Wi-Fi-only and on cellular');
      if (Platform.isMobile) new Notice('Sync skipped — you are on cellular and Wi-Fi only sync is on.', 6000);
      return false;
    }
    // Set the balking flag synchronously (before any await) so a concurrent call still balks.
    this.running = true;
    this.cancelled = false;
    // Full sync is exclusive with watch/lightweight operations. Existing lightweight work may
    // finish first; once this writer is queued, later lightweight work waits behind it.
    const run = this.activityGate.runExclusive(() => this.runSyncSession(opts.manual === true, opts.refreshRemote === true));
    this.currentRun = run;
    let completed = false;
    try {
      completed = await run;
    } finally {
      this.currentRun = null;
      // The run is over, so deferred watch edits can be evaluated. Best-effort: a failure must not propagate out of "Sync now".
      try {
        await this.drainWatchPending();
      } catch (err) {
        console.warn('[SyncEngine] Deferred watch-mode sync failed:', err);
      }
    }
    return completed;
  }

  private async runSyncSession(manual: boolean, refreshRemote: boolean): Promise<boolean> {
    // Created before the try so catch/finally can reference them even if the first step fails.
    const summary = this.initSummary();
    this.journal.beginRun(summary.startedAt);

    let completed = false;
    try {
      await this.assertLocalVaultAvailable();
      this.deferredRemoteThisRun = false;
      if (manual) this.localCreations.clear();
      // Connect INSIDE the try: if ensureClient() threw or hung outside it, the finally that clears `running` would be
      // skipped and the engine would balk forever as "already running".
      void this.opts.logger?.log('sync: connecting (ensureClient)');
      await this.ensureClient();
      this.plugins.begin(manual ? 'manual' : 'automatic');
      this.invalidateRootEtagOnScopeChange();
      // A permissions-only change on Nextcloud can leave the vault root ETag untouched.
      if (refreshRemote) this.opts.stateDB.setRemoteRootEtag(null);
      this.syncProgress = { processed: 0, total: 0 };
      this.opts.statusBar.setStatus('syncing', { automatic: !manual });

      const canMoveFolder = (move: PendingFolderMove): boolean => !this.isCreationDeferred(move.destination)
        && (!move.unconfirmedCreate || move.source === move.destination);
      if (this.pendingFolderMoves.list().some(canMoveFolder)) {
        await assertTrackedParentReadable(this.client!, this.opts.stateDB, '');
        await this.pendingFolderMoves.retry(this.client!, canMoveFolder);
      }
      if (this.pendingFileRenames.list().length) await this.retryPendingFileRenames(this.client!);
      const isFirstSync = !this.opts.stateDB.getSyncToken()
        && this.opts.stateDB.getAllFiles().length === 0 && this.opts.stateDB.getAllDirs().length === 0
        && !(this.client?.requireExistingVaultRoot && this.opts.stateDB.hasObservedRemoteRoot());

      if (isFirstSync) {
        await this.initialSync(summary);
      } else {
        await this.incrementalSync(summary, refreshRemote);
      }
      if (this.deferredRemoteThisRun) this.opts.stateDB.setSyncToken(null);
      completed = !this.cancelled;
    } catch (err) {
      this.opts.stateDB.setRemoteRootEtag(null);
      console.error('[SyncEngine] Sync failed:', err);
      void this.opts.logger?.log(`sync: FAILED — ${(err as Error).message}`, 'error');
      new Notice(`❌ Sync failed: ${(err as Error).message}`, 6000);
      this.recordError(summary, '', err);
    } finally {
      // Clear `running` FIRST: the teardown below can throw (state/history save), which would otherwise leave the
      // engine permanently "running".
      this.running = false;
      for (const rename of this.pendingFileRenames.list()) {
        if (rename.issue) {
          summary.errorCount++;
          summary.errors.push({ path: rename.source, message: fileRenameStatus(rename), pendingRename: true });
        }
      }
      for (const move of this.pendingFolderMoves.list()) {
        if (move.issue) {
          summary.errorCount++;
          summary.errors.push({ path: move.source, message: folderMoveStatus(move), pendingRename: true });
        }
      }
      this.journal.endRun();

      void this.opts.logger?.log(
        `sync: done up=${summary.uploadedCount} down=${summary.downloadedCount} ` +
        `del=${summary.deletedCount} merged=${summary.mergedCount} conflicted=${summary.conflictedCount} err=${summary.errorCount} cancelled=${this.cancelled}`,
      );
      this.logSessionErrors(summary);
      summary.completedAt = Date.now();
      this.lastSummary = summary;
      this.opts.stateDB.setLastSyncTime(Date.now());
      this.finishPluginSession(summary);
      await this.persistAfterSession();
      const conflictCount = this.opts.stateDB.countConflicted();
      this.opts.statusBar.setSyncComplete(
        summary.uploadedCount, summary.downloadedCount,
        conflictCount, summary.errorCount,
      );
      // Result display is owned by the status bar surface (StatusBarItem / NoticeStatusBar) via setSyncComplete.
      // The one skip-count notice of a manual sync comes after the result, so it is the last thing shown (docs/spec.md §9.4a).
      this.oversizeSkips.sessionFinished(summary, manual ? 'manual' : 'automatic');
    }
    return completed;
  }

  // A changed sync scope (or a state saved before the fingerprint existed) makes the stored root ETag
  // meaningless: files that were out of scope never entered the tracked listing a short-circuit rebuilds
  // (docs/spec.md §8a.5).
  private invalidateRootEtagOnScopeChange(): void {
    const fingerprint = computeSyncScopeFingerprint(this.opts.settings);
    if (this.opts.stateDB.getSyncScopeFingerprint() === fingerprint) return;
    this.opts.stateDB.setRemoteRootEtag(null);
    this.opts.stateDB.setSyncScopeFingerprint(fingerprint);
  }

  // Best-effort: a plugin-session failure must not escape the finally and mask the original error.
  private finishPluginSession(summary: SyncSessionSummary): void {
    try {
      const out = this.plugins.finish();
      summary.pluginsNeedingRestart = out.pluginsNeedingRestart;
      if (out.invalidateRootEtag) this.opts.stateDB.setRemoteRootEtag(null);
    } catch (e) {
      void this.opts.logger?.log(`sync: plugin session finish failed — ${(e as Error).message}`, 'error');
    }
  }

  // Best-effort: a save failure must not escape the finally and mask the original error.
  private async persistAfterSession(): Promise<void> {
    try {
      await this.opts.stateDB.save();
      await this.opts.historyStore?.save();
    } catch (persistErr) {
      console.error('[SyncEngine] Post-sync persistence failed:', persistErr);
      void this.opts.logger?.log(`sync: post-sync save failed — ${(persistErr as Error).message}`, 'error');
    }
  }

  // Selects the listed plugins for this session, then forgets tracking of plugins that must not be treated as
  // removed from the server (docs/spec.md §7).
  private async preparePluginSession(client: IWebDAVClient, remoteFiles: readonly RemoteFileInfo[]): Promise<void> {
    await this.plugins.prepare(client, remoteFiles);
    this.dropStalePluginTracking();
  }

  private dropStalePluginTracking(): void {
    for (const id of this.plugins.staleTrackedIds()) {
      dropSubtreeTracking({
        stateDB: this.opts.stateDB,
        mergeBase: this.mergeBase,
        dropCleanSnapshot: (p) => this.resolution.dropCleanSnapshot(p),
      }, pluginDirPath(id, this.opts.configDir));
    }
  }

  /**
   * Mobile Watch structural recovery.
   *
   * Normally an ordinary full sync that started after the uncertain event (resume/startup/push/
   * manual) is authoritative enough, so await it instead of racing a second run. When the structural
   * event itself occurred DURING the current scan, requireFreshAfterCurrent=true: that scan may
   * already have passed the affected path, so wait for it to settle and then use/start a successor.
   * Either way this is the ordinary full-sync path; Watch owns no separate merge/reconcile rules.
   */
  async syncForWatchRecovery(requireFreshAfterCurrent = false): Promise<boolean> {
    const current = this.currentRun;
    if (current) {
      try {
        const completed = await current;
        if (!requireFreshAfterCurrent) return completed;
      } catch {
        if (!requireFreshAfterCurrent) return false;
        // A structural event occurred during the failed run; retry below with a fresh full sync.
      }

      // Another authoritative run may have started after the old one settled (resume/push/manual).
      // Because that successor necessarily began after the structural event, it is fresh enough.
      const successor = this.currentRun;
      if (successor) {
        try {
          return await successor;
        } catch {
          return false;
        }
      }
    }
    return this.syncManualWithResult();
  }

  private logSessionErrors(summary: SyncSessionSummary): void {
    this.journal.logSessionErrors(summary);
  }



  syncSingleFile(path: string): Promise<void> {
    return this.watch.syncSingleFile(path);
  }

  /** Reconcile notify_push IDs without advancing the collection sync token. */
  async reconcileRemoteFileIds(batch: RemotePushBatch): Promise<RemoteBatchReconcileResult> {
    if (!this.hasCurrentClientCredentials(this.connectedPassword)) return 'full-sync';
    const available = this.canRunWatchSync() && (!this.opts.isLocalVaultAvailable || await this.opts.isLocalVaultAvailable());
    if (this.isPendingRenamePush(batch.fileIds)) return 'rename-pending';
    if (!available) return 'deferred';
    const result = await this.remotePush.reconcileFileIds(batch);
    return this.isPendingRenamePush(batch.fileIds) ? 'rename-pending' : result;
  }

  /**
   * Android foreground-watch wrapper around the SAME upstream single-file operation.
   *
   * WatchOperations intentionally contains NetworkError and queues the path for the next ordinary
   * sync. Mobile additionally wants to retry promptly when connectivity returns while the app stays
   * open, so report whether this attempt added retry work without changing the classifier itself.
   */
  async syncSingleFileForMobileWatch(path: string): Promise<boolean> {
    const retryCount = (): number => this.retryQueue.reduce(
      (count, queued) => count + (queued === path ? 1 : 0),
      0,
    );
    const retriesBefore = retryCount();
    await this.watch.syncSingleFile(path);
    return retryCount() <= retriesBefore;
  }


  /** @see WatchOperations.drainPending */
  private drainWatchPending(): Promise<void> {
    return this.watch.drainPending();
  }

  /** The same active host resumes deferred work after its mirror dialog has closed. */
  async resumeAfterRemoteMirror(): Promise<void> {
    if (this.opts.isRemoteMirrorOpen?.()) return;
    this.cancelled = false;
    try {
      await this.drainWatchPending();
    } catch (err) {
      void this.opts.logger?.log(`watch: could not resume after remote mirror — ${(err as Error).message}`);
    }
  }

  deleteSingleFile(path: string): Promise<void> {
    return this.watch.deleteSingleFile(path);
  }

  /**
   * Mobile result wrapper for a local file deletion. A guarded delete may legitimately restore the
   * remote file when another device changed it; that is converged too. What needs structural recovery
   * is the state where the tracked entry remains AND the local path is still absent (e.g. transport
   * failure swallowed by the upstream watch method).
   */
  async deleteSingleFileForMobileWatch(path: string): Promise<boolean> {
    const trackedBefore = this.opts.stateDB.getFile(path);
    await this.watch.deleteSingleFile(path);
    if (!trackedBefore || !this.opts.stateDB.getFile(path)) return true;
    return (await this.opts.localAdapter.stat(path)) != null;
  }

  /** Records local intent even when Watch is off, on cellular, or a full scan is active. */
  rememberFileRename(oldPath: string, newPath: string): void {
    if (this.pendingFolderMoves.coversChildEvent(oldPath, newPath)) return;
    const source = this.pendingFolderMoves.originalPath(oldPath);
    if (this.pendingFileRenames.capture(oldPath, newPath, 'observed', source, this.firstUploads.has(source))) {
      this.persistRenameIntent();
    }
  }

  rememberFolderRename(oldPath: string, newPath: string): void {
    this.forgetFolderDeletion(newPath);
    const folder = this.pendingFolderMoves.capture(oldPath, newPath, false, this.isFirstDirectoryInFlight(oldPath));
    const files = this.pendingFileRenames.captureFolder(oldPath, newPath);
    if (folder || files) this.persistRenameIntent();
  }

  rememberFolderDeletion(path: string): void {
    if (this.pendingFolderMoves.markDestinationRemoved(path)) this.persistRenameIntent();
    const base = this.opts.stateDB.getDir(path);
    if (base && !this.hasRenameInFolder(path)) {
      this.observedFolderDeletes.set(path, { scope: this.fileRenameScope(), fileId: base.remoteFileId });
    }
  }

  forgetFolderDeletion(path: string): void {
    for (const previous of this.observedFolderDeletes.keys()) {
      if (inFolder(previous, path) || inFolder(path, previous)) this.observedFolderDeletes.delete(previous);
    }
  }

  private async canDeleteMissingChild(path: string, summary: SyncSessionSummary): Promise<boolean> {
    return this.canDeleteFromMissingFolder(parentDirOf(path), summary);
  }

  private async canDeleteFromMissingFolder(
    folder: string, summary: SyncSessionSummary, listedDirectoryId?: string,
  ): Promise<boolean> {
    let missing: string | undefined;
    for (let parent = folder; parent; parent = parentDirOf(parent)) {
      const dir = this.opts.stateDB.getDir(parent);
      if (!dir) continue;
      if (await this.opts.localAdapter.isFolder(parent)) {
        this.observedFolderDeletes.delete(parent);
        break;
      }
      missing = parent;
      const observed = this.observedFolderDeletes.get(parent);
      if (observed?.fileId === dir.remoteFileId && observed.scope === this.fileRenameScope()) {
        // Record the verified missing descendant before a sibling download can recreate the
        // ancestor locally. Subsequent file work still has to prove each individual deletion.
        if (listedDirectoryId && parent !== folder
            && this.opts.stateDB.getDir(folder)?.remoteFileId === listedDirectoryId) {
          this.observedFolderDeletes.set(folder, { scope: observed.scope, fileId: listedDirectoryId });
        }
        return true;
      }
    }
    if (!missing) return true;
    if (!summary.errors.some(error => error.path === missing)) {
      this.recordError(summary, missing, new Error('This local folder disappeared without a recorded move or deletion. Its Nextcloud files were kept. Review both sides before deleting or moving the folder in Nextcloud.'));
    }
    return false;
  }

  private persistRenameIntent(): void {
    void this.opts.stateDB.save().catch(err => {
      console.warn('[SyncEngine] Could not save the rename:', err);
    });
  }


  /** @see WatchOperations.renameSingleFile */
  renameSingleFile(oldPath: string, newPath: string): Promise<void> {
    this.rememberFileRename(oldPath, newPath);
    return this.syncRememberedFileRename(oldPath, newPath);
  }

  syncRememberedFileRename(oldPath: string, newPath: string): Promise<void> {
    if (this.isSyncRunning()) return Promise.resolve();
    return this.watch.renameSingleFile(oldPath, newPath);
  }

  /**
   * Mobile result wrapper for MOVE. A tracked rename is converged only when the existing StateDB
   * identity moved with it. Untracked renames are intentionally conservative: a full reconcile is
   * safer than guessing whether a pre-first-sync/new local file ever existed remotely.
   */
  async syncRememberedFileRenameForMobileWatch(oldPath: string, newPath: string): Promise<boolean> {
    const trackedBefore = this.opts.stateDB.getFile(oldPath);
    await this.syncRememberedFileRename(oldPath, newPath);
    if (!trackedBefore) return false;
    return this.opts.stateDB.getFile(oldPath) == null && this.opts.stateDB.getFile(newPath) != null;
  }

  /** @see WatchOperations.createSingleFolder */
  createSingleFolder(path: string): Promise<void> {
    return this.watch.createSingleFolder(path);
  }

  async createSingleFolderForMobileWatch(path: string): Promise<boolean> {
    await this.watch.createSingleFolder(path);
    return this.opts.stateDB.getDir(path) != null;
  }

  /** @see WatchOperations.deleteSingleFolder */
  deleteSingleFolder(path: string): Promise<void> {
    this.rememberFolderDeletion(path);
    return this.watch.deleteSingleFolder(path);
  }

  async deleteSingleFolderForMobileWatch(path: string): Promise<boolean> {
    const trackedBefore = this.opts.stateDB.getDir(path);
    this.rememberFolderDeletion(path);
    await this.watch.deleteSingleFolder(path);
    return !trackedBefore || this.opts.stateDB.getDir(path) == null;
  }

  async renameSingleFolder(oldPath: string, newPath: string): Promise<void> {
    this.rememberFolderRename(oldPath, newPath);
    await this.watch.renameSingleFolder(oldPath, newPath);
  }

  async renameSingleFolderForMobileWatch(oldPath: string, newPath: string): Promise<boolean> {
    const trackedBefore = this.opts.stateDB.getDir(oldPath);
    this.rememberFolderRename(oldPath, newPath);
    await this.watch.renameSingleFolder(oldPath, newPath);
    if (!trackedBefore) return false;
    return this.opts.stateDB.getDir(oldPath) == null && this.opts.stateDB.getDir(newPath) != null;
  }

  startAutoSync(intervalMinutes: number): void {
    this.stopAutoSync();
    const ms = intervalMinutes * 60 * 1000;
    this.autoSyncHandle = window.setInterval(() => {
      void this.syncManual();
    }, ms);
  }

  stopAutoSync(): void {
    if (this.autoSyncHandle !== null) {
      window.clearInterval(this.autoSyncHandle);
      this.autoSyncHandle = null;
    }
  }

  async flushState(): Promise<void> {
    await this.opts.stateDB.flush();
    await this.opts.baseStore?.flush();
    await this.opts.cleanSideStore?.flush();
  }

  // massDeleteLimit: -1 = automatic dynamic limit, 0 = unlimited (breaker off), N > 0 = fixed limit (docs/spec.md §8).
  private effectiveMassDeleteLimit(tracked: number): number {
    return effectiveMassDeleteLimit(this.opts.settings.massDeleteLimit, tracked);
  }

  private dropMergeBase(path: string): void {
    this.mergeBase.drop(path);
  }

  private captureCleanSides(
    path: string, local: string, remote: string,
    localMtime: number, localSize: number, remoteInfo: RemoteFileInfo,
  ): void {
    this.resolution.captureCleanSides(path, local, remote, localMtime, localSize, remoteInfo);
  }

  private dropCleanSnapshot(path: string): void {
    this.resolution.dropCleanSnapshot(path);
  }

  private sweepResolvedSnapshots(): void {
    this.resolution.sweepResolvedSnapshots();
  }

  cleanSideMetrics(path: string): CleanSideMetrics | null {
    return this.resolution.cleanSideMetrics(path);
  }

  async applyCleanRemote(path: string): Promise<void> {
    this.assertFileRenameSettled(path);
    return this.resolution.applyCleanRemote(await this.connectionForWrite(path), path);
  }

  async applyCleanLocal(path: string): Promise<void> {
    this.assertFileRenameSettled(path);
    return this.resolution.applyCleanLocal(await this.connectionForWrite(path), path);
  }

  // "remote" makes local match remote, "local" makes remote match local (directory create/delete).
  // Throws on failure without touching StateDB (docs/spec.md §8).
  async resolveSkippedDir(
    path: string,
    category: 'deleteRemote' | 'trashLocal',
    choice: 'remote' | 'local',
  ): Promise<void> {
    const { client } = await this.ensureClient();
    return this.directories.resolveSkippedDir(client, path, category, choice);
  }

  // Mutates lastSummary.errors in place, so the next getStatusReport() reflects the outcome. Refuses during a full sync:
  // reconcileDirectories writes the same StateDB directory rows, risking a mkdir-then-trash flicker on one path.
  async resolveAllSkippedDirs(choice: 'remote' | 'local'): Promise<{ resolved: number; failed: number }> {
    if (this.running) throw new Error('Cannot resolve skipped directories — sync in progress');
    const { client } = await this.ensureClient();
    return this.directories.resolveAllSkippedDirs(client, this.lastSummary, choice);
  }


  // Phase 1 of termination: signal workers to stop pulling work; the run's finally block still persists state.
  requestStop(): void {
    this.cancelled = true;
    this.teamMountListing = undefined;
  }

  // Waits for the run's final state save so a following reset cannot interleave with it. Never throws.
  async abortAndWait(): Promise<void> {
    this.requestStop();
    const run = this.currentRun;
    if (run) {
      try { await run; } catch { /* runSyncSession swallows its own errors */ }
    }
    // A restore also changes StateDB and the local file. Maintenance must wait for its save, too.
    await this.activityGate.runExclusive(() => undefined);
  }

  // Resets only the tracking index; no vault or remote file is touched, so the next sync runs as a first sync.
  async resetIndex(): Promise<void> {
    await this.abortAndWait();
    await this.opts.stateDB.reset();
  }

  // Read-only. The listing is a real PROPFIND (no root-ETag short-circuit); on failure the plan is ok:false so nothing is
  // deleted. The mass-delete limit is deliberately not consulted: the user declared the remote authoritative (docs/spec.md §14).
  planRemoteMirror(onPhase?: (label: string) => void): Promise<MirrorPlan> {
    return this.mirror.planRemoteMirror(onPhase);
  }

  // Uses the already-resolved client: apply always follows a plan, and planRemoteMirror is what connects.
  applyRemoteMirror(
    plan: MirrorPlan, onProgress?: (done: number, total: number) => void,
  ): Promise<MirrorResult> {
    this.localCreations.clear();
    return this.mirror.applyRemoteMirror(this.client!, plan, onProgress);
  }

  getLastSessionSummary(): SyncSessionSummary | null {
    return this.lastSummary;
  }

  // Persisted, so it survives restarts and is stamped by every sync; the resume trigger uses it as its cooldown
  // baseline (docs/spec.md §5.8).
  getLastSyncTime(): number {
    return this.opts.stateDB.getLastSyncTime();
  }

  getStatusReport(): SyncStatusReport {
    const conflictedFiles = this.opts.stateDB.getAllFiles()
      .filter(f => f.isConflicted)
      .map(f => f.path);
    return {
      summary: this.lastSummary,
      conflictedFiles,
      retryFiles: [...this.retryQueue],
      history: this.opts.historyStore?.recent() ?? [],
      pendingFileRenames: this.pendingFileRenames.list(),
      pendingFolderMoves: this.pendingFolderMoves.list(),
    };
  }

  getUnresolvedConflictCount(): Promise<number> {
    return this.resolution.getUnresolvedConflictCount();
  }

  async compareWithRemote(path: string): Promise<RemoteCompareResult> {
    const { client } = await this.ensureClient();
    return this.resolution.compareWithRemote(client, path);
  }


  async pushLocalToRemote(path: string): Promise<void> {
    this.assertFileRenameSettled(path);
    return this.resolution.pushLocalToRemote(await this.connectionForWrite(path), path);
  }

  async pullRemoteToLocal(path: string): Promise<void> {
    this.assertFileRenameSettled(path);
    const { client } = await this.ensureClient();
    return this.resolution.pullRemoteToLocal(client, path);
  }

  private assertFileRenameSettled(path: string): void {
    if (this.isRenameHeld(path)) throw new Error('Resolve the pending rename in Sync status before changing this path.');
  }

  private textEligible(path: string): boolean {
    return isTextEligible(path, this.opts.settings.autoMergeFileTypes);
  }

  private fetchRemoteInfo(path: string): Promise<RemoteFileInfo | null> {
    return this.resolution.fetchRemoteInfo(this.client!, path);
  }

  // Deliberately does not connect: the conflict paths run inside an already-connected sync.
  private currentConnection(): { client: IWebDAVClient; uploadStrategy: IUploadStrategy } {
    return { client: this.client!, uploadStrategy: this.uploadStrategy! };
  }

  private async connection(): Promise<{ client: IWebDAVClient; uploadStrategy: IUploadStrategy }> {
    const { client } = await this.ensureClient();
    return { client, uploadStrategy: this.uploadStrategy! };
  }


  private async connectionForWrite(path: string): Promise<{ client: IWebDAVClient; uploadStrategy: IUploadStrategy }> {
    const conn = await this.connection();
    if (conn.client.inspectDirectory) await assertTrackedParentReadable(conn.client, this.opts.stateDB, path);
    return conn;
  }

  private initSummary(): SyncSessionSummary {
    return this.journal.newSummary();
  }

  private recordError(
    summary: SyncSessionSummary,
    path: string,
    err: unknown,
    skippedPaths?: { all: string[] },
    dirBreakerSkipped?: { deleteRemote: string[]; trashLocal: string[] },
  ): void {
    this.journal.recordError(summary, path, err, skippedPaths, dirBreakerSkipped);
  }

  private recordHistory(path: string, op: SyncFileOp, message?: string, detail?: SyncHistoryDetail): void {
    this.journal.recordHistory(path, op, message, detail);
  }

  // For established Nextcloud roots, 404 can mean lost access to a mount. MKCOL could create a private
  // folder at the same path and replay the vault into it. Plain WebDAV keeps its existing recovery.
  private async reseedFromLocal(summary: SyncSessionSummary): Promise<void> {
    if (this.pendingFileRenames.list().length || this.pendingFolderMoves.list().length) {
      throw new Error('The remote vault is unavailable. Pending file renames and the local files were kept.');
    }
    if (this.client!.requireExistingVaultRoot && this.opts.stateDB.hasObservedRemoteRoot()) {
      throw new Error('The synced Nextcloud vault folder is missing or inaccessible. Local files were kept. Check the remote path and permissions.');
    }
    const outcome = await this.client!.createVaultRoot();
    if (outcome === 'exists') {
      void this.opts.logger?.log(
        'sync: vault folder listing said 404 but MKCOL says it exists — treating the listing as failed; nothing changed',
        'error',
      );
      throw new Error('Vault folder listing failed (server reported it missing, but it exists). Nothing was changed; will retry on the next sync.');
    }
    void this.opts.logger?.log('sync: vault folder missing on the server → created it; re-seeding from local (tracking reset, no local deletions)');
    new Notice('The vault folder was missing on the server. It has been re-created and this vault is being re-uploaded from this device.', 8000);
    // Reset rather than force-upload: the first-run path already uploads every local file and MKCOLs every local folder
    // against an empty remote.
    await this.opts.stateDB.reset();
    await this.initialSync(summary);
  }

  private async initialSync(summary: SyncSessionSummary): Promise<void> {
    const client = this.client!;
    // With nothing tracked, a missing vault folder just means the server has nothing; the first upload creates the hierarchy
    // (also covers the re-seed path).
    let remoteFiles: RemoteFileInfo[];
    try {
      remoteFiles = await client.getFiles('');
      this.rememberRemoteRoot(client);
    } catch (err) {
      if (!(err instanceof RemoteRootMissingError)) throw err;
      void this.opts.logger?.log('sync: INITIAL — no vault folder on the server yet; the first upload will create it');
      remoteFiles = [];
    }
    remoteFiles = remoteFiles.filter(file => !this.deferRemotePath(file.path) && !this.isRenameHeld(file.path));
    await this.preparePluginSession(client, remoteFiles);
    const localFiles = await this.scanLocalFiles();
    for (const path of localFiles.keys()) {
      if (this.isPathHeld(path)) localFiles.delete(path);
    }

    // Server-computed checksums (no download) let identical files count as unchanged rather than conflicts.
    if (this.features?.isNextcloud) remoteFiles = remoteFiles.map(file => withTrustedChecksum(file, undefined, true));
    await this.remoteListing.resolveRemoteChecksums(client,
      remoteFiles.filter(file => localFiles.get(file.path)?.size === file.size && file.size <= MAX_HASH_SIZE), localFiles);

    const plan = await this.buildInitialPlan(localFiles, remoteFiles);
    // With no recorded state, every local file the server lacks is an UPLOAD, including files deleted on another device
    // (resurrection path); the plan is logged for that reason.
    void this.opts.logger?.log(
      `sync: INITIAL sync (empty state) plan — up=${plan.uploads.length} down=${plan.downloads.length} ` +
      `unchanged=${plan.unchanged.length} conflicts=${plan.conflicts.length}. ` +
      `uploads(resurrection candidates)=[${plan.uploads.slice(0, 30).join(', ')}${plan.uploads.length > 30 ? ', …' : ''}]`,
      'verbose',
    );

    await this.executePlan(plan, remoteFiles, summary, localFiles);

    // A complete listing, so directory create/delete can be reconciled.
    await this.reconcileDirectories(summary);

    const token = await client.getSyncToken();
    this.opts.stateDB.setSyncToken(this.retryQueue.length ? null : token);
  }

  private rememberRemoteRoot(client: IWebDAVClient): void {
    if (!client.requireExistingVaultRoot) return;
    this.opts.stateDB.markRemoteRootObserved();
    client.requireExistingVaultRoot(true);
  }

  private async incrementalSync(summary: SyncSessionSummary, refreshRemote: boolean): Promise<void> {
    const client = this.client!;
    const rootListingGeneration = this.opts.stateDB.getRootListingGeneration();
    const pushScope = this.pushScopeKey();
    let remoteFiles: RemoteFileInfo[];
    // A full scan has a complete listing (absence implies remote deletion). The token path only has a diff.
    let fullScan: FullScanListing | undefined;

    const existingToken = refreshRemote ? null : this.opts.stateDB.getSyncToken();
    // A missing vault folder can surface from any listing call below, including the token-expired fallback, hence one guard
    // around both. Nextcloud answers the token REPORT with 415 (docs/spec.md §18), so that branch is unreachable there.
    try {
      if (existingToken) {
        try {
          const changes = await client.getChanges(existingToken);
          this.opts.stateDB.setSyncToken(changes.newSyncToken);
          remoteFiles = changes.modified;
          void this.opts.logger?.log(`sync: incremental via token (modified=${changes.modified.length}, remote-deleted=${changes.deleted.length})`);

          // Apply remote renames (fileId-based) before deletions so a rename is not seen as delete + new upload.
          const rt = this.getOrCreateRenameTracker();
          const remoteRenames = rt.detectRemoteRenames(remoteFiles);
          for (const [oldPath, newPath] of remoteRenames) {
            if (this.deferRemotePath(oldPath) || this.deferRemotePath(newPath)
              || this.isRenameHeld(oldPath) || this.isRenameHeld(newPath)) continue;
            await rt.applyRemoteRename(oldPath, newPath);
          }

          for (const deletedPath of changes.deleted) {
            await this.processRemoteDeletion(deletedPath, summary);
          }
        } catch (err) {
          if (err instanceof SyncTokenExpiredError) {
            // Fall back to a full scan (the root-ETag short-circuit may rebuild the listing from State).
            fullScan = await this.obtainFullScanListing(client);
            remoteFiles = fullScan.remoteFiles;
            const token = await client.getSyncToken();
            this.opts.stateDB.setSyncToken(token);
            void this.opts.logger?.log(`sync: sync-token expired → FULL SCAN (remote=${remoteFiles.length}, shortCircuit=${fullScan.cachedDirs != null}, nextToken=${token ? 'obtained' : 'NULL'}). Remote deletions detected by absence (full-scan reconciliation)`);
          } else {
            throw err;
          }
        }
      } else {
        // No prior token (the common Nextcloud case: sync-collection REPORT is unsupported, docs/spec.md §18), so every sync lands here.
        fullScan = await this.obtainFullScanListing(client);
        remoteFiles = fullScan.remoteFiles;
        const token = await client.getSyncToken();
        this.opts.stateDB.setSyncToken(token);
        void this.opts.logger?.log(`sync: FULL SCAN, no prior token (remote=${remoteFiles.length}, shortCircuit=${fullScan.cachedDirs != null}, nextToken=${token ? 'obtained' : 'NULL'}). Remote deletions detected by absence (full-scan reconciliation)`);
      }
    } catch (err) {
      if (!(err instanceof RemoteRootMissingError)) throw err;
      await this.reseedFromLocal(summary);
      return;
    }
    if (fullScan) this.rememberRemoteRoot(client);

    // Verify the directory view before any writes based on the file listing.
    let remoteDirs = fullScan?.cachedDirs ?? undefined;
    if (fullScan && !remoteDirs) {
      try { remoteDirs = await client.getDirectories(''); }
      catch (err) {
        if (client.inspectDirectory || err instanceof RemoteRootChangedError || err instanceof RemoteRootMissingError) throw err;
        void this.opts.logger?.log(`dir-sync: listing failed — skip this session: ${(err as Error).message}`);
      }
    }

    const replaced = replacedRemoteFolders(remoteDirs ?? [], this.opts.stateDB, path => this.isSystemExcluded(path));
    const missingLocally = new Set<string>();
    const isHeld = (path: string, remoteObservation = false): boolean =>
      (remoteObservation ? this.deferRemotePath(path) : this.isCreationDeferred(path))
      || replaced.has(path) || missingLocally.has(path)
      || ((replaced.size > 0 || missingLocally.size > 0)
        && ancestorMatching(path, parent => replaced.has(parent) || missingLocally.has(parent)) !== undefined);
    for (const path of replaced) {
      if (ancestorMatching(path, parent => replaced.has(parent))) continue;
      this.recordError(summary, path, new Error('A different Nextcloud folder is now at this path. Local files and sync tracking were kept.'));
    }

    if (fullScan) {
      if (remoteDirs?.length && client.statFolderMovePath) {
        const folderMoves = await findUnobservedFolderMoves(this.opts.localAdapter, this.opts.stateDB, remoteDirs,
          path => isHeld(path) || this.hasRenameInFolder(path) || this.isSystemExcluded(path) || this.plugins.isPluginPath(path));
        let captured = false;
        for (const [source, destination] of folderMoves) {
          captured = this.pendingFolderMoves.capture(source, destination, true) || captured;
        }
        if (captured) await this.opts.stateDB.save();
        const vault = this.opts.app.vault as App['vault'] & { getAllFolders?: () => TFolder[] };
        const local = new Set(vault.getAllFolders?.().map(folder => folder.path));
        const trackedParents = new Set(this.opts.stateDB.getAllFiles().flatMap(file => ancestorsOf(file.path)));
        for (const dir of remoteDirs) {
          if (!dir.fileId || !trackedParents.has(dir.path) || local.has(dir.path) || isHeld(dir.path) || this.isRenameHeld(dir.path) || this.isSystemExcluded(dir.path)
            || this.opts.stateDB.getDir(dir.path)?.remoteFileId !== dir.fileId) continue;
          if (!await this.canDeleteFromMissingFolder(dir.path, summary, dir.fileId)) {
            missingLocally.add(dir.path);
          }
        }
      }
      const inferred = await this.inferUnobservedFileRenames(remoteFiles, isHeld);
      if (inferred.size && await this.retryPendingFileRenames(client, rename => inferred.has(rename.source))) {
        // Obtain a fresh snapshot after issuing a MOVE against the old one.
        fullScan = await this.obtainFullScanListing(client);
        remoteFiles = fullScan.remoteFiles;
        remoteDirs = fullScan.cachedDirs ?? await client.getDirectories('');
      }
    }

    summary.retriedFiles = this.retryQueue.splice(0);

    const scopeFiles = remoteFiles.filter(f => !isHeld(f.path, true) && !this.isRenameHeld(f.path));
    await this.preparePluginSession(client, scopeFiles);
    const eligible = scopeFiles.filter(f => !this.isSystemExcluded(f.path));
    this.syncProgress = { processed: 0, total: eligible.length };
    if (eligible.length > 0) this.opts.statusBar.setProgress(0, eligible.length);
    // Bounded parallel; uploads to the same directory are serialized to avoid 423s. A plugin's manifest.json goes last so a
    // half-written bundle never advertises a new version (docs/spec.md §7).
    const { rest, manifests } = partitionPluginManifestsLast(eligible, (f) => f.path, this.opts.configDir);
    await this.runFileBatch(
      [...rest, ...manifests],
      (r) => r.path,
      (r) => r.size,
      async (r) => { await this.processFileWithRetry(r, summary); this.tickProgress(); },
      true,
    );

    const withinLocalDeleteLimit = await this.processLocalModifications(remoteFiles, summary, fullScan !== undefined, remoteDirs, isHeld);

    // Only a COMPLETE listing can show directory absence; the token path's partial diff cannot.
    if (remoteDirs) await this.reconcileDirectories(summary, remoteDirs, !withinLocalDeleteLimit, isHeld);

    // Drop captured clean sides for paths that converged, keeping snapshots bounded to currently-conflicted files.
    this.sweepResolvedSnapshots();

    // An incomplete run cannot reconstruct a complete listing. Size-limit skips are deliberate: their
    // observed metadata keeps the listing complete without fabricating a common base (docs/spec.md §8a.5).
    const incomplete = this.cancelled || this.deferredRemoteThisRun
      || summary.conflictedCount > 0 || summary.errorCount > 0 || this.retryQueue.length > 0;
    const pendingRenames = this.pendingFolderMoves.list().length > 0 || this.pendingFileRenames.list().length > 0;
    if (incomplete || pendingRenames || (fullScan && !remoteDirs)) {
      this.opts.stateDB.setRemoteRootEtag(null);
      // This listing covered non-held paths. Ignore account noise for this ETag while allowing
      // explicit hints for the held paths to retry independently of the ordinary sync cache.
      if (!incomplete && pendingRenames && fullScan?.rootEtag && remoteDirs && pushScope === this.pushScopeKey()) {
        this.observedPushRoot = { etag: fullScan.rootEtag, client, scope: pushScope, generation: this.opts.stateDB.getRootListingGeneration() };
      }
    } else if (fullScan && this.opts.stateDB.getRootListingGeneration() === rootListingGeneration) {
      const sizeSkippedFiles = eligible.filter(file => summary.oversizeSkippedPaths.has(file.path));
      this.opts.stateDB.setRemoteRootEtag(fullScan.rootEtag, sizeSkippedFiles);
    }
  }

  /** Infer a rename only within one folder and only from an unchanged local file signature. */
  private async inferUnobservedFileRenames(
    remoteFiles: readonly RemoteFileInfo[], isHeld: (path: string) => boolean,
  ): Promise<Set<string>> {
    const inferred = new Set<string>();
    if (!this.features?.isNextcloud || !remoteFiles.length) return inferred;
    const local = this.opts.localAdapter.listVaultFiles?.() ?? [];
    const localPaths = new Set(local.map(file => file.path));
    const remotePaths = new Set(remoteFiles.map(file => file.path));
    const eligible = (path: string): boolean => !isHeld(path) && !this.isRenameHeld(path)
      && !this.isSystemExcluded(path) && !this.plugins.isPluginPath(path);
    const missing = new Map<number, FileState[]>();
    for (const file of remoteFiles) {
      if (!file.fileId || localPaths.has(file.path) || !eligible(file.path)) continue;
      const base = this.opts.stateDB.getFile(file.path);
      if (base?.remoteFileId !== file.fileId || base.localMtime === undefined || base.isConflicted || base.size > MAX_HASH_SIZE) continue;
      const sameSize = missing.get(base.size) ?? [];
      sameSize.push(base);
      missing.set(base.size, sameSize);
    }
    if (!missing.size) return inferred;

    const matches = new Map<string, string[]>();
    for (const file of local) {
      const sameSize = missing.get(file.size);
      if (!sameSize || remotePaths.has(file.path) || this.opts.stateDB.getFile(file.path) || !eligible(file.path)) continue;
      const bytes = await this.opts.localAdapter.readBinary(file.path).catch(() => null);
      if (!bytes || bytes.byteLength !== file.size) continue;
      const hash = await sha256(bytes);
      const originals = sameSize.filter(base => base.localHash === hash
        && base.localMtime === file.mtime && parentDirOf(base.path) === parentDirOf(file.path));
      if (originals.length !== 1) continue;
      const source = originals[0].path;
      const destinations = matches.get(source) ?? [];
      destinations.push(file.path);
      matches.set(source, destinations);
    }
    for (const [source, destinations] of matches) {
      if (destinations.length === 1 && !(await this.opts.localAdapter.stat(source))
        && this.pendingFileRenames.capture(source, destinations[0], 'inferred')) inferred.add(source);
    }
    if (inferred.size) await this.opts.stateDB.save();
    return inferred;
  }

  private async processFileWithRetry(remote: RemoteFileInfo, summary: SyncSessionSummary): Promise<void> {
    if (this.deferRemotePath(remote.path) || this.isRenameHeld(remote.path)) return;
    try {
      await this.processRemoteFile(remote, summary);
    } catch (err) {
      if (err instanceof NetworkError) {
        console.warn(`[SyncEngine] Error syncing ${remote.path}, queuing retry:`, err);
        this.retryQueue.push(remote.path);
        this.recordError(summary, remote.path, err);
      } else {
        // Local I/O errors (ENOENT, EACCES, etc.) must not abort the entire session.
        console.warn(`[SyncEngine] Error syncing ${remote.path}:`, err);
        void this.opts.logger?.log(`sync: error on ${remote.path} — ${(err as Error).message}`, 'error');
        this.recordError(summary, remote.path, err);
      }
    }
  }

  // The decision (including the safety-window guard) lives in ./policy; clock and last-sync time are accessors so StateDB
  // is consulted only when needed.
  private isLocallyUnchanged(base: FileState, stat: { mtime: number; size: number }): boolean {
    return isLocallyUnchangedPure(base, stat, {
      now: () => Date.now(),
      lastSyncTime: () => this.opts.stateDB.getLastSyncTime(),
    });
  }

  // Concurrency is capped by networkConcurrency AND by in-flight bytes (ByteSemaphore): requestUrl buffers whole bodies,
  // so a count-only cap would OOM on large files. With serializeByDir, same-directory workers run sequentially to avoid
  // directory-lock 423s. Workers must handle their own errors and never reject the batch (docs/plan.md §11).
  private async runFileBatch<T>(
    items: T[],
    pathOf: (it: T) => string,
    sizeOf: (it: T) => number,
    worker: (it: T) => Promise<void>,
    serializeByDir: boolean,
  ): Promise<void> {
    if (items.length === 0) return;
    const max = Math.max(1, this.opts.settings.networkConcurrency);
    const limiter = createLimiter(max);
    const budget = new ByteSemaphore(Platform.isMobile ? MAX_INFLIGHT_BYTES_MOBILE : MAX_INFLIGHT_BYTES_DESKTOP);
    const dirChains = new Map<string, Promise<void>>();

    const tasks = items.map((it) => limiter(async () => {
      // After requestStop(), queued workers no-op so no further network calls start.
      if (this.cancelled) return;
      const runOne = async (): Promise<void> => {
        const release = await budget.acquire(Math.max(0, sizeOf(it)));
        try {
          await worker(it);
        } finally {
          release();
        }
      };
      if (!serializeByDir) {
        await runOne();
        return;
      }
      const dir = parentDirOf(pathOf(it));
      const prev = dirChains.get(dir) ?? Promise.resolve();
      // Chain regardless of the previous task's outcome so one failure doesn't wedge the directory.
      const run = prev.then(runOne, runOne);
      dirChains.set(dir, run.then(() => undefined, () => undefined));
      await run;
    }));
    await Promise.all(tasks);
  }

  private async processRemoteFile(info: RemoteFileInfo, summary: SyncSessionSummary): Promise<void> {
    const base = this.opts.stateDB.getFile(info.path);
    const remote = withTrustedChecksum(info, base, this.features?.isNextcloud);
    const localStat = await this.opts.localAdapter.stat(remote.path);
    const { remoteId, idType } = remoteIdOf(remote);

    const remoteChanged = !base || base.remoteId !== remoteId;
    let localChanged = false;
    let localHash = base?.localHash ?? '';

    if (localStat && base) {
      // Skip reading/hashing while the post-write stat signature still matches; unlike on-disk mtime, it is valid on mobile
      // (docs/plan.md §4).
      if (base.checkAfterFolderMove || !this.isLocallyUnchanged(base, localStat)) {
        localHash = await hashLocalFile(this.opts.localAdapter, this.opts.stateDB, remote.path, localStat, base);
        localChanged = localHash !== base.localHash;
      }
    } else if (localStat) {
      // The file exists on both sides with no baseline: treating that as "local unchanged" would download over a local edit
      // (issue #23). Hash it and treat it as changed unless provably equal, so the both-changed arm resolves it as a conflict.
      const buf = await this.opts.localAdapter.readBinary(remote.path);
      localHash = await sha256(buf);
      localChanged = true;
    } else {
      localChanged = false;
    }

    if (this.deferRemotePath(remote.path) || this.isRenameHeld(remote.path)) return;
    const plugin = { localPresent: localStat !== null, localHash, localChanged, remoteId, idType };
    if (await this.applyPluginFileAction(remote, base, plugin, localStat, summary)) return;

    // Previously synced but gone locally: this device deleted it. Propagate rather than re-download (which resurrects it).
    if (!localStat && base) {
      await this.applyLocalDeletion(remote, base, remoteId, idType, summary);
      return;
    }

    // Identical content is never transferred, whatever the baseline says (docs/spec.md §5.3a).
    if (localStat && (remoteChanged || localChanged)
        && localStat.size === remote.size && checksumProvesIdentical(remote, localHash)) {
      void this.opts.logger?.log(`sync: content identical to the remote (checksum) → state converged, no transfer → ${remote.path}`);
      const state = convergedState(remote, localHash, localStat, base);
      if (base?.isConflicted) {
        try { state.isConflicted = hasCompleteMarkerSet(await this.opts.localAdapter.read(remote.path)); }
        catch { state.isConflicted = true; }
      }
      this.opts.stateDB.setFile({ ...state, localMtime: localStat.mtime, localSize: localStat.size, remoteMtime: remote.lastModified });
      await this.creationTime.align(this.client!, remote, localStat);
      return;
    }

    if (!remoteChanged && !localChanged) {
      // A converged baseline records the same size on both sides. A mismatch despite matching ids means the baseline is
      // inconsistent (typical without a content checksum, idType 'etag'), so reconcile via conflict resolution instead of skipping.
      if (base && localStat && localStat.size !== base.size) {
        void this.opts.logger?.log(
          `sync: divergent baseline detected (idType=${idType}, localSize=${localStat.size}, baseSize=${base.size}) → reconciling ${remote.path}`,
        );
        await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
        return;
      }
      const remoteFileIdChanged =
        remote.fileId !== null &&
        base?.remoteFileId !== remote.fileId;

      let keepConflict = false;
      if (base?.isConflicted) {
        try {
          const localContent = await this.opts.localAdapter.read(remote.path);
          keepConflict = hasCompleteMarkerSet(localContent);
          if (keepConflict) {
            void this.opts.logger?.log(
              `sync: converged marker content remains an unresolved conflict → ${remote.path}`,
            );
          }
        } catch (err) {
          // Never hide a conflict because verification itself failed. A later reconciliation can
          // retry the read, while unrelated remote identity metadata may still be refreshed below.
          keepConflict = true;
          void this.opts.logger?.log(
            `sync: could not verify conflicted content; keeping conflict flag → ${remote.path}: ${(err as Error).message}`,
          );
        }
      }

      if (base && (base.isConflicted !== keepConflict || remoteFileIdChanged || base.checkAfterFolderMove
          || (remote.etag && base.remoteEtag !== remote.etag))) {
        this.opts.stateDB.setFile({
          ...base,
          remoteFileId: remote.fileId ?? base.remoteFileId,
          isConflicted: keepConflict,
          remoteEtag: remote.etag ?? base.remoteEtag,
          checkAfterFolderMove: undefined,
        });
      }
      await this.creationTime.align(this.client!, remote, localStat);
      return;
    }

    if (localChanged && !remoteChanged) {
      await this.uploadOrConflict(remote, base, remoteId, idType, summary);
    } else if (!localChanged && remoteChanged) {
      if (this.deferIfBeingEdited(remote.path, 'download')) return;
      await this.downloadFile(remote, remoteId, idType, summary, { stat: localStat, hash: localStat ? localHash : undefined });
    } else {
      if (this.deferIfBeingEdited(remote.path, 'conflict')) return;
      await this.handleConflict(remote.path, base, remote, remoteId, idType, summary);
    }
  }

  // If-Match 412: the remote changed between PROPFIND and PUT, so treat it as a conflict instead of overwriting (docs/spec.md §6.5).
  private async uploadOrConflict(
    remote: RemoteFileInfo, base: FileState | undefined,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    try {
      if (!remote.etag && this.client!.inspectDirectory) {
        // Listings reconstructed from State hold the checksum but may omit the ETag.
        // Obtain a live revision before overwriting an existing file.
        const current = await this.client!.statFile(remote.path);
        if (!current?.etag) throw new Error('Nextcloud did not confirm the current file revision. Local changes were kept.');
        const identity = remoteIdOf(current);
        if (identity.remoteId !== remoteId || (remote.fileId && current.fileId !== remote.fileId)) {
          await this.handleConflict(remote.path, base, current, identity.remoteId, identity.idType, summary);
          return;
        }
        remote = current;
      }
      await this.uploadFile(remote, summary);
    } catch (err) {
      if (!(err instanceof PreconditionFailedError)) throw err;
      const live = await this.client!.statFile(remote.path);
      if (!live?.etag) throw err;
      const current = withTrustedChecksum(live, base, this.features?.isNextcloud);
      const identity = remoteIdOf(current);
      await this.handleConflict(remote.path, base, current, identity.remoteId, identity.idType, summary);
    }
  }

  // Applies the bundle direction of a listed plugin to one of its code or data files. Returns true when the file was
  // handled here; false leaves it to the regular decision (docs/spec.md §7).
  private async applyPluginFileAction(
    remote: RemoteFileInfo, base: FileState | undefined,
    side: { localPresent: boolean; localHash: string; localChanged: boolean; remoteId: string; idType: FileState['idType'] },
    localStat: LocalStat | null,
    summary: SyncSessionSummary,
  ): Promise<boolean> {
    const action = this.plugins.fileAction(remote.path, {
      localPresent: side.localPresent, remotePresent: true, tracked: base !== undefined,
      sameContent: fileSameContent({
        localHash: side.localPresent ? side.localHash : null, remote, base: base ?? null, localChanged: side.localChanged,
      }),
    });
    switch (action) {
      case 'download':
        if (!this.deferIfBeingEdited(remote.path, 'download')) {
          await this.downloadFile(remote, side.remoteId, side.idType, summary,
            { stat: localStat, hash: localStat ? side.localHash : undefined });
        }
        return true;
      case 'upload':
        await this.uploadOrConflict(remote, base, side.remoteId, side.idType, summary);
        return true;
      case 'hold':
        await this.handleConflict(remote.path, base, remote, side.remoteId, side.idType, summary);
        return true;
      case 'skip':
        return true;
      default:
        return false;
    }
  }

  // True when a listed plugin file exists on one side only and the bundle direction says it must stay there.
  private pluginSkips(path: string, side: 'local-only' | 'remote-only'): boolean {
    if (!this.plugins.isPluginPath(path)) return false;
    return this.plugins.fileAction(path, {
      localPresent: side === 'local-only', remotePresent: side === 'remote-only',
      tracked: !!this.opts.stateDB.getFile(path), sameContent: false,
    }) === 'skip';
  }

  // Defers the whole decision, not just the write: a new baseline is recorded with it, and skipping only the write would
  // leave StateDB claiming a body the file does not hold. Uploads are never deferred; they leave the file alone (docs/spec.md §5.7b).
  private deferIfBeingEdited(path: string, what: 'download' | 'conflict'): boolean {
    if (!this.opts.isBeingEdited?.(path)) return false;
    void this.opts.logger?.log(`${what}: deferred — "${path}" is being edited right now`);
    this.retryQueue.push(path);
    return true;
  }

  private applyLocalDeletion(
    remote: RemoteFileInfo, base: FileState, remoteId: string, idType: FileState['idType'],
    summary: SyncSessionSummary,
  ): Promise<'deleted' | 'restored' | 'kept'> {
    return this.deletion.applyLocalDeletion(this.client!, remote, base, remoteId, idType, summary);
  }


  private uploadFile(
    remote: RemoteFileInfo, summary: SyncSessionSummary, onlyIfAbsent = false,
  ): Promise<void> {
    return this.transfer.uploadFile(
      this.client!, this.uploadStrategy!, remote, summary, onlyIfAbsent,
    );
  }



  async listVersions(path: string): Promise<FileVersion[]> {
    const { client, features } = await this.ensureClient();
    return this.versions.listVersions(client, features, path);
  }

  /** @see VersionService.compareVersions */
  async compareVersions(
    path: string, before: FileVersion, after: FileVersion,
  ): Promise<VersionComparison> {
    const { client, features } = await this.ensureClient();
    return this.versions.compareVersions(client, features, path, before, after);
  }

  /** @see VersionService.lineHistory */
  async lineHistory(
    path: string, versions: FileVersion[], targetVersion: FileVersion,
  ): Promise<LineHistoryResult> {
    const { client, features } = await this.ensureClient();
    return this.versions.lineHistory(client, features, path, versions, targetVersion);
  }

  /** @see VersionService.readVersionText */
  async readVersionText(path: string, version: FileVersion): Promise<string> {
    const { client, features } = await this.ensureClient();
    return this.versions.readVersionText(client, features, path, version);
  }

  /** @see VersionService.restoreVersion */
  async restoreVersion(path: string, version: FileVersion): Promise<void> {
    this.assertFileRenameSettled(path);
    return this.activityGate.runExclusive(async () => {
      const { client, features } = await this.ensureClient();
      await this.versions.restoreVersion(client, features, path, version);
    });
  }

  private acquireLock(path: string): Promise<string | null> {
    return this.transfer.acquireLock(this.client!, path);
  }

  private releaseLock(path: string, token: string | null): Promise<void> {
    return this.transfer.releaseLock(this.client!, path, token);
  }

  private downloadFile(
    remote: RemoteFileInfo, remoteId: string,
    idType: FileState['idType'], summary: SyncSessionSummary, expected: LocalWriteExpectation,
  ): Promise<void> {
    return this.transfer.downloadFile(this.client!, remote, remoteId, idType, summary, expected);
  }


  private handleConflict(
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.handleConflict(
      this.currentConnection(), path, base, remote, remoteId, idType, summary,
    );
  }

  private resolveByPreferLocal(
    path: string, remote: RemoteFileInfo, summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.resolveByPreferLocal(this.currentConnection(), path, remote, summary);
  }

  private resolveByPreferRemote(
    path: string, remote: RemoteFileInfo, remoteData: ArrayBuffer,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.resolveByPreferRemote(
      path, remote, remoteData, remoteId, idType, summary, this.currentConnection().client,
    );
  }

  private resolveByWrite(
    path: string, content: string, clean: boolean, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    return this.conflicts.resolveByWrite(
      this.currentConnection(), path, content, clean, remote, remoteId, idType, summary,
    );
  }


  private async processRemoteDeletion(path: string, summary: SyncSessionSummary): Promise<void> {
    if (this.deferRemotePath(path)) return;
    const outcome = await this.deletion.processRemoteDeletion(path, summary);
    // The entry kept for the retry describes a file the server no longer has. A short-circuit would rebuild the
    // listing from State, report it as still on the server, and never retry (docs/spec.md §8a.5).
    if (outcome.status === 'failed') {
      this.opts.stateDB.setRemoteRootEtag(null);
      this.recordError(summary, path, new Error(outcome.message));
    }
  }

  private async processLocalModifications(
    remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary, isFullScan = false, remoteDirs?: RemoteDirInfo[],
    isHeld: (path: string, remoteObservation?: boolean) => boolean = () => false,
  ): Promise<boolean> {
    const remotePathSet = new Set(remoteFiles.map(f => f.path));
    const remoteDirPaths = new Set(remoteDirs?.map(dir => dir.path.replace(/\/+$/, '')));
    const heldPaths = new Set<string>();
    const missingParentOf = (path: string): string | undefined => ancestorMatching(path,
      parent => !!this.opts.stateDB.getDir(parent) && !remoteDirPaths.has(parent));
    const reportLocalChanges = (path: string, base?: FileState): void => {
      // A held edit can have the same size and mtime. Re-read it when access returns.
      if (base?.localMtime != null) this.opts.stateDB.setFile({ ...base, localMtime: undefined });
      if (heldPaths.has(path)) return;
      heldPaths.add(path);
      this.recordError(summary, path, new Error('The remote path is missing or inaccessible. Unsynced local changes were kept.'));
    };

    const localStats = new Map<string, { size: number; mtime: number }>();
    await this.collectLocalStats('', localStats);
    // The config folder is not scanned recursively, so inject the enabled config-sync category files.
    for (const p of await this.configSync.enumerateIncludedPaths()) {
      const st = await this.opts.localAdapter.stat(p);
      if (st) localStats.set(p, { size: st.size, mtime: st.mtime });
    }

    // Cheap synchronous pre-filter, then bounded-parallel upload; the content-hash check stays in the worker because it needs a read.
    const uploadCandidates = [...localStats.entries()].filter(([path, st]) => {
      if (this.isRenameHeld(path) || isHeld(path) || remotePathSet.has(path) || this.pluginSkips(path, 'local-only')) return false;
      const base = this.opts.stateDB.getFile(path);
      // Skip files whose post-write stat signature is unchanged (no read, no hash); an mtime filter is always false on mobile.
      return !(base && this.isLocallyUnchanged(base, st));
    });
    await this.runFileBatch(
      uploadCandidates,
      ([path]) => path,
      ([, st]) => st.size,
      async ([path, st]) => {
        const base = this.opts.stateDB.getFile(path);
        if (base && await hashLocalFile(this.opts.localAdapter, this.opts.stateDB, path, st, base) === base.localHash) return;
        const absentParent = isFullScan && missingParentOf(path);
        if (isFullScan && (base || absentParent)) {
          reportLocalChanges(absentParent || path, base);
          return;
        }
        void this.opts.logger?.log(`upload: ${path} (${base ? 'modified, re-upload' : 'new local file'})`);
        try {
          if (this.client!.inspectDirectory) await assertTrackedParentReadable(this.client!, this.opts.stateDB, path);
          await this.uploadFile(
            { path, fileId: base?.remoteFileId ?? null, checksum: null, etag: null, size: st.size, lastModified: st.mtime, creationTime: 0 },
            summary, !base,
          );
        } catch (err) {
          // One failing file (e.g. a server-side 403) must not abort the whole session.
          console.warn(`[SyncEngine] Upload failed for ${path}:`, err);
          void this.opts.logger?.log(`upload: FAILED ${path} — ${(err as Error).message}`);
          this.recordError(summary, path, err);
          if (err instanceof NetworkError) this.retryQueue.push(path);
        }
      },
      true,
    );

    const rt = this.getOrCreateRenameTracker();
    // New (unsynced) local files, for hash-based rename detection.
    const newLocalFiles = new Map<string, { hash: string; size: number }>();
    for (const [path, st] of localStats) {
      if (!this.isRenameHeld(path) && !isHeld(path) && !this.opts.stateDB.getFile(path)) {
        const data = await this.opts.localAdapter.readBinary(path);
        const hash = await sha256(data);
        newLocalFiles.set(path, { hash, size: st.size });
      }
    }

    const missingPaths = this.opts.stateDB.getAllFiles()
      .map(f => f.path)
      .filter(p => !this.isRenameHeld(p) && !localStats.has(p) && !remotePathSet.has(p)
        && !this.isSystemExcluded(p) && !isHeld(p, true));

    const localRenames = rt.detectLocalRenamesByHash(missingPaths, newLocalFiles);

    for (const [oldPath, newPath] of localRenames) {
      try {
        await rt.applyLocalRename(oldPath, newPath);
      } catch (err) {
        console.warn(`[SyncEngine] Local rename ${oldPath} → ${newPath} failed:`, err);
        this.recordError(summary, newPath, err);
      }
    }

    // Remaining missing paths are genuine local deletions. deleteLocallyMissing asks about the path directly and routes anything
    // still present through the usual proof path: a listing that lost a file must not get it destroyed on the server (issue #46).
    // Watch mode shares it, so a scan and a single vault event decide identically.
    for (const path of missingPaths) {
      if (localRenames.has(path)) continue;
      const fileState = this.opts.stateDB.getFile(path);
      if (!fileState) continue;
      void this.opts.logger?.log(`delete-remote: locally deleted, propagating to server → ${path}`);
      try {
        await this.deletion.deleteLocallyMissing(this.client!, path, fileState, summary);
      } catch (err) {
        // An unanswerable probe or failed DELETE keeps the tracking entry so the next sync retries; dropping it would
        // re-download the file and revert the user's deletion.
        console.warn(`[SyncEngine] Failed to delete ${path} from remote:`, err);
        void this.opts.logger?.log(`delete-remote: probe FAILED, keeping tracking for retry → ${path} — ${(err as Error).message}`);
        this.recordError(summary, path, err);
      }
    }

    // Full scan only: a tracked file present locally but missing from the COMPLETE listing was deleted on the server; remove it
    // locally (recoverable via "Deleted files"). An empty listing is deliberately acted on (issue #50): it is no failure in
    // disguise (a non-207 or a root 404 throws), and refusing left files in State that the root-ETag short-circuit rebuilt as
    // "still on the server", so the vault never converged. The breaker and per-candidate 404 re-check below guard partial listings (docs/spec.md §8).
    if (isFullScan) {
      // Compare real content, not mtime, so a local edit that did not bump mtime is never lost.
      const candidates: string[] = [];
      for (const fileState of this.opts.stateDB.getAllFiles()) {
        const path = fileState.path;
        if (this.isRenameHeld(path) || remotePathSet.has(path) || this.isSystemExcluded(path) || isHeld(path, true)) continue;
        if (!localStats.has(path)) continue;
        const data = await this.opts.localAdapter.readBinary(path);
        if (await sha256(data) !== fileState.localHash || fileState.isConflicted) {
          reportLocalChanges(missingParentOf(path) ?? path, fileState);
          continue;
        }
        candidates.push(path);
      }

      // Circuit breaker: too many apparent remote deletions means a partial or failed listing, so refuse.
      const tracked = this.opts.stateDB.getAllFiles().length;
      const limit = this.effectiveMassDeleteLimit(tracked + this.opts.stateDB.getAllDirs().length);
      const count = candidates.length + (remoteDirs ? this.directories.countMissingLocalCopies(remoteDirPaths, isHeld) : 0);
      if (count > limit) {
        void this.opts.logger?.log(`delete-local: SKIPPED ${count} absence-deletions — exceeds safety limit (${limit}); likely a partial remote listing`);
        new Notice(`⚠️ ${count} files and folders look deleted on the server — skipped to avoid mass deletion. Re-sync to retry.`, 10000);
        // An unresolved state: record it as an error so the UI surfaces it and the root-ETag short-circuit is invalidated;
        // otherwise "re-sync to retry" would never re-evaluate the deletions (docs/spec.md §8a.5).
        this.recordError(summary, '(mass-delete breaker)', new Error(`Skipped ${count} absence-deletions — exceeds safety limit ${limit}`), {
          all: candidates,
        });
        return false;
      }

      // Re-verify each candidate with a targeted PROPFIND so a false negative in the bulk listing never deletes locally.
      for (const path of candidates) {
        if (this.cancelled) break;
        let goneOnServer = false;
        try { goneOnServer = !(await this.client!.remoteExists(path)); } catch { goneOnServer = false; }
        if (!goneOnServer) {
          void this.opts.logger?.log(`delete-local: re-check found it still on server — keeping → ${path}`);
          continue;
        }
        void this.opts.logger?.log(`delete-local: remote deletion confirmed (absence + 404 re-check) → ${path}`);
        await this.processRemoteDeletion(path, summary);
      }
    }
    return true;
  }

  // Runs only on a COMPLETE listing. Directories are first-class entities, never deleted merely for being empty
  // (docs/spec.md §8a.1, docs/plan.md §16).
  private reconcileDirectories(
    summary: SyncSessionSummary, cachedDirs?: RemoteDirInfo[], skipLocalRemovals = false,
    isHeld: (path: string, remoteObservation?: boolean) => boolean =
      (path, remoteObservation) => remoteObservation ? this.deferRemotePath(path) : this.isCreationDeferred(path),
  ): Promise<void> {
    return this.directories.reconcileDirectories(this.client!, summary, cachedDirs, skipLocalRemovals, isHeld);
  }

  private async buildInitialPlan(
    localFiles: Map<string, { size: number; mtime: number }>,
    remoteFiles: RemoteFileInfo[],
  ): Promise<InitialSyncPlan> {
    const uploads: string[] = [];
    const downloads: string[] = [];
    const conflicts: string[] = [];
    const unchanged: string[] = [];
    const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));

    for (const [path, lf] of localFiles) {
      const remote = remoteMap.get(path);
      if (!remote) { if (!this.pluginSkips(path, 'local-only')) uploads.push(path); continue; }
      if (remote.size !== lf.size) { conflicts.push(path); continue; }
      // Hash only to prove "unchanged", and only when the server supplied a checksum; otherwise (or above the size gate)
      // fall back to conflict resolution without reading the file.
      if (!remote.checksum || lf.size > MAX_HASH_SIZE) { conflicts.push(path); continue; }
      const localHash = await sha256(await this.opts.localAdapter.readBinary(path));
      if (localHash === remote.checksum) unchanged.push(path);
      else conflicts.push(path);
    }
    for (const remote of remoteFiles) {
      if (this.isSystemExcluded(remote.path)) continue;
      if (!localFiles.has(remote.path) && !this.pluginSkips(remote.path, 'remote-only')) downloads.push(remote.path);
    }
    return { uploads, downloads, conflicts, unchanged, deletes: [] };
  }

  private async executePlan(
    plan: InitialSyncPlan, remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary,
    localFiles: Map<string, { size: number; mtime: number }>,
  ): Promise<void> {
    // The caller already scanned the vault, so reuse the stat map; hashing is deferred to upload time.
    const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));
    const actionFiles = plan.uploads.length + plan.downloads.length + plan.conflicts.length;
    this.syncProgress = { processed: 0, total: actionFiles };
    if (actionFiles > 0) this.opts.statusBar.setProgress(0, actionFiles);

    await this.runFileBatch(
      plan.uploads,
      (path) => path,
      (path) => localFiles.get(path)?.size ?? 0,
      async (path) => {
        try {
          const lf = localFiles.get(path);
          if (!lf || this.isPathHeld(path)) return;
          await this.uploadFile({
            path, fileId: null, checksum: null, etag: null, size: lf.size, lastModified: 0,
            creationTime: remoteMap.get(path)?.creationTime ?? 0,
          }, summary, true);
        } catch (err) { this.recordError(summary, path, err); this.retryQueue.push(path); }
        this.tickProgress();
      },
      true,
    );

    // A plugin's manifest.json is written after every other code file of its bundle (docs/spec.md §7): downloads' rest,
    // then conflicts' rest, then the manifests.
    const dl = partitionPluginManifestsLast(plan.downloads, (path) => path, this.opts.configDir);
    const cf = partitionPluginManifestsLast(plan.conflicts, (path) => path, this.opts.configDir);
    await this.downloadPlanned(dl.rest, remoteMap, summary);

    // Identical on both sides: seed State with no transfer and no local write (the local mtime is left unchanged).
    for (const path of plan.unchanged) {
      const lf = localFiles.get(path);
      const remote = remoteMap.get(path);
      if (!lf || !remote) continue;
      const mtime = remote.lastModified || lf.mtime;
      // Classified unchanged only after localHash === remote.checksum, so the checksum is the content hash for both sides.
      this.opts.stateDB.setFile({
        path, localHash: remote.checksum!, remoteId: remote.checksum!, idType: 'sha256',
        size: lf.size, mtime, remoteFileId: remote.fileId, isConflicted: false,
        remoteEtag: remote.etag ?? undefined, localMtime: lf.mtime, localSize: lf.size, remoteMtime: remote.lastModified,
      });
      await this.creationTime.align(this.client!, remote);
    }

    await this.resolvePlannedConflicts(cf.rest, remoteMap, summary);
    await this.downloadPlanned(dl.manifests, remoteMap, summary);
    await this.resolvePlannedConflicts(cf.manifests, remoteMap, summary);
  }

  private async downloadPlanned(
    paths: string[], remoteMap: Map<string, RemoteFileInfo>, summary: SyncSessionSummary,
  ): Promise<void> {
    // No directory serialization: each worker writes a distinct local file.
    await this.runFileBatch(
      paths,
      (path) => path,
      (path) => remoteMap.get(path)?.size ?? 0,
      async (path) => {
        try {
          const remote = remoteMap.get(path)!;
          const { remoteId, idType } = remoteIdOf(remote);
          await this.downloadFile(remote, remoteId, idType, summary, { stat: null });
        } catch (err) { this.recordError(summary, path, err); this.retryQueue.push(path); }
        this.tickProgress();
      },
      false,
    );
  }

  private async resolvePlannedConflicts(
    paths: string[], remoteMap: Map<string, RemoteFileInfo>, summary: SyncSessionSummary,
  ): Promise<void> {
    for (const path of paths) {
      try {
        const remote = remoteMap.get(path)!;
        const { remoteId, idType } = remoteIdOf(remote);
        await this.handleConflict(path, undefined, remote, remoteId, idType, summary);
      } catch (err) { this.recordError(summary, path, err); this.retryQueue.push(path); }
      this.tickProgress();
    }
  }

  private tickProgress(): void {
    this.syncProgress.processed = Math.min(this.syncProgress.processed + 1, this.syncProgress.total);
    if (this.syncProgress.total > 0) {
      this.opts.statusBar.setProgress(this.syncProgress.processed, this.syncProgress.total);
    }
  }


  private scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>> {
    return this.localScanner.scanLocalFiles();
  }

  private collectLocalStats(_dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void> {
    return this.localScanner.collectLocalStats(out);
  }

  private obtainFullScanListing(client: IWebDAVClient): Promise<FullScanListing> {
    return this.remoteListing.obtainFullScanListing(client);
  }

  private rebuildRemoteFilesFromState(): RemoteFileInfo[] {
    return this.remoteListing.rebuildRemoteFilesFromState(true);
  }

  private rebuildRemoteDirsFromState(): RemoteDirInfo[] {
    return this.remoteListing.rebuildRemoteDirsFromState();
  }

  // Rules and the remote-deletion scope guard live in ./policy so they can be tested without an engine. Community
  // plugin files are decided by the ConfigSyncResolver.isIncluded gate: only the files of a plugin listed for this
  // session pass, every other path under plugins/ is excluded.
  private isSystemExcluded(path: string): boolean {
    return isSystemExcludedPure(path, {
      excludedFolders: this.opts.settings?.excludedFolders ?? [],
      isUnderConfigDir: (p) => this.configSync.isUnderConfigDir(p),
      isConfigPathIncluded: (p) => this.configSync.isIncluded(p),
      isActiveLogFile: this.opts.isActiveLogFile,
    });
  }
}

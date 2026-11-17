import { isUnderPluginsDir } from './sync/plugins/pluginPaths';
import { App, Plugin, Notice, Platform, TFile, TFolder, TAbstractFile, debounce } from 'obsidian';
import { DavSyncSettings, DEFAULT_SETTINGS, FeatureUnsupportedError } from './types';
import { NextcloudSyncSettingTab } from './settings/SettingTab';
import { SyncEngine } from './sync/SyncEngine';
import { VersionHistoryModal } from './ui/VersionHistoryModal';
import { VersionCompareModal } from './ui/VersionCompareModal';
import { LineHistoryModal } from './ui/LineHistoryModal';
import { VersionBrowserModal } from './ui/VersionBrowserModal';
import { SyncStatusModal } from './ui/SyncStatusModal';
import { StatusFilterState, makeDefaultFilterState, serializeFilter, deserializeFilter } from './ui/statusFilter';
import { CompareModal } from './ui/CompareModal';
import { applyForceResolution, applyBulkForceResolution, FORCE_CHOICES, ForceChoice } from './ui/forceResolution';
import { confirmModal } from './ui/ConfirmModal';
import { openMirrorFromRemoteModal } from './ui/MirrorFromRemoteModal';
import { registerSyncRibbon } from './ui/syncRibbon';
import { registerMirrorRibbon, registerStatusCommands } from './ui/statusEntryPoints';
import {
  registerVersionHistoryEntryPoints,
  VERSION_HISTORY_ICON,
  VERSION_HISTORY_LABEL,
} from './ui/versionHistoryEntryPoints';
import { FileLogger } from './util/FileLogger';
import { onAppResume, makeResumeSyncHandler } from './util/appResume';
import { isSyncTmpPath, LocalAdapter } from './data/LocalAdapter';
import { probeCreationTimeSupport } from './data/creationTimeProbe';
import type { MergeBaseStore } from './data/MergeBaseStore';
import { v4 as uuidv4 } from './util/uuid';
import { hostToken, LogPlatform } from './util/hostToken';
import { migrateConfigSyncCategories, migrateBookmarksToConfigSync, migrateStartupToggleToDelay, migrateConflictSettingsToStrategies, migrateFrontmatterScalarPolicyToStrategy, migrateMarkdownAutoMergeType, pruneObsoleteSettings, resetDebugIdentityFields, applyMobileFirstRunDefaults, normalizeSyncedCommunityPlugins, migrateAndroidWatchOptIn, isWatchModeActive } from './util/settingsMigration';
import { CommunityPluginPickerModal } from './ui/CommunityPluginPickerModal';
import { applyPluginSelection, type PluginSelectionConfirmStep } from './ui/pluginSelection';
import { collectCommunityPluginCandidates, type PluginCandidateList } from './sync/plugins/candidates';
import { debugLogPath, isActiveOwnLog } from './util/logPaths';
import { autoNetworkConcurrency } from './util/platformDefaults';
import { NextcloudPushClient } from './network/push/NextcloudPushClient';
import { PushSyncScheduler } from './sync/push/PushSyncScheduler';
import { ClientPushStatusItem } from './ui/ClientPushStatusItem';
import { MobileWatchLifecycle } from './sync/watch/MobileWatchLifecycle';

const MIN_OBSIDIAN_VERSION = '1.13.0';

// How long after a keystroke a file counts as "being edited". Shared by the upload debounce and the
// write-deferral guard and must stay one number: a shorter guard would reopen the window the guard
// exists to close (docs/spec.md §5.7b).
const EDIT_WINDOW_MS = 2000;

export default class ObsidianNextcloudsync extends Plugin {
  settings!: DavSyncSettings;
  syncEngine?: SyncEngine;

  // Guards against double-invocation of the Pull-mirror.
  private mirrorInProgress = false;
  // Shared with SyncEngine; its ignore list marks the plugin's own writes for the watchers.
  localAdapter?: LocalAdapter;
  // Desktop status-bar element (undefined on mobile). Tracked so `initSyncEngine` can remove it on
  // re-init instead of leaking a duplicate item on every re-login.
  private statusBarEl?: HTMLElement;
  // In-flight `initSyncEngine`: concurrent callers (onLayoutReady and an early `runSyncNow`) await
  // it instead of each initializing. Cleared on settle so a later call (re-login) starts fresh.
  private initializingEngine?: Promise<void>;
  // Flushed on unload so a debounced base write is not lost.
  baseStore?: MergeBaseStore;
  // Flushed on unload so a debounced write is not lost.
  cleanSideStore?: import('./data/CleanSideStore').CleanSideStore;
  logger!: FileLogger;
  /** Android-only lifecycle state for opt-in foreground Watch mode. */
  private mobileWatch?: MobileWatchLifecycle;
  /** Compact Android sync-status item in the active view action strip. */
  private mobileSyncStatusItem?: import('./ui/MobileSyncStatusItem').MobileSyncStatusItem;
  /**
   * Status filter for the Sync Status dialog. Held here (not on the modal, which is recreated per
   * open) so the selection persists across reopens. Hydrated from settings on load and saved on every
   * change, so it now survives an Obsidian restart too.
   */
  private readonly statusFilterState: StatusFilterState = makeDefaultFilterState();
  // Last user edit time per path, to keep sync from writing under the cursor. Not the debounce's
  // pending set: that is cleared when the debounce fires, exactly when the triggered sync begins.
  private readonly lastLocalEdit = new Map<string, number>();
  // Plugin ids whose code was written and that still need an Obsidian restart. Held here, not in the engine,
  // so it survives the engine being rebuilt.
  private readonly pluginsAwaitingRestart = new Set<string>();
  /** Nextcloud Client Push transport (notify_push), when the server advertises it. */
  private pushClient?: NextcloudPushClient;
  /** Coalesces best-effort push hints into ordinary reconciliations. */
  private pushSyncScheduler?: PushSyncScheduler;
  /** Desktop-only fixed-width Client Push indicator. Mobile stays quiet by design. */
  private pushStatusItem?: ClientPushStatusItem;

  async onload(): Promise<void> {
    const currentVersion = (this.app as App & { appVersion?: string }).appVersion ?? '';
    if (currentVersion && this.compareVersions(currentVersion, MIN_OBSIDIAN_VERSION) < 0) {
      new Notice(
        `Nextcloud Sync requires Obsidian ${MIN_OBSIDIAN_VERSION} or later. Current: ${currentVersion}`,
        0,
      );
      return;
    }

    await this.loadSettings();

    this.statusFilterState.checked = deserializeFilter(this.settings.statusFilter).checked;

    if (!this.settings.deviceId) {
      this.settings.deviceId = uuidv4();
      await this.saveSettings();
    }

    // The file is named with this device's host token so multiple devices never collide. A failed
    // write surfaces as a Notice (never a thrown error) so "logging on yet no file" is not silent.
    this.logger = new FileLogger(
      this.app.vault.adapter,
      () => this.settings.loggingEnabled,
      () => 'verbose' as const,
      this.manifest.version,
      this.hostToken(),
      () => debugLogPath(this.settings.logsFolder, this.hostToken()),
      (err) => new Notice(`Nextcloud Sync: could not write the log file — ${(err as Error)?.message ?? String(err)}`, 8000),
    );
    void this.logger.log(`plugin loaded (obsidian=${currentVersion})`);
    void this.logSettingsSnapshot();

    this.addSettingTab(new NextcloudSyncSettingTab(this.app, this));

    // Keep the one compact Android status control attached to the currently active leaf.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      this.mobileSyncStatusItem?.refreshHost();
    }));
    this.registerDomEvent(window, 'offline', () => this.mobileSyncStatusItem?.setNetworkAvailable(false));
    this.registerDomEvent(window, 'online', () => this.mobileSyncStatusItem?.setNetworkAvailable(true));

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: async () => {
        await this.runSyncNow();
      },
    });

    this.addCommand({
      id: 'show-client-push-status',
      name: 'Show client push status',
      callback: () => {
        new Notice(this.clientPushStatusText(), 10_000);
      },
    });

    // Client Push sockets can be suspended while a mobile WebView is in the background. Reconnect
    // immediately when Obsidian becomes visible again or the browser reports network recovery.
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.hidden) return;
      // Mobile WebViews may miss online/offline events while suspended. Refresh the network hint on
      // foreground and then force an immediate reconnect attempt when connectivity is available.
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      const hadPushSession = (this.pushClient?.getStatus().lastConnectedAt ?? null) !== null;
      this.pushClient?.setNetworkOnline(online);
      if (online) {
        // The socket can remain logically OPEN while the WebView was actually suspended, so catch-up
        // must not depend on seeing a reconnect transition. Only do this after at least one real push
        // session; initial connection/startup semantics stay owned by the existing startup sync.
        if (hadPushSession) this.pushSyncScheduler?.requestRemoteCatchUp('app became visible');
        void this.pushClient?.ensureConnected(true);
      }
    });
    this.registerDomEvent(window, 'offline', () => {
      this.pushClient?.setNetworkOnline(false);
    });
    this.registerDomEvent(window, 'online', () => {
      const hadPushSession = (this.pushClient?.getStatus().lastConnectedAt ?? null) !== null;
      this.pushClient?.setNetworkOnline(true);
      if (hadPushSession) this.pushSyncScheduler?.requestRemoteCatchUp('network returned');
    });

    // Ribbon entry point for the same manual sync (upstream change / issue #19). One click on desktop,
    // two taps on mobile: the ribbon BAR is hidden there, but Obsidian republishes ribbon actions in
    // the navigation bar's "Open menu". Shares runSyncNow with the command above — no new setting,
    // no platform branch.
    registerSyncRibbon(this);

    // Both manual actions are two taps on mobile (no status bar to click); the commands cover the
    // Sync Status dialog and allow a toolbar pin or hotkey. See src/ui/statusEntryPoints.ts.
    registerMirrorRibbon(this);
    registerStatusCommands(this);

    // Version history is a first-class file tool: one click in the desktop ribbon, two taps via
    // mobile Open menu, or one tap when the command is pinned to Obsidian's mobile toolbar.
    registerVersionHistoryEntryPoints(this);

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      // Also on mobile (long-press menu): the diff is a pure Modal + LCS with no Electron deps.
      if (!(file instanceof TFile)) return;
      if (!this.syncEngine) return;
      menu.addItem(item => item
        .setTitle(VERSION_HISTORY_LABEL)
        .setIcon(VERSION_HISTORY_ICON)
        .onClick(() => { void this.showVersionHistory(file); }));
      menu.addItem(item => item
        .setTitle('Compare with remote')
        .setIcon('git-compare')
        .onClick(() => { new CompareModal(this.app, file.path, this.syncEngine!).open(); }));
    }));

    // Command-palette entry: the reliable entry point on mobile.
    this.addCommand({
      id: 'compare-with-remote',
      name: 'Compare with remote',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const ok = file instanceof TFile && !!this.syncEngine;
        if (ok && !checking) new CompareModal(this.app, file.path, this.syncEngine!).open();
        return ok;
      },
    });

    // Vault listeners must not be registered in `onload`: `create` fires once per file while the vault
    // initializes and would flood the watcher. onLayoutReady runs after that initial pass.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.serverUrl && this.settings.username) {
        void this.initSyncEngine();
      }

      // Watch mode: Desktop keeps the established upstream path. Android may opt into the SAME
      // lightweight operations while Obsidian is in the foreground; iOS remains disabled.
      const watchOn = (): boolean =>
        isWatchModeActive(
          this.settings.watchOnChangeEnabled,
          Platform.isMobile,
          Platform.isIosApp,
        );

      // Keep upstream's own-write filtering unchanged here. The separate
      // fixes/watch-own-debug-log branch extends this for the active debug log.
      const isOwnSyncEvent = (path: string): boolean =>
        isSyncTmpPath(path)
        || isActiveOwnLog(path, {
          logsFolder: this.settings.logsFolder,
          host: this.hostToken(),
          loggingEnabled: this.settings.loggingEnabled,
        })
        || (this.localAdapter?.shouldIgnore(path) ?? false);

      // Filter before the Android lifecycle can turn an irrelevant structural event into recovery.
      const isPluginEvent = (path: string): boolean => isUnderPluginsDir(path, this.app.vault.configDir);
      const pendingUploads = new Set<string>();
      const mobileWatch = Platform.isMobile && !Platform.isIosApp
        ? new MobileWatchLifecycle({
            isEnabled: watchOn,
            isVisible: () => !document.hidden,
            canUseNetwork: () => this.syncEngine?.canRunWatchSync() ?? false,
            syncFile: async (path) => {
              const engine = this.syncEngine;
              if (!engine) return false;
              try {
                return await engine.syncSingleFileForMobileWatch(path);
              } finally {
                this.refreshMobileConflictStatus();
              }
            },
            recoverStructural: async (requireFreshAfterCurrent) => {
              const engine = this.syncEngine;
              return engine ? engine.syncForWatchRecovery(requireFreshAfterCurrent) : false;
            },
            log: (message) => { void this.logger.log(message); },
          })
        : null;
      this.mobileWatch = mobileWatch ?? undefined;

      const queuePendingUpload = (path: string): void => {
        if (mobileWatch) mobileWatch.queueFile(path);
        else pendingUploads.add(path);
      };
      const takePendingUpload = (path: string): boolean =>
        mobileWatch ? mobileWatch.takePendingFile(path) : pendingUploads.delete(path);

      const flushPendingUploads = (): void => {
        if (mobileWatch) {
          void mobileWatch.flushFiles();
          return;
        }
        const paths = [...pendingUploads];
        pendingUploads.clear();
        for (const path of paths) void this.syncEngine?.syncSingleFile(path);
      };

      const debouncedUpload = debounce(flushPendingUploads, EDIT_WINDOW_MS, true);
      const queueDebouncedFile = (path: string): void => {
        queuePendingUpload(path);
        if (!mobileWatch || !document.hidden) debouncedUpload();
      };

      const guard = (file: TAbstractFile): file is TFile =>
        watchOn() && file instanceof TFile;

      const runStructural = (
        description: string,
        desktopWork: (engine: SyncEngine) => Promise<void>,
        mobileWork: (engine: SyncEngine) => Promise<boolean>,
      ): void => {
        if (mobileWatch) {
          const engineAtEvent = this.syncEngine;
          if (engineAtEvent?.isSyncRunning()) {
            mobileWatch.markStructuralDirty(`${description} arrived during full sync`, true);
            mobileWatch.onVisible();
            return;
          }
          void mobileWatch.runStructural(async () => {
            const engine = this.syncEngine;
            if (!engine) {
              mobileWatch.markStructuralDirty(`${description} arrived before sync engine was ready`);
              return false;
            }
            return mobileWork(engine);
          }, description).then((ran) => {
            if (!ran) mobileWatch.onVisible();
          });
          return;
        }
        const engine = this.syncEngine;
        if (engine) void desktopWork(engine);
      };

      this.registerEvent(this.app.vault.on('modify', (file: TAbstractFile) => {
        if (!guard(file) || isPluginEvent(file.path) || isOwnSyncEvent(file.path)) return;
        this.lastLocalEdit.set(file.path, Date.now());
        queueDebouncedFile(file.path);
      }));

      this.registerEvent(this.app.vault.on('create', (file: TAbstractFile) => {
        if (!watchOn() || isPluginEvent(file.path) || isOwnSyncEvent(file.path)) return;
        if (file instanceof TFolder) {
          runStructural(
            `create folder ${file.path}`,
            (engine) => engine.createSingleFolder(file.path),
            (engine) => engine.createSingleFolderForMobileWatch(file.path),
          );
          return;
        }
        if (file instanceof TFile) queueDebouncedFile(file.path);
      }));

      this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
        if (!watchOn() || isPluginEvent(file.path)) return;
        takePendingUpload(file.path);
        if (isOwnSyncEvent(file.path)) return;
        if (file instanceof TFolder) {
          runStructural(
            `delete folder ${file.path}`,
            (engine) => engine.deleteSingleFolder(file.path),
            (engine) => engine.deleteSingleFolderForMobileWatch(file.path),
          );
          return;
        }
        runStructural(
          `delete file ${file.path}`,
          (engine) => engine.deleteSingleFile(file.path),
          (engine) => engine.deleteSingleFileForMobileWatch(file.path),
        );
      }));

      this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (!watchOn() || isPluginEvent(oldPath) || isPluginEvent(file.path)) return;
        const hadPendingUpload = takePendingUpload(oldPath);
        if (isOwnSyncEvent(oldPath) || isOwnSyncEvent(file.path)) return;

        if (file instanceof TFolder) {
          runStructural(
            `rename folder ${oldPath} → ${file.path}`,
            (engine) => engine.renameSingleFolder(oldPath, file.path),
            (engine) => engine.renameSingleFolderForMobileWatch(oldPath, file.path),
          );
          return;
        }
        if (!(file instanceof TFile)) return;

        const newPath = file.path;
        const lastEditAt = this.lastLocalEdit.get(oldPath);
        if (lastEditAt !== undefined) {
          this.lastLocalEdit.delete(oldPath);
          this.lastLocalEdit.set(newPath, lastEditAt);
        }

        const engine = this.syncEngine;
        if (!engine) {
          if (mobileWatch) {
            mobileWatch.markStructuralDirty(`rename file ${oldPath} → ${newPath} arrived before sync engine was ready`);
            if (hadPendingUpload) mobileWatch.queueFile(newPath);
          }
          return;
        }

        if (mobileWatch) {
          if (engine.isSyncRunning()) {
            mobileWatch.markStructuralDirty(`rename file ${oldPath} → ${newPath} arrived during full sync`, true);
            if (hadPendingUpload) mobileWatch.queueFile(newPath);
            mobileWatch.onVisible(); // await the current full run, then reconcile the final structure
            return;
          }

          // Hidden/Wi-Fi-blocked renames become structural-dirty instead of replaying a blind MOVE.
          void mobileWatch.runStructural(
            () => engine.renameSingleFileForMobileWatch(oldPath, newPath),
            `rename file ${oldPath} → ${newPath}`,
          ).then((ran) => {
              if (hadPendingUpload) mobileWatch.queueFile(newPath);
              if (!ran) {
                mobileWatch.onVisible();
                return;
              }
              void mobileWatch.flushFiles();
            });
          return;
        }

        // Desktop: preserve the established immediate-rename fix exactly.
        const renamePromise = engine.renameSingleFile(oldPath, newPath);
        if (hadPendingUpload) {
          void renamePromise.then(
            () => { void engine.syncSingleFile(newPath); },
            () => undefined,
          );
        }
      }));

      if (mobileWatch) {
        this.registerDomEvent(document, 'visibilitychange', () => {
          if (document.hidden) {
            mobileWatch.onHidden();
            return;
          }
          queueMicrotask(() => mobileWatch.onVisible());
        });
        this.registerDomEvent(window, 'online', () => mobileWatch.onNetworkChanged());
        this.registerDomEvent(window, 'offline', () => mobileWatch.onNetworkChanged());
        const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
        if (connection) {
          const onConnectionChange = (): void => mobileWatch.onNetworkChanged();
          connection.addEventListener('change', onConnectionChange);
          this.register(() => connection.removeEventListener('change', onConnectionChange));
        }
      }

      // Sync on foreground resume, on every platform (docs/spec.md §5.8). The cooldown inside the
      // handler keeps a burst of app switches from becoming a burst of syncs.
      this.register(onAppResume(makeResumeSyncHandler({
        getEngine: () => this.syncEngine,
        getLastSyncTime: () => this.syncEngine?.getLastSyncTime() ?? 0,
        log: (message) => { void this.logger.log(message); },
        // Startup sync off means no automatic sync at all (issue #49); read at call time.
        startupSyncEnabled: () => this.settings.startupSyncDelaySeconds > 0,
      })));
    });
  }

  /** Re-evaluate Android Watch after a live Watch/Wi-Fi-only setting change. */
  reevaluateMobileWatchPolicy(): void {
    this.mobileWatch?.onNetworkChanged();
  }

  /**
   * Run "Sync Now". On the very first sync (no recorded state), the engine performs a full scan and
   * applies the initial plan directly. Shared by the command and the settings button.
   */
  async runSyncNow(): Promise<void> {
    void this.logger.log('sync: "Sync now" clicked');
    // Credentials may have been entered after startup (first-time setup).
    if (!this.syncEngine && this.settings.serverUrl && this.settings.username) {
      await this.initSyncEngine();
    }
    if (!this.syncEngine) {
      void this.logger.log('sync: aborted — server settings incomplete');
      new Notice('Configure the server settings first.');
      return;
    }
    await this.syncEngine.syncManual({ manual: true });
  }

  // Desktop-only: on mobile the OS suspends background timers, so the timer is always stopped there.
  applyAutoSyncInterval(): void {
    if (!this.syncEngine) return;
    if (!Platform.isMobile && this.settings.syncIntervalMinutes > 0) {
      this.syncEngine.startAutoSync(this.settings.syncIntervalMinutes);
    } else {
      this.syncEngine.stopAutoSync();
    }
  }

  // The editor may be ahead of what is on disk, so a remote->local write would land under the cursor.
  // Prunes as it reads, so the map stays the size of what is actually being edited.
  isBeingEdited(path: string): boolean {
    const at = this.lastLocalEdit.get(path);
    if (at === undefined) return false;
    if (Date.now() - at < EDIT_WINDOW_MS) return true;
    this.lastLocalEdit.delete(path);
    return false;
  }

  openSyncStatus(): void {
    if (!this.syncEngine) {
      new Notice('Configure the server settings first.');
      return;
    }
    new SyncStatusModal(
      this.app,
      () => this.syncEngine!.getStatusReport(),
      () => this.runSyncNow(),
      this.statusFilterState,
      () => {
        this.settings.statusFilter = serializeFilter(this.statusFilterState);
        void this.saveSettings();
      },
      // Force-resolve one conflicted file. Failures surface as a Notice and leave it conflicted; a tie
      // (equal mtime/size) is a silent no-op.
      async (path: string, choice: ForceChoice) => {
        try {
          await applyForceResolution(this.syncEngine!, path, choice);
        } catch (err) {
          new Notice(`Could not resolve "${path}": ${(err as Error).message}`);
        } finally {
          this.refreshMobileConflictStatus();
        }
      },
      // Bulk force-resolve. The host owns the confirmation and the aggregate Notice;
      // applyBulkForceResolution never rejects (per-file failures are tallied).
      async (choice: ForceChoice, paths: string[]) => {
        const n = paths.length;
        const label = FORCE_CHOICES.find(c => c.id === choice)?.label ?? choice;
        const ok = await confirmModal(this.app, {
          title: 'Resolve all conflicts',
          message: `Force-resolve all ${n} conflicts using "${label}"? This overwrites files and cannot be undone.`,
          cta: 'Apply to all',
          cancel: 'Cancel',
          destructive: true,
        });
        if (!ok) return;
        const { resolved, noop, failed } = await applyBulkForceResolution(this.syncEngine!, paths, choice);
        this.refreshMobileConflictStatus();
        new Notice(`Resolved ${resolved} of ${n} conflicts`
          + (noop ? `; ${noop} unchanged` : '') + (failed ? `; ${failed} failed` : ''));
      },
      // Bulk-resolve the paths the dir mass-delete breaker skipped; resolveAllSkippedDirs never
      // rejects (per-path failures are tallied and left for the next attempt).
      async (choice: 'remote' | 'local') => {
        const label = choice === 'remote' ? 'Use remote' : 'Use local';
        const ok = await confirmModal(this.app, {
          title: 'Resolve skipped directories',
          message: `Apply "${label}" to every directory the mass-delete breaker skipped? `
            + 'This creates/deletes directories and cannot be undone.',
          cta: 'Apply to all',
          cancel: 'Cancel',
          destructive: true,
        });
        if (!ok) return;
        const { resolved, failed } = await this.syncEngine!.resolveAllSkippedDirs(choice);
        new Notice(`Resolved ${resolved} skipped directories` + (failed ? `; ${failed} failed` : ''));
      },
      // Second entry point to Mirror from remote; runRemoteMirror owns the confirmation, Notice and guard.
      () => this.runRemoteMirror(),
    ).open();
  }

  // Works without a configured engine: then the on-disk state file is reset directly. With an engine,
  // any in-flight sync is aborted first. No vault or remote files are deleted.
  async resetVaultIndex(): Promise<void> {
    const confirmed = await confirmModal(this.app, {
      title: 'Reset vault index',
      message:
        "Clear this device's sync tracking index and return to the first-install state. " +
        'No vault or remote files are deleted. The next sync will perform a full re-scan.',
      cta: 'Reset',
      cancel: 'Cancel',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      if (this.syncEngine) {
        await this.syncEngine.resetIndex();
      } else {
        // Unconfigured: no engine/StateDB instance exists, but a stale state file may remain on disk.
        const { StateDB } = await import('./data/StateDB');
        const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        await StateDB.resetFile(this.app.vault.adapter, pluginDir, this.settings.deviceId);
      }
      new Notice('Vault index reset. The next sync will perform a full re-scan.');
    } catch (err) {
      new Notice(`❌ Failed to reset the Vault index: ${(err as Error).message}`, 6000);
    }
  }

  // Overwrites the local vault to match the remote, deleting extras via the Obsidian trash setting.
  // Bypasses the mass-delete breaker but aborts if the remote listing cannot be obtained.
  async runRemoteMirror(): Promise<void> {
    const engine = this.syncEngine;
    if (!engine) {
      new Notice('Sign in to Nextcloud before mirroring from the remote.', 6000);
      return;
    }
    if (this.mirrorInProgress) return;
    this.mirrorInProgress = true;
    try {
      // The dialog opens immediately and plans/confirms/applies inside it, so the network-heavy planning
      // shows live phase labels. Resolves at the terminal state, or when an in-flight apply finishes
      // if dismissed mid-apply.
      await openMirrorFromRemoteModal(this.app, {
        plan: async (onPhase) => {
          onPhase('Stopping the current sync…');
          await engine.abortAndWait();
          return engine.planRemoteMirror(onPhase);
        },
        apply: (plan, onProgress) => engine.applyRemoteMirror(plan, onProgress),
      });
    } catch (err) {
      new Notice(`❌ Mirror from remote failed: ${(err as Error).message}`, 8000);
    } finally {
      this.mirrorInProgress = false;
    }
  }

  /** Fetch the server-side version history of the active note and show the modal (US2). */
  /**
   * Shared active-file entry point for ribbon/command/mobile toolbar. Unlike a checkCallback this
   * stays visible and explains why it cannot open, instead of silently disappearing.
   */
  openVersionHistoryForActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice('No active file for version history.', 4000);
      return;
    }
    if (!this.syncEngine) {
      new Notice('Configure the server settings first.', 5000);
      return;
    }
    void this.showVersionHistory(file);
  }

  private async showVersionHistory(file: TFile): Promise<void> {
    const engine = this.syncEngine;
    if (!engine) return;
    try {
      const versions = await engine.listVersions(file.path);
      let historyModal: VersionHistoryModal;
      historyModal = new VersionHistoryModal(
        this.app,
        file.path,
        versions,
        this.settings.username,
        (before, after, restoreTarget) => new VersionCompareModal(
          this.app,
          file.path,
          before,
          after,
          this.settings.username,
          restoreTarget,
          () => engine.compareVersions(file.path, before, after),
          restoreTarget
            ? async () => {
                await engine.restoreVersion(file.path, restoreTarget);
                historyModal.close();
              }
            : undefined,
        ).open(),
        (version) => new LineHistoryModal(
          this.app,
          file.path,
          this.settings.username,
          version,
          () => engine.lineHistory(file.path, versions, version),
          !version.isCurrent
            ? async () => {
                await engine.restoreVersion(file.path, version);
                historyModal.close();
              }
            : undefined,
        ).open(),
        () => new VersionBrowserModal(
          this.app,
          file.path,
          versions,
          this.settings.username,
          (version) => engine.readVersionText(file.path, version),
          async (version) => {
            await engine.restoreVersion(file.path, version);
            historyModal.close();
          },
        ).open(),
        (version) => engine.restoreVersion(file.path, version),
      );
      historyModal.open();
    } catch (err) {
      if (err instanceof FeatureUnsupportedError) {
        new Notice('No server version history is available for this file.', 6000);
      } else {
        new Notice(`❌ Failed to load version history: ${(err as Error).message}`, 6000);
      }
    }
  }

  private logPlatform(): LogPlatform {
    return Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : 'desktop';
  }

  private hostToken(): string {
    return hostToken(this.settings.deviceName, this.logPlatform(), this.settings.deviceId);
  }

  logFilePath(): string {
    return debugLogPath(this.settings.logsFolder, this.hostToken());
  }

  // Logged at `error` level so it appears regardless of verbosity. The app password is never in
  // settings: `passwordSecretId` is only a SecretStorage key.
  async logSettingsSnapshot(): Promise<void> {
    const snapshot = JSON.stringify(this.settings);
    await this.logger.log(`settings snapshot: ${snapshot}`, 'error');
  }

  onunload(): void {
    this.teardownSyncEngine();
  }

  // Without this on re-login/account switch, the old engine's auto-sync timer keeps running, its
  // status-bar item is never removed, and two engines read/write the same StateDB concurrently.
  private teardownSyncEngine(): void {
    this.teardownClientPush();
    this.syncEngine?.stopAutoSync();
    // Order matters: signal an in-flight sync to stop pulling new work, then flush pending debounced
    // saves so a coalesced watch-mode update is not lost.
    this.syncEngine?.requestStop();
    void this.syncEngine?.flushState();
    void this.baseStore?.flush();
    void this.cleanSideStore?.flush();
    this.localAdapter?.dispose();
    this.mobileSyncStatusItem?.destroy();
    this.mobileSyncStatusItem = undefined;
    this.statusBarEl?.remove();
    this.statusBarEl = undefined;
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData() ?? {}) as Partial<DavSyncSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    // Migrations below must run before pruneObsoleteSettings drops the keys they read.
    this.settings.configSync = { ...DEFAULT_SETTINGS.configSync };
    migrateConfigSyncCategories(saved, this.settings);
    migrateBookmarksToConfigSync(saved, this.settings);
    // Mobile first-run defaults plus the one-time Android Watch opt-in boundary.
    let mobileWatchMigrated = false;
    if (Platform.isMobile) {
      applyMobileFirstRunDefaults(saved, this.settings);
      if (!Platform.isIosApp) mobileWatchMigrated = migrateAndroidWatchOptIn(saved, this.settings);
    }
    if (saved.networkConcurrency === undefined) {
      this.settings.networkConcurrency = autoNetworkConcurrency();
    }

    migrateStartupToggleToDelay(saved, this.settings);

    migrateConflictSettingsToStrategies(saved, this.settings);

    migrateFrontmatterScalarPolicyToStrategy(saved, this.settings);

    migrateMarkdownAutoMergeType(this.settings);

    // Device name and log folder are no longer user-settable: force both back to their sentinels.
    const debugReset = resetDebugIdentityFields(saved, this.settings);

    normalizeSyncedCommunityPlugins(this.settings, this.manifest.id);

    // Persist the cleaned settings so data.json no longer carries obsolete keys or a stale Debug identity.
    const removed = pruneObsoleteSettings(this.settings as unknown as Record<string, unknown>);
    if (removed.length > 0 || debugReset || mobileWatchMigrated) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    normalizeSyncedCommunityPlugins(this.settings, this.manifest.id);
    await this.saveData(this.settings);
  }

  // Opens the community plugin picker; `onChanged` runs after a confirmed selection is saved.
  openCommunityPluginPicker(onChanged: () => void): void {
    const load = (): Promise<PluginCandidateList> => this.syncEngine
      ? this.syncEngine.listCommunityPluginCandidates()
      : collectCommunityPluginCandidates({
        localAdapter: new LocalAdapter(this.app.vault.adapter),
        client: null,
        configDir: this.app.vault.configDir,
        ownId: this.manifest.id,
        isMobile: Platform.isMobile,
      });
    const confirm = (step: PluginSelectionConfirmStep): Promise<boolean> => confirmModal(this.app, step.kind === 'risk'
      ? {
        title: 'Dangerous: sync community plugin code',
        message: 'Synced plugins run their code on every device that lists them. A malicious or broken plugin on one device spreads to the others, and different plugin versions on two devices can corrupt that plugin\'s settings. Continue only if you trust these plugins.',
        cta: 'I understand the risk',
        cancel: 'Cancel',
        destructive: true,
      }
      : {
        title: 'Start syncing these plugins?',
        message: `These community plugins will be synced on this device: ${step.added.join(', ')}. Their code and settings will be uploaded to and downloaded from the server.`,
        cta: 'Sync these plugins',
        cancel: 'Cancel',
        destructive: true,
      });
    const apply = async (chosen: string[]): Promise<void> => {
      const result = await applyPluginSelection(this.settings.syncedCommunityPlugins, chosen, this.manifest.id, confirm);
      if (result === null) return;
      this.settings.syncedCommunityPlugins = result;
      await this.saveSettings();
      onChanged();
    };
    new CommunityPluginPickerModal(this.app, { load, current: this.settings.syncedCommunityPlugins, apply }).open();
  }

  // Re-entrant-safe: a call arriving during an in-flight init awaits that same promise. A fresh init
  // first tears down any existing engine (see teardownSyncEngine).
  async initSyncEngine(): Promise<void> {
    if (this.initializingEngine) return this.initializingEngine;
    const promise = this.doInitSyncEngine().finally(() => {
      this.initializingEngine = undefined;
    });
    this.initializingEngine = promise;
    return promise;
  }

  private async doInitSyncEngine(): Promise<void> {
    this.teardownSyncEngine();

    const { StateDB } = await import('./data/StateDB');
    const { MergeBaseStore } = await import('./data/MergeBaseStore');
    const { SyncHistoryStore } = await import('./data/SyncHistoryStore');
    const { StatusBarItem } = await import('./ui/StatusBarItem');
    const { NoticeStatusBar } = await import('./ui/NoticeStatusBar');
    const { NullStatusBar } = await import('./ui/NullStatusBar');
    const { MobileSyncStatusItem } = await import('./ui/MobileSyncStatusItem');
    const { WebDAVFactory } = await import('./network/WebDAVFactory');
    const { loadAppPassword } = await import('./settings/SettingTab');

    const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const localAdapter = new LocalAdapter(
      this.app.vault.adapter,
      this.app.vault,
      this.app.workspace,
      () => probeCreationTimeSupport(this.app.vault.adapter, `${pluginDir}/.ctime-probe.ncs.tmp`),
    );
    this.localAdapter = localAdapter;
    const stateDB = new StateDB(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await stateDB.load();
    // Last-synced bodies (merge base) for 3-way conflict merges; a separate file.
    const baseStore = new MergeBaseStore(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await baseStore.load();
    this.baseStore = baseStore;
    // Clean sides of marker-conflicted notes, so force-resolution recovers a real clean version
    // rather than the marker content; a separate per-device file.
    const { CleanSideStore } = await import('./data/CleanSideStore');
    const cleanSideStore = new CleanSideStore(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await cleanSideStore.load();
    this.cleanSideStore = cleanSideStore;
    const historyStore = new SyncHistoryStore(this.app.vault.adapter, pluginDir);
    await historyStore.load();

    // Desktop keeps its native status bar. Android gets a compact clickable indicator in the
    // active view action strip; iOS retains the established Notice surface.
    let statusBarEl: HTMLElement | undefined;
    const androidStatus = Platform.isMobile && !Platform.isIosApp
      ? new MobileSyncStatusItem(() => this.openSyncStatus())
      : undefined;
    this.mobileSyncStatusItem = androidStatus;
    const statusBar = androidStatus
      ?? (Platform.isMobile
        ? new NoticeStatusBar()
        : new StatusBarItem(statusBarEl = this.addStatusBarItem(), () => this.openSyncStatus()));
    this.statusBarEl = statusBarEl;
    const password = loadAppPassword(this.app, this.settings.passwordSecretId);
    const webdavFactory = new WebDAVFactory(this.app, this.settings, password, (m) => void this.logger.log(`net: ${m}`));

    this.syncEngine = new SyncEngine({
      app: this.app,
      settings: this.settings,
      localAdapter,
      stateDB,
      baseStore,
      cleanSideStore,
      statusBar,
      lightweightStatusBar: androidStatus ?? (Platform.isMobile ? new NullStatusBar() : statusBar),
      historyStore,
      webdavFactory,
      pluginDir,
      configDir: this.app.vault.configDir,
      pluginsAwaitingRestart: this.pluginsAwaitingRestart,
      // Evaluated live from the same settings and host token as the logger, so it follows the logging
      // toggle (docs/spec.md §9.1).
      isBeingEdited: (path) => this.isBeingEdited(path),
      isActiveLogFile: (path) => isActiveOwnLog(path, {
        logsFolder: this.settings.logsFolder,
        host: this.hostToken(),
        loggingEnabled: this.settings.loggingEnabled,
      }),
      logger: this.logger,
      onFeatures: (features) => {
        // Lets the settings screen recommend an upgrade; persisted only on change.
        if (features.version && features.version !== this.settings.lastKnownServerVersion) {
          this.settings.lastKnownServerVersion = features.version;
          void this.saveSettings();
        }
      },
    });
    androidStatus?.setNetworkAvailable(this.syncEngine.canRunWatchSync());
    this.refreshMobileConflictStatus();

    // Progressive enhancement: if the server advertises Nextcloud Client Push, keep a WebSocket
    // open and use file IDs only to select an existing sync path. The vault-root scope gate filters
    // unrelated account activity; ambiguous events still fall back to the ordinary full sync.
    this.initClientPush(password);

    // Periodic auto-sync is desktop-only (mobile OS suspends background timers).
    this.applyAutoSyncInterval();

    // 0 = no startup sync; 1-10 = seconds to wait.
    if (this.settings.startupSyncDelaySeconds > 0) {
      const delayMs = this.settings.startupSyncDelaySeconds * 1000;
      window.setTimeout(() => { void this.syncEngine?.syncManual(); }, delayMs);
    }
  }

  private initClientPush(password: string | null): void {
    if (!this.settings.useClientPush || !password || !this.syncEngine) return;

    if (!Platform.isMobile && !this.pushStatusItem) {
      this.pushStatusItem = new ClientPushStatusItem(this.addStatusBarItem(), () => {
        new Notice(this.clientPushStatusText(), 10_000);
      });
    }

    const scheduler = new PushSyncScheduler({
      isSyncRunning: () => this.syncEngine?.isSyncRunning() ?? false,
      shouldSync: async () => this.syncEngine?.shouldReconcileClientPush() ?? true,
      onReconciliationTriggered: () => {
        this.pushStatusItem?.pulse();
        this.mobileSyncStatusItem?.pulseRealtime();
      },
      reconcileFileIds: async (batch) => {
        const engine = this.syncEngine;
        if (!engine) return 'full-sync';
        try {
          return await engine.reconcileRemoteFileIds(batch);
        } finally {
          this.refreshMobileConflictStatus();
        }
      },
      sync: async () => {
        const engine = this.syncEngine;
        if (!engine) return 'retry';
        return (await engine.syncForClientPush()) ? 'completed' : 'retry';
      },
      log: (message) => { void this.logger.log(`client-push: ${message}`); },
    });
    this.pushSyncScheduler = scheduler;

    let hadConnectedPushSession = false;
    let previousPushState: string | null = null;
    const client = new NextcloudPushClient({
      serverUrl: this.settings.serverUrl,
      username: this.settings.username,
      password,
      networkTimeoutMs: (this.settings.networkTimeoutSeconds ?? 0) * 1000,
      endpointOverride: this.settings.clientPushUrlOverride,
      onFileNotification: (notification) => scheduler.notify(notification),
      onStatusChange: (status) => {
        this.pushStatusItem?.setStatus(status);
        this.mobileSyncStatusItem?.setRealtimeState(
          status.state === 'connected'
            ? 'connected'
            : (status.state === 'offline'
              ? 'offline'
              : (status.state === 'discovering'
                || status.state === 'connecting'
                || status.state === 'authenticating'
                || status.state === 'reconnecting')
                ? 'connecting'
                : 'inactive'),
        );

        // A reconnect closes another possible notification gap on BOTH desktop and mobile. The first
        // successful connection is excluded so Client Push does not invent a second startup-sync path.
        // Status is also emitted for ordinary notifications, so trigger only on an actual transition
        // into the connected state, not merely whenever status.state happens to be "connected".
        const enteredConnected = status.state === 'connected' && previousPushState !== 'connected';
        if (enteredConnected) {
          if (hadConnectedPushSession) scheduler.requestRemoteCatchUp('WebSocket reconnected');
          hadConnectedPushSession = true;
        }
        previousPushState = status.state;
      },
      log: (message) => { void this.logger.log(`client-push: ${message}`); },
    });
    this.pushClient = client;
    const initialPushStatus = client.getStatus();
    this.pushStatusItem?.setStatus(initialPushStatus);
    this.mobileSyncStatusItem?.setRealtimeState(
      initialPushStatus.state === 'connected'
        ? 'connected'
        : (initialPushStatus.state === 'offline'
          ? 'offline'
          : (initialPushStatus.state === 'discovering'
            || initialPushStatus.state === 'connecting'
            || initialPushStatus.state === 'authenticating'
            || initialPushStatus.state === 'reconnecting')
            ? 'connecting'
            : 'inactive'),
    );
    void client.start();
  }

  private teardownClientPush(): void {
    this.pushSyncScheduler?.stop();
    this.pushSyncScheduler = undefined;
    this.pushClient?.stop();
    this.pushClient = undefined;
    this.mobileSyncStatusItem?.setRealtimeState('inactive');
    this.pushStatusItem?.destroy();
    this.pushStatusItem = undefined;
  }

  /** Apply the Client Push settings immediately without rebuilding the sync engine. */
  async applyClientPushSettings(): Promise<void> {
    this.teardownClientPush();
    if (!this.settings.useClientPush || !this.syncEngine) return;
    const { loadAppPassword } = await import('./settings/SettingTab');
    const password = loadAppPassword(this.app, this.settings.passwordSecretId);
    this.initClientPush(password);
  }

  /** Compact read-only value used by the settings row. */
  clientPushSettingsStatus(): string {
    if (!this.settings.useClientPush) return 'Disabled';
    const push = this.pushClient?.getStatus();
    if (!push) return 'Enabled · not initialized';
    const endpoint = push.endpoint ?? (this.settings.clientPushUrlOverride.trim() || 'auto-detect');
    const source = push.endpointSource === 'override' ? 'override' : 'auto';
    const suffix = push.reason && push.state !== 'connected' ? ` · ${push.reason}` : '';
    return `${push.state} · ${source} · ${endpoint}${suffix}`;
  }

  private clientPushStatusText(): string {
    const push = this.pushClient?.getStatus();
    const scheduler = this.pushSyncScheduler?.getStatus();
    if (!this.settings.useClientPush) return 'Client push is disabled in settings.';
    if (!push) return 'Client push is enabled but not initialized. Configure the server and sign in first.';

    const age = (at: number | null | undefined): string => {
      if (!at) return 'never';
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      return `${seconds}s ago`;
    };

    const retry = push.nextRetryAt
      ? `${Math.max(0, Math.ceil((push.nextRetryAt - Date.now()) / 1000))}s (${new Date(push.nextRetryAt).toLocaleTimeString()})`
      : 'none';

    return [
      `Client push: ${push.state}`,
      `Authenticated: ${push.authenticated ? 'yes' : 'no'}`,
      `Endpoint: ${push.endpoint ?? 'not advertised'}`,
      `Endpoint source: ${push.endpointSource === 'override' ? 'settings override' : push.endpointSource === 'auto' ? 'auto-detected' : 'not resolved'}`,
      `Endpoint override: ${this.settings.clientPushUrlOverride.trim() || 'none (auto-detect)'}`,
      `Reason: ${push.reason ?? 'none'}`,
      `Last connected: ${age(push.lastConnectedAt)}`,
      `Next retry: ${retry}`,
      `Last message: ${push.lastMessage || 'none'}`,
      `Last file notification: ${age(push.lastNotificationAt)}`,
      `Pending reconciliation: ${scheduler?.pending ? 'yes' : 'no'}`,
      `Last push-triggered sync: ${age(scheduler?.lastTriggeredSyncAt)}`,
    ].join('\n');
  }

  /** Refresh the Android indicator from the engine's existing read-only conflict snapshot. */
  private refreshMobileConflictStatus(): void {
    const item = this.mobileSyncStatusItem;
    const engine = this.syncEngine;
    if (!item || !engine) return;
    item.setConflictCount(engine.getStatusReport().conflictedFiles.length);
  }

  private compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
}

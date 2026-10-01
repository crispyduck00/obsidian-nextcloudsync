/**
 * Android foreground-watch lifecycle.
 *
 * This class deliberately knows nothing about Obsidian, WebDAV, merge policy or Client Push. It only
 * owns the small amount of trigger state that mobile adds around the existing watch operations:
 *
 * - file edits may be queued while the app is hidden or Wi-Fi-only blocks the current network;
 * - file work already in flight when the app hides is queued once more for a harmless foreground
 *   re-check, because Android may suspend the WebView before the request/result is fully observed;
 * - structural work (rename/delete/folder ops) is never blindly replayed after an uncertain suspend.
 *   Instead it marks the vault structurally dirty and asks the ordinary full sync to reconcile once
 *   the app is visible on an allowed network.
 *
 * The sync functions injected below are the existing SyncEngine entry points, so this class never
 * becomes a second source of truth for conflict, merge, rename or transfer semantics.
 */
export interface MobileWatchLifecycleDeps {
  isEnabled(): boolean;
  isVisible(): boolean;
  canUseNetwork(): boolean;
  syncFile(path: string): Promise<void>;
  recoverStructural(): Promise<boolean>;
  log?(message: string): void;
}

export class MobileWatchLifecycle {
  private readonly pendingFiles = new Set<string>();
  private readonly inFlightFiles = new Set<string>();
  private structuralInFlight = 0;
  private structuralDirty = false;
  private structuralGeneration = 0;
  private hiddenFlushAttempted = false;
  private recovery: Promise<void> | null = null;

  constructor(private readonly deps: MobileWatchLifecycleDeps) {}

  /** Queue a local file create/modify for the existing debounced single-file path. */
  queueFile(path: string): void {
    if (!this.deps.isEnabled()) return;
    this.pendingFiles.add(path);
  }

  /** Remove a queued old path (delete/rename); returns whether an edit was pending there. */
  takePendingFile(path: string): boolean {
    return this.pendingFiles.delete(path);
  }

  /**
   * Whether a structural watch operation may start now.
   *
   * Once structure is uncertain, targeted MOVE/DELETE/MKCOL operations stop until an authoritative
   * full reconciliation succeeds. This prevents a late event from acting on stale remote paths.
   */
  canStartStructural(): boolean {
    return this.deps.isEnabled()
      && this.deps.isVisible()
      && this.deps.canUseNetwork()
      && !this.structuralDirty
      && this.recovery === null;
  }

  /**
   * Run one rename/delete/folder operation while tracking the suspend window.
   *
   * Returning false means no network operation was started; the caller may still queue associated
   * file content (e.g. edit+rename), which stays blocked behind structural recovery.
   */
  async runStructural(work: () => Promise<void>): Promise<boolean> {
    if (!this.canStartStructural()) {
      this.markStructuralDirty('structural event deferred');
      return false;
    }

    this.structuralInFlight++;
    try {
      await work();
      return true;
    } finally {
      this.structuralInFlight = Math.max(0, this.structuralInFlight - 1);
    }
  }

  /**
   * Mark structure as requiring the normal full reconciliation.
   *
   * The generation lets a recovery that was already running distinguish "I repaired the state I
   * knew about" from "another structural event happened while I was repairing it".
   */
  markStructuralDirty(reason = 'structural state uncertain'): void {
    if (!this.deps.isEnabled()) return;
    this.structuralDirty = true;
    this.structuralGeneration++;
    this.deps.log?.(`mobile-watch: ${reason} → full reconciliation required`);
  }

  /**
   * Flush queued files.
   *
   * Normal calls are foreground-only. The one exception is onHidden(), which gets a single
   * best-effort flush of files that were ALREADY pending when the app was left. Those paths are
   * deliberately left pending as well, so the next foreground re-checks them even if Android
   * suspended the WebView halfway through the request.
   */
  async flushFiles(allowHidden = false): Promise<void> {
    if (!this.deps.isEnabled()) {
      this.resetQueuedState();
      return;
    }
    if (this.structuralDirty || this.recovery !== null) return;
    if (!this.deps.canUseNetwork()) return;
    if (!allowHidden && !this.deps.isVisible()) return;

    const paths = [...this.pendingFiles];
    this.pendingFiles.clear();

    for (const path of paths) {
      // Re-check between paths: Wi-Fi can disappear while a batch is being drained. Already-started
      // work is never aborted, but no new request should begin after the policy changed.
      if (!this.deps.isEnabled()) {
        this.resetQueuedState();
        return;
      }
      if (!this.deps.canUseNetwork() || (!allowHidden && !this.deps.isVisible())) {
        this.pendingFiles.add(path);
        continue;
      }

      const hiddenBestEffort = allowHidden && !this.deps.isVisible();
      if (hiddenBestEffort) this.pendingFiles.add(path); // foreground safety retry
      void this.startFile(path);
    }
  }

  /**
   * App is becoming hidden.
   *
   * - never cancel work already started;
   * - remember in-flight files for a foreground re-check;
   * - any in-flight structural operation becomes uncertain;
   * - give pre-existing pending file edits ONE immediate best-effort flush.
   */
  onHidden(): void {
    if (!this.deps.isEnabled()) {
      this.resetQueuedState();
      return;
    }

    const inFlightAtHide = [...this.inFlightFiles];
    if (this.structuralInFlight > 0) {
      this.markStructuralDirty('app hidden during structural watch operation');
    }

    if (!this.hiddenFlushAttempted) {
      this.hiddenFlushAttempted = true;
      // Flush only work that was pending BEFORE hide. In-flight paths are added afterwards so they
      // are retried on the next foreground, not started a second time while already running.
      void this.flushFiles(true);
    }

    for (const path of inFlightAtHide) this.pendingFiles.add(path);
  }

  /**
   * App is visible again. Structural uncertainty wins over targeted file retries: a full sync first
   * re-establishes authoritative path state, then queued files are harmlessly re-checked.
   */
  onVisible(): void {
    this.hiddenFlushAttempted = false;
    if (!this.deps.isEnabled()) {
      this.resetQueuedState();
      return;
    }
    void this.recoverOrFlush();
  }

  /** Re-evaluate blocked work after Android reports a network-type/connectivity change. */
  onNetworkChanged(): void {
    if (!this.deps.isEnabled()) {
      this.resetQueuedState();
      return;
    }
    if (!this.deps.isVisible()) return; // never start new work merely because network changed hidden
    void this.recoverOrFlush();
  }

  // Small read-only probes kept for unit tests and diagnostics; no sync policy depends on them.
  pendingFileCount(): number { return this.pendingFiles.size; }
  isStructuralDirty(): boolean { return this.structuralDirty; }

  private async startFile(path: string): Promise<void> {
    this.inFlightFiles.add(path);
    try {
      await this.deps.syncFile(path);
    } finally {
      this.inFlightFiles.delete(path);
    }
  }

  private async recoverOrFlush(): Promise<void> {
    if (!this.deps.isEnabled() || !this.deps.isVisible() || !this.deps.canUseNetwork()) return;

    if (this.structuralDirty) {
      if (this.recovery !== null) return;

      const generation = this.structuralGeneration;
      let completed = false;
      const run = (async () => {
        completed = await this.deps.recoverStructural();
        if (completed && generation === this.structuralGeneration) {
          this.structuralDirty = false;
        }
      })();

      this.recovery = run;
      try {
        await run;
      } finally {
        if (this.recovery === run) this.recovery = null;
      }

      if (!completed) return;

      // A structural event may have arrived while the full reconciliation was running. Its generation
      // keeps dirty=true; immediately run one more authoritative pass while the app is still usable.
      if (this.structuralDirty) {
        if (this.deps.isVisible() && this.deps.canUseNetwork()) void this.recoverOrFlush();
        return;
      }
    }

    await this.flushFiles(false);
  }

  private resetQueuedState(): void {
    this.pendingFiles.clear();
    this.structuralDirty = false;
    this.structuralGeneration++;
    this.hiddenFlushAttempted = false;
  }
}

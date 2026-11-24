import type { PushFileNotification } from '../../network/push/NextcloudPushClient';
import type { RemoteBatchReconcileResult, RemotePushBatch } from './RemotePushReconciler';

/** Central defaults so push timing can be tuned without spreading magic numbers through the code. */
export const PUSH_SYNC_TIMING = {
  batchDebounceMs: 350,
  batchMaxDelayMs: 2000,
  busyRetryMs: 500,
  fullSyncQuietMs: 3000,
  fullSyncMaxDelayMs: 8000,
  fullSyncRetryMs: 5000,
  fullSyncMaxRetryMs: 60000,
  teamMountFirstProbeMs: 10000,
  teamMountProbeIntervalMs: 60000,
  teamMountGraceMs: 310000,
} as const;

export type PushFullSyncResult = 'completed' | 'retry';

export type ClientPushScopeResult =
  | { kind: 'ignore' }
  | { kind: 'targeted'; rootFileId: string | null; rootEtag: string }
  | { kind: 'full-sync'; retryOnUnchanged?: true };

type ChangedPushRoot = Extract<ClientPushScopeResult, { kind: 'targeted' }>;

export interface PushSyncSchedulerOptions {
  isSyncRunning(): boolean;
  canSync?(): boolean;
  /**
   * Optional vault-scope check. The boolean form is retained for the standalone Client Push layer:
   * false means proven irrelevant, true means conservatively use the ordinary full sync. P2 returns
   * an explicit result so only a positively changed root may enter targeted reconciliation.
   */
  shouldSync?(fileIds: readonly string[], probeOnly?: true): Promise<boolean | ClientPushScopeResult>;
  /** Only poll newly discovered Team Folder mounts while the push session is connected and visible. */
  canProbeTeamMount?(): boolean;
  /** Establish whether tracking covers the complete remote view for a generic or untracked hint. */
  verifyRoot?(root: ChangedPushRoot): Promise<boolean>;
  /** Called only when a push actually starts reconciliation, not while a full sync merely waits. */
  onReconciliationTriggered?(): void;
  /** Optional targeted path added by remote-reconcile; absent keeps the original full-sync behavior. */
  reconcileFileIds?(batch: RemotePushBatch): Promise<RemoteBatchReconcileResult>;
  /** Existing authoritative full-vault reconciliation used for every ambiguous case. */
  sync(): Promise<void | PushFullSyncResult>;
  log?(message: string): void;
  /** Initial push-batch coalescing window. */
  debounceMs?: number;
  /** Quiet period before an already-required full reconciliation actually starts. */
  fullSyncQuietMs?: number;
  /** Hard cap from the first full-sync requirement, so continuous activity cannot postpone forever. */
  fullSyncMaxDelayMs?: number;
}

/**
 * Coalesces Nextcloud Client Push hints into the smallest safe reconciliation.
 *
 * The vault-root scope probe remains the safety boundary. A targeted batch covers only its IDs.
 * An ambiguous notification needs a separate whole-vault proof or an ordinary full sync.
 *
 * Known files use the existing per-file classifier immediately. Structural/ambiguous work is
 * deliberately delayed for a short quiet window (with a hard max wait) so create -> rename -> move
 * bursts collapse into one authoritative scan. Push remains best-effort acceleration only.
 */
export class PushSyncScheduler {
  private readonly pendingFileIds = new Set<string>();
  /** Generic notify_file / malformed notify_file_id in the current not-yet-classified batch. */
  private needsFullSync = false;
  /** A connection/foreground gap may have hidden remote notifications; verify the vault root once. */
  private catchUpRequested = false;
  /** A classified structural/ambiguous event has already established that a full sync is required. */
  private fullSyncPending = false;
  private fullSyncFirstRequestedAt: number | null = null;
  private fullSyncLastActivityAt: number | null = null;
  private retryOnUnchanged = false;
  private firstPendingNotificationAt: number | null = null;
  private retryAt = 0;
  private failureCount = 0;
  private timer: number | null = null;
  private teamMountTimer: number | null = null;
  private teamMountGraceUntil = 0;
  private stopped = false;
  private syncing = false;
  private lastNotificationAt: number | null = null;
  private lastTriggeredSyncAt: number | null = null;

  constructor(private readonly opts: PushSyncSchedulerOptions) {}

  /** notify_push can cache a new Team Folder's recipient mapping for up to five minutes. */
  teamMountDiscovered(): void {
    if (this.stopped) return;
    this.teamMountGraceUntil = Date.now() + PUSH_SYNC_TIMING.teamMountGraceMs;
    if (this.teamMountTimer === null) this.scheduleTeamMountProbe(PUSH_SYNC_TIMING.teamMountFirstProbeMs);
  }

  private scheduleTeamMountProbe(delayMs: number, retryBusy = true): void {
    this.teamMountTimer = window.setTimeout(() => {
      this.teamMountTimer = null;
      const remaining = this.teamMountGraceUntil - Date.now();
      // Mobile timers may resume hours late. The ordinary foreground catch-up covers that gap.
      if (remaining < -PUSH_SYNC_TIMING.teamMountProbeIntervalMs) return;
      if (remaining > 0) this.scheduleTeamMountProbe(PUSH_SYNC_TIMING.teamMountProbeIntervalMs);
      void this.probeTeamMount(remaining <= 0 && retryBusy);
    }, delayMs);
  }

  private canProbeTeamMount(): boolean {
    return !this.stopped && this.canSync() && this.opts.canProbeTeamMount?.() === true;
  }

  private async probeTeamMount(retryBusy: boolean): Promise<void> {
    if (!this.canProbeTeamMount()) return;
    // A running upload may never inspect the rest of the vault. Give a busy final check one more slot.
    const deferIfBusy = (busy: boolean): boolean => {
      if (busy && retryBusy && this.teamMountTimer === null) this.scheduleTeamMountProbe(PUSH_SYNC_TIMING.teamMountFirstProbeMs, false);
      return busy;
    };
    if (deferIfBusy(this.syncing || this.hasPending() || this.opts.isSyncRunning())) return;
    this.syncing = true;
    try {
      const scope = await this.opts.shouldSync?.([], true);
      // A timer is not evidence of a change. Only a positively changed vault root warrants a scan.
      if (typeof scope !== 'object' || scope.kind !== 'targeted' || !this.canProbeTeamMount() || deferIfBusy(this.opts.isSyncRunning())) return;
      this.opts.log?.('push: Team Folder catch-up found a changed vault root → triggering full reconciliation');
      this.opts.onReconciliationTriggered?.();
      if (await this.opts.sync() !== 'retry' && !this.stopped) this.lastTriggeredSyncAt = Date.now();
    } catch (err) {
      this.opts.log?.(`push: Team Folder catch-up failed — ${this.errorMessage(err)}`);
    } finally {
      this.syncing = false;
      // A real hint may have arrived (and its debounce timer elapsed) while the probe was in flight.
      if (this.timer === null) this.scheduleNext();
    }
  }

  /**
   * Request a cheap root-ETag catch-up after a period in which push notifications may have been
   * missed (mobile background suspension, network outage, WebSocket reconnect). This is deliberately
   * separate from notify(): there may be no concrete file ID to reconcile after a connection gap.
   */
  requestRemoteCatchUp(reason = 'connection gap'): void {
    if (this.stopped) return;
    const firstRequest = !this.catchUpRequested;
    this.catchUpRequested = true;
    if (firstRequest) this.opts.log?.(`push: remote catch-up requested (${reason})`);
    // Probe immediately. If a structural full sync is already pending, drain() preserves its existing
    // quiet/max deadline; this request must not extend a burst merely because the app became visible.
    this.schedule(0);
  }

  notify(notification: PushFileNotification): void {
    if (this.stopped) return;
    this.lastNotificationAt = Date.now();
    this.firstPendingNotificationAt ??= this.lastNotificationAt;

    if (!notification.fileIds || notification.fileIds.length === 0) {
      this.needsFullSync = true;
    } else {
      let validIds = 0;
      for (const raw of notification.fileIds) {
        const id = raw.trim();
        if (!id) continue;
        this.pendingFileIds.add(id);
        validIds++;
      }
      if (validIds === 0) this.needsFullSync = true;
    }

    const ids = notification.fileIds?.length
      ? ` ids=${notification.fileIds.slice(0, 8).join(',')}${notification.fileIds.length > 8 ? ',…' : ''}`
      : '';
    this.opts.log?.(`push: file notification received${ids}`);

    if (this.fullSyncPending) {
      // Once a structural burst is known, do not start new targeted work. Every additional push merely
      // extends the quiet window; the max deadline remains anchored to the first structural event.
      this.fullSyncLastActivityAt = this.lastNotificationAt;
      if (!this.syncing) this.scheduleNext();
      return;
    }
    const quiet = this.catchUpRequested ? 0 : this.opts.debounceMs ?? PUSH_SYNC_TIMING.batchDebounceMs;
    const remaining = this.firstPendingNotificationAt + PUSH_SYNC_TIMING.batchMaxDelayMs - this.lastNotificationAt;
    this.schedule(Math.min(quiet, remaining));
  }

  /** Keep the batch queued while the network policy blocks work. */
  onNetworkChanged(): void {
    if (!this.canSync()) this.clearTimer();
    else if (!this.syncing) this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.teamMountTimer !== null) window.clearTimeout(this.teamMountTimer);
    this.teamMountTimer = null;
    this.pendingFileIds.clear();
    this.needsFullSync = false;
    this.catchUpRequested = false;
    this.firstPendingNotificationAt = null;
    this.clearFullSyncPending();
    this.clearFailureBackoff();
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  getStatus(): { pending: boolean; lastNotificationAt: number | null; lastTriggeredSyncAt: number | null } {
    return {
      pending: this.hasPending(),
      lastNotificationAt: this.lastNotificationAt,
      lastTriggeredSyncAt: this.lastTriggeredSyncAt,
    };
  }

  private hasPending(): boolean {
    return this.fullSyncPending || this.needsFullSync || this.catchUpRequested || this.pendingFileIds.size > 0;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.clearTimer();
    if (!this.canSync()) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, Math.max(0, delayMs, this.retryAt - Date.now()));
  }

  private canSync(): boolean {
    return this.opts.canSync?.() !== false;
  }

  private scheduleNext(minDelayMs = 0): void {
    if (this.stopped || !this.hasPending()) return;
    if (this.fullSyncPending) {
      this.schedule(Math.max(minDelayMs, this.fullSyncDelayMs()));
      return;
    }
    this.schedule(minDelayMs);
  }

  private restoreBatch(
    fullSyncRequested: boolean,
    fileIds: readonly string[],
    catchUpRequested = false,
  ): void {
    if (fullSyncRequested) this.needsFullSync = true;
    if (catchUpRequested) this.catchUpRequested = true;
    for (const id of fileIds) this.pendingFileIds.add(id);
  }

  private requestFullSync(reason: string, retryOnUnchanged = false): void {
    const now = Date.now();
    this.retryOnUnchanged ||= retryOnUnchanged;
    if (!this.fullSyncPending) {
      this.fullSyncPending = true;
      this.fullSyncFirstRequestedAt = now;
      this.fullSyncLastActivityAt = now;
      this.opts.log?.(
        `push: ${reason} → full reconciliation pending `
        + `(quiet=${this.fullSyncQuietMs()}ms, max=${this.fullSyncMaxDelayMs()}ms)`,
      );
    }
  }

  private clearFullSyncPending(): void {
    this.fullSyncPending = false;
    this.fullSyncFirstRequestedAt = null;
    this.fullSyncLastActivityAt = null;
    this.retryOnUnchanged = false;
  }

  private clearFailureBackoff(): void {
    this.failureCount = 0;
    this.retryAt = 0;
  }

  private fullSyncQuietMs(): number {
    return Math.max(0, this.opts.fullSyncQuietMs ?? PUSH_SYNC_TIMING.fullSyncQuietMs);
  }

  private fullSyncMaxDelayMs(): number {
    return Math.max(0, this.opts.fullSyncMaxDelayMs ?? PUSH_SYNC_TIMING.fullSyncMaxDelayMs);
  }

  private fullSyncDelayMs(): number {
    if (!this.fullSyncPending) return 0;
    const now = Date.now();
    const first = this.fullSyncFirstRequestedAt ?? now;
    const last = this.fullSyncLastActivityAt ?? first;
    const quietDue = last + this.fullSyncQuietMs();
    const maxDue = first + this.fullSyncMaxDelayMs();
    return Math.max(0, Math.min(quietDue, maxDue) - now);
  }

  private async runPendingFullSync(): Promise<void> {
    if (!this.fullSyncPending || this.fullSyncDelayMs() > 0 || this.stopped || !this.canSync()
      || Date.now() < this.retryAt) return;

    // Consume the pending request BEFORE awaiting. A push arriving during this full sync forms a new
    // batch and is scope-checked afterwards instead of being silently swallowed by this run.
    const retryOnUnchanged = this.retryOnUnchanged;
    this.clearFullSyncPending();
    this.opts.onReconciliationTriggered?.();
    this.opts.log?.('push: full reconciliation debounce elapsed → triggering full reconciliation');

    let outcome: void | PushFullSyncResult;
    try {
      outcome = await this.opts.sync();
    } catch (err) {
      this.opts.log?.(`push: full reconciliation failed — ${this.errorMessage(err)}; keeping request pending`);
      outcome = 'retry';
    }

    if (this.stopped) return;
    if (outcome === 'retry') {
      if (this.canSync()) {
        const delay = Math.min(PUSH_SYNC_TIMING.fullSyncMaxRetryMs,
          PUSH_SYNC_TIMING.fullSyncRetryMs * 2 ** this.failureCount);
        this.failureCount += 1;
        this.retryAt = Date.now() + delay;
      }
      this.requestFullSync('full reconciliation did not complete', retryOnUnchanged);
      return;
    }

    this.clearFailureBackoff();
    // `undefined` is kept as a backwards-compatible success result for the standalone push layer.
    this.lastTriggeredSyncAt = Date.now();
  }

  private async drain(): Promise<void> {
    if (this.stopped || !this.hasPending() || this.syncing || !this.canSync()) return;
    if (this.opts.isSyncRunning()) {
      // Keep the hints until the running sync finishes, then check whether it covered them.
      this.scheduleNext(PUSH_SYNC_TIMING.busyRetryMs);
      return;
    }

    // Snapshot-and-clear before the first await. New pushes form a new live batch and are processed
    // afterwards, so a notification arriving during scope/network work is never silently consumed.
    const fullSyncRequested = this.needsFullSync;
    const catchUpRequested = this.catchUpRequested;
    const fileIds = [...this.pendingFileIds];
    this.needsFullSync = false;
    this.catchUpRequested = false;
    this.pendingFileIds.clear();
    this.firstPendingNotificationAt = null;
    this.syncing = true;

    let retryDelayMs = 0;
    try {
      let scope: ClientPushScopeResult = { kind: 'full-sync' };
      if (this.opts.shouldSync) {
        try {
          scope = this.normalizeScope(await this.opts.shouldSync(fileIds));
        } catch (err) {
          // Scope filtering is an optimization. Any failure must preserve the ordinary sync path.
          this.opts.log?.(`push: vault scope check failed — ${this.errorMessage(err)}; reconciling normally`);
        }
      }

      if (this.stopped) return;
      if (this.opts.isSyncRunning() || !this.canSync()) {
        this.restoreBatch(fullSyncRequested, fileIds, catchUpRequested);
        retryDelayMs = PUSH_SYNC_TIMING.busyRetryMs;
        return;
      }

      if (scope.kind === 'ignore') {
        if (this.retryOnUnchanged) {
          await this.runPendingFullSync();
          return;
        }
        if (this.fullSyncPending) this.opts.log?.('push: authoritative vault root caught up → cancelling pending full reconciliation');
        this.clearFullSyncPending();
        this.clearFailureBackoff();
        this.opts.log?.('push: vault root unchanged → no vault reconciliation needed');
        return;
      }

      if (scope.kind === 'full-sync') {
        this.requestFullSync('vault scope requires reconciliation', scope.retryOnUnchanged);
        await this.runPendingFullSync();
        return;
      }

      // A previously classified structural burst always wins over later targeted hints. Waiting for
      // one final authoritative scan is both cheaper and safer than reconciling paths in a moving tree.
      if (this.fullSyncPending) {
        await this.runPendingFullSync();
        return;
      }

      let verified = false;
      if (catchUpRequested || fullSyncRequested) {
        verified = await this.verifyRoot(scope);
        if (this.stopped) return;
        if (!verified) {
          this.requestFullSync(catchUpRequested
            ? 'remote catch-up found an unverified vault state'
            : 'generic notification with an unverified vault state');
          await this.runPendingFullSync();
          return;
        }
        if (fileIds.length === 0) return;
      }

      if (!this.opts.reconcileFileIds) {
        this.requestFullSync('targeted reconciliation is unavailable');
        await this.runPendingFullSync();
        return;
      }
      if (!this.canSync()) {
        this.restoreBatch(fullSyncRequested, fileIds, catchUpRequested);
        return;
      }

      this.opts.log?.(`push: reconciling ${fileIds.length} remote file id(s)`);
      let result: RemoteBatchReconcileResult;
      try {
        result = await this.opts.reconcileFileIds({ fileIds, rootFileId: scope.rootFileId });
      } catch (err) {
        // A bug/failure in the optimization must never become a second source of truth.
        if (this.stopped) return;
        this.opts.log?.(`push: targeted reconciliation failed — ${this.errorMessage(err)}`);
        this.requestFullSync('targeted reconciliation failed');
        await this.runPendingFullSync();
        return;
      }

      if (this.stopped) return;
      if (result === 'busy' || !this.canSync()) {
        this.restoreBatch(fullSyncRequested, fileIds, catchUpRequested);
        retryDelayMs = PUSH_SYNC_TIMING.busyRetryMs;
        return;
      }

      if (result === 'untracked') {
        if (verified || await this.verifyRoot(scope) || this.stopped) return;
        this.requestFullSync('untracked IDs coincide with an unverified vault state');
        await this.runPendingFullSync();
        return;
      }

      if (result === 'full-sync' || result === 'rename-pending') {
        this.requestFullSync('targeted batch became structural/ambiguous', result === 'rename-pending');
        await this.runPendingFullSync();
        return;
      }

      if (result === 'plugin-pending') {
        // A full session prepares and orders plugin bundles. Deferring one must not certify the
        // whole root as processed, hide an unrelated unknown ID, or create a retry timer loop.
        this.opts.log?.('push: known plugin work waits for the next full session; root checkpoint not advanced');
        return;
      }

      this.opts.onReconciliationTriggered?.();
      this.lastTriggeredSyncAt = Date.now();
    } catch (err) {
      this.opts.log?.(`push: reconciliation failed — ${this.errorMessage(err)}`);
    } finally {
      this.syncing = false;
      if (this.hasPending() && !this.stopped) this.scheduleNext(retryDelayMs);
    }
  }

  private async verifyRoot(root: ChangedPushRoot): Promise<boolean> {
    try {
      const verified = await this.opts.verifyRoot?.(root);
      if (verified) this.opts.log?.('push: complete remote view already covered → no vault reconciliation needed');
      return verified === true;
    } catch (err) {
      this.opts.log?.(`push: vault verification failed — ${this.errorMessage(err)}; reconciling normally`);
      return false;
    }
  }

  private normalizeScope(result: boolean | ClientPushScopeResult): ClientPushScopeResult {
    if (typeof result === 'boolean') return result ? { kind: 'full-sync' } : { kind: 'ignore' };
    return result;
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

import type { PushFileNotification } from '../../network/push/NextcloudPushClient';
import type { RemoteBatchReconcileResult, RemotePushBatch } from './RemotePushReconciler';

/** Central defaults so push timing can be tuned without spreading magic numbers through the code. */
export const PUSH_SYNC_TIMING = {
  batchDebounceMs: 350,
  busyRetryMs: 500,
  fullSyncQuietMs: 3000,
  fullSyncMaxDelayMs: 8000,
} as const;

export type PushFullSyncResult = 'completed' | 'retry';

export type ClientPushScopeResult =
  | { kind: 'ignore' }
  | { kind: 'targeted'; rootFileId: string | null; rootEtag: string }
  | { kind: 'full-sync' };

export interface PushSyncSchedulerOptions {
  isSyncRunning(): boolean;
  /**
   * Optional vault-scope check. The boolean form is retained for the standalone Client Push layer:
   * false means proven irrelevant, true means conservatively use the ordinary full sync. P2 returns
   * an explicit result so only a positively changed root may enter targeted reconciliation.
   */
  shouldSync?(): Promise<boolean | ClientPushScopeResult>;
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
 * The vault-root scope probe remains the safety boundary: ordinary/full sync owns the authoritative
 * root ETag, while this scheduler keeps a separate in-memory ETag only for push de-noising. That
 * observed ETag is NEVER written to StateDB and therefore can never suppress a later ordinary sync.
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
  /**
   * Last vault-root ETag observed BEFORE a completely successful targeted push batch.
   * Memory-only and intentionally independent from StateDB's authoritative root ETag.
   */
  private observedPushRootEtag: string | null = null;
  private timer: number | null = null;
  private stopped = false;
  private syncing = false;
  private lastNotificationAt: number | null = null;
  private lastTriggeredSyncAt: number | null = null;

  constructor(private readonly opts: PushSyncSchedulerOptions) {}

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
      this.fullSyncLastActivityAt = Date.now();
      if (!this.syncing) this.scheduleNext();
      return;
    }
    this.schedule(this.opts.debounceMs ?? PUSH_SYNC_TIMING.batchDebounceMs);
  }

  stop(): void {
    this.stopped = true;
    this.pendingFileIds.clear();
    this.needsFullSync = false;
    this.catchUpRequested = false;
    this.clearFullSyncPending();
    this.observedPushRootEtag = null;
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
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, Math.max(0, delayMs));
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

  private requestFullSync(reason: string): void {
    const now = Date.now();
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
    if (!this.fullSyncPending || this.fullSyncDelayMs() > 0 || this.stopped) return;

    // Consume the pending request BEFORE awaiting. A push arriving during this full sync forms a new
    // batch and is scope-checked afterwards instead of being silently swallowed by this run.
    this.clearFullSyncPending();
    this.observedPushRootEtag = null;
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
      // The request was skipped (busy / Wi-Fi-only) or the authoritative run itself failed. Keep one
      // debounced request alive instead of silently consuming the only hint. `requestFullSync` starts
      // a fresh quiet window, which also avoids a tight retry loop while the server/network is down.
      this.requestFullSync('full reconciliation did not complete');
      return;
    }

    // `undefined` is kept as a backwards-compatible success result for the standalone push layer.
    this.lastTriggeredSyncAt = Date.now();
  }

  private async drain(): Promise<void> {
    if (this.stopped || !this.hasPending() || this.syncing) return;
    if (this.opts.isSyncRunning()) {
      // An ordinary full sync is authoritative. Forget the transient push checkpoint and keep our
      // hints until that run finishes; the next root probe will discard them if the run covered them.
      this.observedPushRootEtag = null;
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
    this.syncing = true;

    let retryDelayMs = 0;
    try {
      let scope: ClientPushScopeResult = { kind: 'full-sync' };
      if (this.opts.shouldSync) {
        try {
          scope = this.normalizeScope(await this.opts.shouldSync());
        } catch (err) {
          // Scope filtering is an optimization. Any failure must preserve the ordinary sync path.
          this.opts.log?.(`push: vault scope check failed — ${this.errorMessage(err)}; reconciling normally`);
        }
      }

      if (this.stopped) return;
      if (this.opts.isSyncRunning()) {
        this.observedPushRootEtag = null;
        this.restoreBatch(fullSyncRequested, fileIds, catchUpRequested);
        retryDelayMs = PUSH_SYNC_TIMING.busyRetryMs;
        return;
      }

      if (scope.kind === 'ignore') {
        // The authoritative upstream root ETag has caught up (or never changed). Any delayed full
        // request is now proven unnecessary, and an old observed checkpoint must not survive it.
        if (this.fullSyncPending) this.opts.log?.('push: authoritative vault root caught up → cancelling pending full reconciliation');
        this.clearFullSyncPending();
        this.observedPushRootEtag = null;
        this.opts.log?.('push: vault root unchanged → no vault reconciliation needed');
        return;
      }

      if (scope.kind === 'full-sync') {
        this.requestFullSync('vault scope is uncertain');
        await this.runPendingFullSync();
        return;
      }

      const rootEtag = scope.rootEtag;

      // A previously classified structural burst always wins over later targeted hints. Waiting for
      // one final authoritative scan is both cheaper and safer than reconciling paths in a moving tree.
      if (this.fullSyncPending) {
        await this.runPendingFullSync();
        return;
      }

      if (catchUpRequested) {
        // A connection gap has no trustworthy file-ID set: notifications may have been lost while the
        // socket/WebView was suspended. Only a root state already certified by a successful targeted
        // batch (P) can be dismissed. Any newer root state needs the ordinary authoritative scan even
        // when fresh concrete IDs happened to arrive in the same scheduler batch — those IDs cannot
        // prove that they cover everything missed during the gap.
        if (this.observedPushRootEtag !== rootEtag) {
          this.requestFullSync('remote catch-up found a newer/unexplained vault root state');
          await this.runPendingFullSync();
          return;
        }
        this.opts.log?.(`push: remote catch-up matches observed vault root ETag (${rootEtag}) → no missed remote state`);
        if (!fullSyncRequested && fileIds.length === 0) return;
      }

      if (fullSyncRequested) {
        if (this.observedPushRootEtag !== rootEtag) {
          this.requestFullSync('generic/ambiguous notification with a new vault root state');
          await this.runPendingFullSync();
          return;
        }
        if (fileIds.length === 0) {
          this.opts.log?.(`push: generic notification matches observed vault root ETag (${rootEtag}) → no new vault change`);
          return;
        }
        // A generic hint and file IDs can be coalesced into one scheduler batch. Once the root ETag
        // proves the generic hint adds no NEW vault state, still process the concrete IDs: a delayed
        // known-file notification from the same root state may be useful even though the generic hint
        // itself is stale/outside noise.
        this.opts.log?.(`push: generic notification matches observed root; reconciling ${fileIds.length} concrete id(s)`);
      }

      if (!this.opts.reconcileFileIds) {
        this.requestFullSync('targeted reconciliation is unavailable');
        await this.runPendingFullSync();
        return;
      }

      this.opts.log?.(`push: reconciling ${fileIds.length} remote file id(s)`);
      let result: RemoteBatchReconcileResult;
      try {
        result = await this.opts.reconcileFileIds({ fileIds, rootFileId: scope.rootFileId });
      } catch (err) {
        // A bug/failure in the optimization must never become a second source of truth.
        this.opts.log?.(`push: targeted reconciliation failed — ${this.errorMessage(err)}`);
        this.requestFullSync('targeted reconciliation failed');
        await this.runPendingFullSync();
        return;
      }

      if (result === 'busy') {
        if (!this.stopped) {
          this.observedPushRootEtag = null;
          this.restoreBatch(false, fileIds, catchUpRequested);
          retryDelayMs = PUSH_SYNC_TIMING.busyRetryMs;
        }
        return;
      }

      if (result === 'untracked') {
        if (this.observedPushRootEtag === rootEtag) {
          this.opts.log?.(`push: untracked IDs match observed vault root ETag (${rootEtag}) → treating as outside/stale push`);
          return;
        }
        this.requestFullSync('untracked IDs coincide with a new vault root state');
        await this.runPendingFullSync();
        return;
      }

      if (result === 'full-sync') {
        this.requestFullSync('targeted batch became structural/ambiguous');
        await this.runPendingFullSync();
        return;
      }

      this.opts.onReconciliationTriggered?.();
      this.lastTriggeredSyncAt = Date.now();
      if (result === 'done') {
        // Checkpoint ONLY the ETag observed before this completely successful targeted batch. If the
        // classifier uploaded a merge/local edit and changed the root again, the next push sees a new
        // ETag and remains conservative.
        this.observedPushRootEtag = rootEtag;
      } else {
        // The path was deliberately deferred/unresolved (error, conflict, retry queue). It still
        // counts as attempted work for status, but must never certify this root state as processed.
        this.opts.log?.('push: targeted batch left deferred/unresolved work → push root checkpoint not advanced');
      }
    } catch (err) {
      this.opts.log?.(`push: reconciliation failed — ${this.errorMessage(err)}`);
    } finally {
      this.syncing = false;
      if (this.hasPending() && !this.stopped) this.scheduleNext(retryDelayMs);
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

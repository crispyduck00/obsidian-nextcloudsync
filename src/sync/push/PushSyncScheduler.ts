import type { PushFileNotification } from '../../network/push/NextcloudPushClient';

const DEFAULT_DEBOUNCE_MS = 350;
const BUSY_RETRY_MS = 500;

export interface PushSyncSchedulerOptions {
  isSyncRunning(): boolean;
  /** Optional cheap scope check. False means the push is proven irrelevant to this vault. */
  shouldSync?(): Promise<boolean>;
  /** Called only when a push survives scope filtering and will trigger reconciliation. */
  onReconciliationTriggered?(): void;
  sync(): Promise<void>;
  log?(message: string): void;
  debounceMs?: number;
}

/**
 * Coalesces best-effort push hints into ordinary full-sync requests.
 *
 * A push can arrive while a manual/startup/periodic sync is already running. SyncEngine's public
 * `syncManual()` deliberately balks in that case, so blindly calling it would lose the hint. This
 * scheduler retains a single pending bit and waits for the running sync to finish before issuing one
 * more reconciliation. Multiple pushes in a burst collapse into one run.
 */
export class PushSyncScheduler {
  private pending = false;
  private timer: number | null = null;
  private stopped = false;
  private syncing = false;
  private lastNotificationAt: number | null = null;
  private lastTriggeredSyncAt: number | null = null;

  constructor(private readonly opts: PushSyncSchedulerOptions) {}

  notify(notification: PushFileNotification): void {
    if (this.stopped) return;
    this.pending = true;
    this.lastNotificationAt = Date.now();
    const ids = notification.fileIds?.length
      ? ` ids=${notification.fileIds.slice(0, 8).join(',')}${notification.fileIds.length > 8 ? ',…' : ''}`
      : '';
    this.opts.log?.(`push: file notification received${ids}`);
    this.schedule(this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  getStatus(): { pending: boolean; lastNotificationAt: number | null; lastTriggeredSyncAt: number | null } {
    return {
      pending: this.pending,
      lastNotificationAt: this.lastNotificationAt,
      lastTriggeredSyncAt: this.lastTriggeredSyncAt,
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs);
  }

  private async drain(): Promise<void> {
    if (this.stopped || !this.pending || this.syncing) return;
    if (this.opts.isSyncRunning()) {
      // Keep the pending bit set. Once the current full sync finishes, perform one extra reconcile so
      // a notification that arrived after that run's remote scan cannot be silently lost.
      this.schedule(BUSY_RETRY_MS);
      return;
    }

    this.pending = false;
    this.syncing = true;
    try {
      if (this.opts.shouldSync) {
        let shouldSync = true;
        try {
          shouldSync = await this.opts.shouldSync();
        } catch (err) {
          // Scope filtering is only an optimization. If it cannot prove irrelevance, preserve the
          // original behavior and let the ordinary sync engine decide what changed.
          this.opts.log?.(`push: vault scope check failed — ${err instanceof Error ? err.message : String(err)}; reconciling normally`);
        }

        if (this.stopped) return;
        // A manual/startup/periodic sync may have started while the async scope check was running.
        // Keep the push pending so it is reconsidered after that run; it may have arrived too late
        // for the running sync's remote scan.
        if (this.opts.isSyncRunning()) {
          this.pending = true;
          return;
        }
        if (!shouldSync) {
          this.opts.log?.('push: vault root unchanged → no vault reconciliation needed');
          return;
        }
      }

      this.opts.onReconciliationTriggered?.();
      this.opts.log?.('push: triggering full reconciliation');
      await this.opts.sync();
      this.lastTriggeredSyncAt = Date.now();
    } catch (err) {
      this.opts.log?.(`push: reconciliation failed — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.syncing = false;
      // A push that arrived during our own sync set pending=true. Reconcile it after the current run,
      // rather than recursively starting a second run inside the first one's completion stack.
      if (this.pending && !this.stopped) this.schedule(0);
    }
  }
}

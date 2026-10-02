import { setIcon } from 'obsidian';
import { SyncStatus } from '../types';
import { IStatusBar } from './StatusBarItem';

export type MobileRealtimeState = 'inactive' | 'connected' | 'connecting' | 'offline';

const SUCCESS_HIGHLIGHT_MS = 2000;

/**
 * Compact Android sync-status surface.
 *
 * Obsidian does not expose its desktop status bar on mobile, so this item lives in the active
 * view's native action strip instead. It implements the existing IStatusBar port: the sync engine
 * remains the sole source of truth and does not know whether the surface is desktop, toast, or this
 * compact mobile indicator.
 *
 * Client Push is deliberately separate from IStatusBar. The optional realtime state only changes
 * the indicator's background; the foreground icon always represents sync state.
 */
export class MobileSyncStatusItem implements IStatusBar {
  private readonly el: HTMLButtonElement;
  private readonly iconEl: HTMLSpanElement;
  private status: SyncStatus = 'idle';
  private conflictCount = 0;
  private errorCount = 0;
  private lastSyncTime: number | null = null;
  private realtimeState: MobileRealtimeState = 'inactive';
  private successTimer: number | null = null;
  private realtimePulseTimer: number | null = null;

  constructor(private readonly onClick?: () => void) {
    this.el = createEl('button');
    this.el.type = 'button';
    this.el.classList.add('clickable-icon', 'ncs-mobile-sync-status');

    this.iconEl = createSpan();
    this.iconEl.classList.add('ncs-mobile-sync-status-icon');
    this.el.appendChild(this.iconEl);

    if (onClick) {
      this.el.addEventListener('click', () => onClick());
    }

    this.refreshHost();
    this.render();
  }

  /** Re-attach after the user switches panes/leaves. Safe to call repeatedly. */
  refreshHost(): void {
    const activeActions = document.querySelector<HTMLElement>('.workspace-leaf.mod-active .view-actions');
    const fallbackActions = document.querySelector<HTMLElement>('.view-actions');
    const host = activeActions ?? fallbackActions;
    if (host && this.el.parentElement !== host) host.prepend(this.el);
  }

  setStatus(status: SyncStatus): void {
    this.status = status;
    this.render();
  }

  setProgress(_processed: number, _total: number): void {
    this.status = 'syncing';
    this.render();
  }

  setConflictCount(count: number): void {
    this.conflictCount = count;
    this.render();
  }

  setErrorCount(count: number): void {
    this.errorCount = count;
    this.render();
  }

  setSyncComplete(
    _uploadedCount: number,
    _downloadedCount: number,
    conflictCount: number,
    errorCount: number,
  ): void {
    this.lastSyncTime = Date.now();
    this.conflictCount = conflictCount;
    this.errorCount = errorCount;
    this.status = conflictCount > 0 ? 'conflict' : (errorCount > 0 ? 'error' : 'idle');

    if (conflictCount === 0 && errorCount === 0) {
      this.flashSuccess();
    } else {
      this.clearSuccessTimer();
      this.el.classList.remove('is-recent-success');
    }
    this.render();
  }

  /** Optional realtime transport hint (Client Push); does not alter sync semantics. */
  setRealtimeState(state: MobileRealtimeState): void {
    this.realtimeState = state;
    this.render();
  }

  /** Briefly accent the realtime background when a push causes reconciliation. */
  pulseRealtime(): void {
    if (this.realtimeState === 'inactive') return;
    this.el.classList.add('is-realtime-activity');
    if (this.realtimePulseTimer !== null) window.clearTimeout(this.realtimePulseTimer);
    this.realtimePulseTimer = window.setTimeout(() => {
      this.realtimePulseTimer = null;
      this.el.classList.remove('is-realtime-activity');
    }, 700);
  }

  destroy(): void {
    this.clearSuccessTimer();
    if (this.realtimePulseTimer !== null) window.clearTimeout(this.realtimePulseTimer);
    this.realtimePulseTimer = null;
    this.el.remove();
  }

  private render(): void {
    this.refreshHost();

    const syncing = this.status === 'syncing';
    const conflicted = !syncing && (this.status === 'conflict' || this.conflictCount > 0);
    const errored = !syncing && !conflicted && (this.status === 'error' || this.errorCount > 0);

    const icon = syncing ? 'refresh-cw' : conflicted ? 'triangle-alert' : errored ? 'circle-alert' : 'check';
    setIcon(this.iconEl, icon);

    this.el.classList.toggle('is-syncing', syncing);
    this.el.classList.toggle('is-conflict', conflicted);
    this.el.classList.toggle('is-error', errored);
    this.el.classList.toggle('is-idle', !syncing && !conflicted && !errored);

    this.el.classList.toggle('is-realtime-connected', this.realtimeState === 'connected');
    this.el.classList.toggle('is-realtime-connecting', this.realtimeState === 'connecting');
    this.el.classList.toggle('is-realtime-offline', this.realtimeState === 'offline');

    const label = this.accessibleLabel(syncing, conflicted, errored);
    this.el.setAttribute('aria-label', label);
    this.el.title = label;
  }

  private accessibleLabel(syncing: boolean, conflicted: boolean, errored: boolean): string {
    let syncText = 'Nextcloud Sync';
    if (syncing) syncText = 'Nextcloud Sync: syncing';
    else if (conflicted) syncText = `Nextcloud Sync: ${this.conflictCount || 1} conflict(s)`;
    else if (errored) syncText = `Nextcloud Sync: ${this.errorCount || 1} error(s)`;
    else if (this.lastSyncTime) {
      syncText = `Nextcloud Sync: last synced ${new Date(this.lastSyncTime).toLocaleTimeString()}`;
    } else {
      syncText = 'Nextcloud Sync: ready';
    }

    if (this.realtimeState === 'connected') return `${syncText}; Client Push connected`;
    if (this.realtimeState === 'connecting') return `${syncText}; Client Push reconnecting`;
    if (this.realtimeState === 'offline') return `${syncText}; Client Push offline`;
    return syncText;
  }

  private flashSuccess(): void {
    this.clearSuccessTimer();
    this.el.classList.add('is-recent-success');
    this.successTimer = window.setTimeout(() => {
      this.successTimer = null;
      this.el.classList.remove('is-recent-success');
    }, SUCCESS_HIGHLIGHT_MS);
  }

  private clearSuccessTimer(): void {
    if (this.successTimer !== null) window.clearTimeout(this.successTimer);
    this.successTimer = null;
  }
}

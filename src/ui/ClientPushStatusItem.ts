import type { PushClientStatus } from '../network/push/NextcloudPushClient';

const PULSE_MS = 700;

/** Compact desktop-only Client Push indicator with a fixed-width footprint. */
export class ClientPushStatusItem {
  private pulseTimer: number | null = null;
  private status: PushClientStatus | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly onClick?: () => void,
  ) {
    this.el.classList.add('ncs-client-push-status', 'mod-clickable');
    this.el.textContent = '⚡';
    if (onClick) this.el.addEventListener('click', onClick);
    this.render();
  }

  setStatus(status: PushClientStatus): void {
    this.status = status;
    this.render();
  }

  pulse(): void {
    this.el.classList.add('is-push-received');
    if (this.pulseTimer !== null) window.clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      this.pulseTimer = null;
      this.el.classList.remove('is-push-received');
    }, PULSE_MS);
  }

  destroy(): void {
    if (this.pulseTimer !== null) window.clearTimeout(this.pulseTimer);
    this.pulseTimer = null;
    this.el.remove();
  }

  private render(): void {
    const state = this.status?.state ?? 'idle';
    this.el.classList.toggle('is-connected', state === 'connected');
    this.el.classList.toggle(
      'is-reconnecting',
      state === 'discovering' || state === 'connecting' || state === 'authenticating' || state === 'reconnecting',
    );
    this.el.classList.toggle('is-offline', state === 'offline');
    this.el.classList.toggle('is-unavailable', state === 'unavailable' || state === 'stopped');
    this.el.title = this.tooltip();
  }

  private tooltip(): string {
    if (!this.status) return 'Nextcloud Client Push: starting…';
    const lines = [`Nextcloud Client Push: ${this.status.state}`];
    if (this.status.endpoint) {
      const source = this.status.endpointSource === 'override' ? 'override' : 'auto-detected';
      lines.push(`${this.status.endpoint} (${source})`);
    }
    if (this.status.reason) lines.push(`Reason: ${this.status.reason}`);
    if (this.status.lastConnectedAt) {
      lines.push(`Last connected: ${new Date(this.status.lastConnectedAt).toLocaleTimeString()}`);
    }
    if (this.status.nextRetryAt) {
      lines.push(`Next retry: ${new Date(this.status.nextRetryAt).toLocaleTimeString()}`);
    }
    if (this.status.lastNotificationAt) {
      lines.push(`Last push: ${new Date(this.status.lastNotificationAt).toLocaleTimeString()}`);
    }
    return lines.join('\n');
  }
}

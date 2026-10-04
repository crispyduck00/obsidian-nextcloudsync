import { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { requestUrlWithTimeout } from '../requestWithTimeout';
import { NO_CACHE_HEADERS } from '../noCacheHeaders';

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const REDISCOVER_AFTER_SOCKET_FAILURES = 6;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

class PermanentPushDiscoveryError extends Error {}

/** A file-change signal delivered by Nextcloud Client Push. */
export interface PushFileNotification {
  /** File IDs when notify_push could identify them; null means "some file changed". */
  fileIds: string[] | null;
  /** Raw protocol message, retained for diagnostics. */
  raw: string;
}

export type PushConnectionState =
  | 'idle'
  | 'discovering'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'offline'
  | 'unavailable'
  | 'reconnecting'
  | 'stopped';

export interface PushClientStatus {
  state: PushConnectionState;
  endpoint: string | null;
  authenticated: boolean;
  lastMessage: string;
  lastNotificationAt: number | null;
  /** Last time the WebSocket authenticated successfully. */
  lastConnectedAt: number | null;
  /** Human-readable reason for the current degraded state, when known. */
  reason: string | null;
  /** Wall-clock time of the currently scheduled retry, or null when no retry is queued. */
  nextRetryAt: number | null;
  /** Whether the endpoint came from capabilities or a manual settings override. */
  endpointSource: 'auto' | 'override' | null;
  reconnectDelayMs: number;
}

export interface PushWebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface PushClientDependencies {
  request(params: RequestUrlParam, timeoutMs: number): Promise<RequestUrlResponse>;
  createWebSocket(url: string): PushWebSocketLike;
  now(): number;
  isOnline(): boolean;
}

export interface NextcloudPushClientOptions {
  serverUrl: string;
  username: string;
  password: string;
  networkTimeoutMs: number;
  /** Optional manual WebSocket endpoint. Empty/undefined = auto-detect from Nextcloud capabilities. */
  endpointOverride?: string;
  onFileNotification(notification: PushFileNotification): void;
  onStatusChange?(status: PushClientStatus): void;
  log?(message: string): void;
}

const DEFAULT_DEPS: PushClientDependencies = {
  request: requestUrlWithTimeout,
  createWebSocket: (url) => new window.WebSocket(url),
  now: () => Date.now(),
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
};

/**
 * Nextcloud Client Push transport.
 *
 * This class deliberately knows nothing about sync decisions. It only discovers the server's
 * notify_push WebSocket, authenticates, subscribes to file-id notifications, reconnects after
 * transient disconnects, and emits file-change signals. The host decides how to reconcile them.
 *
 * notify_push is best-effort by design, so this transport supplements — never replaces — startup,
 * resume and periodic reconciliation.
 */
export class NextcloudPushClient {
  private socket: PushWebSocketLike | null = null;
  private endpoint: string | null = null;
  private state: PushConnectionState = 'idle';
  private authenticated = false;
  private lastMessage = '';
  private lastNotificationAt: number | null = null;
  private lastConnectedAt: number | null = null;
  private reason: string | null = null;
  private nextRetryAt: number | null = null;
  private endpointSource: 'auto' | 'override' | null = null;
  private networkOnline: boolean;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: number | null = null;
  private handshakeTimer: number | null = null;
  private stopped = false;
  private connecting: Promise<void> | null = null;
  private socketFailureCount = 0;

  constructor(
    private readonly opts: NextcloudPushClientOptions,
    private readonly deps: PushClientDependencies = DEFAULT_DEPS,
  ) {
    this.networkOnline = deps.isOnline();
  }

  /** Start push discovery and connection. Safe to call more than once. */
  async start(): Promise<void> {
    if (this.stopped) return;
    await this.ensureConnected();
  }

  /**
   * Ensure a connection exists. `immediate` cancels a pending backoff, used when the app returns to
   * the foreground or the browser reports that network connectivity is back.
   */
  async ensureConnected(immediate = false): Promise<void> {
    if (this.stopped) return;
    if (!this.networkOnline) {
      this.clearReconnectTimer();
      this.reason = 'Network reported offline';
      this.nextRetryAt = null;
      this.setState('offline');
      return;
    }
    if (this.socket && (this.socket.readyState === WS_OPEN || this.socket.readyState === WS_CONNECTING)) return;
    if (immediate) this.clearReconnectTimer();
    if (this.reconnectTimer !== null) return;
    if (this.connecting) return this.connecting;

    const run = this.connect().finally(() => {
      if (this.connecting === run) this.connecting = null;
    });
    this.connecting = run;
    return run;
  }

  /** Permanently stop this instance and cancel every reconnect/handshake timer. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHandshakeTimer();
    this.closeSocket();
    this.reason = null;
    this.nextRetryAt = null;
    this.setState('stopped');
  }

  /** Inform the transport that the host network went offline/online. */
  setNetworkOnline(online: boolean): void {
    if (this.stopped || this.networkOnline === online) return;
    this.networkOnline = online;

    if (!online) {
      this.clearReconnectTimer();
      this.clearHandshakeTimer();
      this.closeSocket();
      this.reason = 'Network reported offline';
      this.nextRetryAt = null;
      this.setState('offline');
      return;
    }

    // Network recovery is a strong signal: retry immediately rather than waiting for backoff.
    this.reason = null;
    void this.ensureConnected(true);
  }

  getStatus(): PushClientStatus {
    return {
      state: this.state,
      endpoint: this.endpoint,
      authenticated: this.authenticated,
      lastMessage: this.lastMessage,
      lastNotificationAt: this.lastNotificationAt,
      lastConnectedAt: this.lastConnectedAt,
      reason: this.reason,
      nextRetryAt: this.nextRetryAt,
      endpointSource: this.endpointSource,
      reconnectDelayMs: this.reconnectDelayMs,
    };
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    if (!this.endpoint) {
      this.setState('discovering');
      try {
        const override = this.opts.endpointOverride?.trim();
        this.endpointSource = override ? 'override' : 'auto';
        this.endpoint = override ? this.validateEndpoint(override) : await this.discoverEndpoint();
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof PermanentPushDiscoveryError) {
          this.reason = `notify_push discovery unavailable: ${err.message}`;
          this.nextRetryAt = null;
          this.setState('unavailable');
          this.log(this.reason);
          return;
        }
        this.scheduleReconnect(`Capabilities probe failed: ${this.errorMessage(err)}`);
        return;
      }
      if (this.stopped) return;
      if (!this.endpoint) {
        // This is a stable capability result, not a transport failure. Do not poll a server that
        // simply does not have Client Push installed; a plugin reload/re-login re-runs discovery.
        this.reason = 'notify_push capability not advertised by the server';
        this.nextRetryAt = null;
        this.setState('unavailable');
        this.log(`${this.reason}; realtime remote trigger disabled`);
        return;
      }
    }

    this.openSocket(this.endpoint);
  }

  private async discoverEndpoint(): Promise<string | null> {
    const response = await this.deps.request({
      url: `${serverBaseUrl(this.opts.serverUrl)}/ocs/v2.php/cloud/capabilities?format=json`,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'OCS-APIRequest': 'true',
        Authorization: basicAuthHeader(this.opts.username, this.opts.password),
        ...NO_CACHE_HEADERS,
      },
      throw: false,
    }, this.opts.networkTimeoutMs);

    if (response.status < 200 || response.status >= 300) {
      // A missing/forbidden OCS endpoint is a stable capability result for plain WebDAV/public-share
      // configurations, and bad credentials will be fixed only by re-login. Do not hammer either.
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        throw new PermanentPushDiscoveryError(`HTTP ${response.status} from capabilities endpoint`);
      }
      throw new Error(`HTTP ${response.status} from capabilities endpoint`);
    }

    const root = response.json as Record<string, unknown> | undefined;
    const ocs = root?.ocs as Record<string, unknown> | undefined;
    const data = ocs?.data as Record<string, unknown> | undefined;
    const capabilities = data?.capabilities as Record<string, unknown> | undefined;
    const push = capabilities?.notify_push as Record<string, unknown> | undefined;
    const endpoints = push?.endpoints as Record<string, unknown> | undefined;
    const websocket = endpoints?.websocket;
    if (typeof websocket !== 'string' || websocket.trim().length === 0) return null;

    return this.validateEndpoint(websocket.trim());
  }

  private validateEndpoint(endpoint: string): string {
    if (!/^wss?:\/\//i.test(endpoint)) {
      throw new PermanentPushDiscoveryError(`unsupported WebSocket endpoint: ${endpoint}`);
    }
    if (/^https:\/\//i.test(serverBaseUrl(this.opts.serverUrl)) && /^ws:\/\//i.test(endpoint)) {
      throw new PermanentPushDiscoveryError('refusing insecure ws:// endpoint for an HTTPS Nextcloud server');
    }
    return endpoint;
  }

  private openSocket(endpoint: string): void {
    if (this.stopped) return;
    this.closeSocket();

    let socket: PushWebSocketLike;
    try {
      socket = this.deps.createWebSocket(endpoint);
    } catch (err) {
      this.scheduleSocketReconnect(`WebSocket creation failed: ${this.errorMessage(err)}`);
      return;
    }

    this.socket = socket;
    this.authenticated = false;
    this.reason = null;
    this.nextRetryAt = null;
    this.setState('connecting');
    this.armHandshakeTimeout();

    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return;
      this.setState('authenticating');
      socket.send(this.opts.username);
      socket.send(this.opts.password);
    };

    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.handleMessage(String(event.data ?? ''));
    };

    socket.onerror = () => {
      if (this.stopped || this.socket !== socket) return;
      // Browsers intentionally expose almost no WebSocket error detail. Closing here guarantees
      // that an implementation which does not emit `close` after `error` cannot strand us forever.
      this.reconnectFromSocket('WebSocket error');
    };

    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      this.authenticated = false;
      this.clearHandshakeTimer();
      if (this.stopped) return;
      const suffix = event.code ? ` (${event.code}${event.reason ? ` ${event.reason}` : ''})` : '';
      this.scheduleSocketReconnect(`WebSocket disconnected${suffix}`);
    };
  }

  private handleMessage(message: string): void {
    this.lastMessage = message;

    if (message === 'authenticated') {
      this.authenticated = true;
      this.lastConnectedAt = this.deps.now();
      this.reason = null;
      this.nextRetryAt = null;
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.socketFailureCount = 0;
      this.clearHandshakeTimer();
      this.setState('connected');
      this.socket?.send('listen notify_file_id');
      this.log('notify_push authenticated; listening for file-id notifications');
      return;
    }

    const notification = parseFileNotification(message);
    if (!notification) return;
    this.lastNotificationAt = this.deps.now();
    this.emitStatus();
    this.opts.onFileNotification(notification);
  }

  private reconnectFromSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.clearHandshakeTimer();
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch { /* best effort */ }
    }
    this.scheduleSocketReconnect(reason);
  }

  private scheduleSocketReconnect(reason: string): void {
    if (!this.opts.endpointOverride?.trim()) {
      this.socketFailureCount++;
      if (this.socketFailureCount >= REDISCOVER_AFTER_SOCKET_FAILURES) {
        this.log(`notify_push endpoint failed ${this.socketFailureCount} times; re-discovering capabilities`);
        this.endpoint = null;
        this.endpointSource = 'auto';
        this.socketFailureCount = 0;
      }
    }
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.authenticated = false;
    this.reason = reason;
    if (this.reconnectTimer !== null) {
      this.setState('reconnecting');
      return;
    }

    const delay = this.reconnectDelayMs;
    this.nextRetryAt = this.deps.now() + delay;
    this.setState('reconnecting');
    this.log(`${reason}; reconnect in ${delay} ms`);
    this.reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, Math.round(this.reconnectDelayMs * 1.7));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.nextRetryAt = null;
      void this.ensureConnected();
    }, delay);
  }

  private armHandshakeTimeout(): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = window.setTimeout(() => {
      this.handshakeTimer = null;
      if (this.stopped || this.authenticated) return;
      this.reconnectFromSocket('WebSocket authentication timed out');
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer === null) return;
    window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.nextRetryAt = null;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try { socket.close(); } catch { /* best effort */ }
  }

  private setState(state: PushConnectionState): void {
    this.state = state;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.opts.onStatusChange?.(this.getStatus());
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Convert a configured WebDAV endpoint into the owning Nextcloud server URL. */
export function serverBaseUrl(webdavUrl: string): string {
  return webdavUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/remote\.php(?:\/.*)?$/i, '')
    .replace(/\/+$/, '');
}

/** Parse the two file-notification variants documented by nextcloud/notify_push. */
export function parseFileNotification(message: string): PushFileNotification | null {
  if (message === 'notify_file') return { fileIds: null, raw: message };
  const match = /^notify_file_id(?:\s+(.*))?$/.exec(message);
  if (!match) return null;

  const payload = (match[1] ?? '').trim();
  if (!payload) return { fileIds: null, raw: message };

  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!Array.isArray(parsed)) return { fileIds: null, raw: message };
    const fileIds = parsed
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
      .map(String);
    return { fileIds, raw: message };
  } catch {
    // A malformed id payload still means the server told us "a file changed". Falling back to a
    // generic notification preserves correctness; the host can perform a normal reconciliation.
    return { fileIds: null, raw: message };
  }
}

function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

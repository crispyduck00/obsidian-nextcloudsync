import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import {
  NextcloudPushClient,
  PushClientDependencies,
  PushWebSocketLike,
  parseFileNotification,
  serverBaseUrl,
} from '../../../../src/network/push/NextcloudPushClient';

class FakeSocket implements PushWebSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
  message(data: string): void { this.onmessage?.({ data } as MessageEvent); }
  error(): void { this.onerror?.({} as Event); }
  remoteClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

function response(status: number, json: unknown = {}): Promise<RequestUrlResponse> {
  return Promise.resolve({
    status,
    text: JSON.stringify(json),
    json,
    arrayBuffer: new ArrayBuffer(0),
    headers: {},
  });
}

function capabilities(websocket?: string): unknown {
  return {
    ocs: {
      data: {
        capabilities: websocket
          ? { notify_push: { endpoints: { websocket } } }
          : {},
      },
    },
  };
}

function makeClient(overrides: Partial<PushClientDependencies> = {}) {
  const sockets: FakeSocket[] = [];
  const request = jest.fn((_params: RequestUrlParam, _timeoutMs: number) => response(200, capabilities('wss://cloud.example.com/push/ws')));
  const notifications: Array<{ fileIds: string[] | null; raw: string }> = [];
  const deps: PushClientDependencies = {
    request,
    createWebSocket: (url) => {
      expect(url).toBe('wss://cloud.example.com/push/ws');
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => 123456,
    isOnline: () => true,
    ...overrides,
  };
  const client = new NextcloudPushClient({
    serverUrl: 'https://cloud.example.com/remote.php/dav/files/alice/',
    username: 'alice',
    password: 'app-password',
    networkTimeoutMs: 30_000,
    onFileNotification: (notification) => notifications.push(notification),
  }, deps);
  return { client, sockets, request, notifications };
}

describe('NextcloudPushClient', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('derives the Nextcloud server base URL from a WebDAV endpoint', () => {
    expect(serverBaseUrl('https://cloud.example.com/remote.php/dav/files/alice/'))
      .toBe('https://cloud.example.com');
    expect(serverBaseUrl(' https://cloud.example.com/remote.php/dav/files/alice/// '))
      .toBe('https://cloud.example.com');
  });

  it('discovers the push endpoint, authenticates, and subscribes to file IDs', async () => {
    const { client, sockets, request } = makeClient();

    await client.start();

    expect(request).toHaveBeenCalledTimes(1);
    const [params, timeout] = request.mock.calls[0];
    expect(params.url).toBe('https://cloud.example.com/ocs/v2.php/cloud/capabilities?format=json');
    expect(params.headers?.Authorization).toBe(`Basic ${btoa('alice:app-password')}`);
    expect(timeout).toBe(30_000);

    const socket = sockets[0];
    socket.open();
    expect(socket.sent).toEqual(['alice', 'app-password']);
    expect(client.getStatus().state).toBe('authenticating');

    socket.message('authenticated');
    expect(socket.sent).toEqual(['alice', 'app-password', 'listen notify_file_id']);
    expect(client.getStatus()).toMatchObject({
      state: 'connected',
      authenticated: true,
      lastConnectedAt: 123456,
      reason: null,
      nextRetryAt: null,
      endpointSource: 'auto',
    });
  });

  it('emits generic and file-id notifications', async () => {
    const { client, sockets, notifications } = makeClient();
    await client.start();
    const socket = sockets[0];
    socket.open();
    socket.message('authenticated');

    socket.message('notify_file');
    socket.message('notify_file_id [123,"456"]');

    expect(notifications).toEqual([
      { fileIds: null, raw: 'notify_file' },
      { fileIds: ['123', '456'], raw: 'notify_file_id [123,"456"]' },
    ]);
    expect(client.getStatus().lastNotificationAt).toBe(123456);
  });

  it('treats malformed file-id payloads as a generic file notification', async () => {
    const { client, sockets, notifications } = makeClient();
    await client.start();
    const socket = sockets[0];
    socket.open();
    socket.message('authenticated');

    socket.message('notify_file_id not-json');

    expect(notifications).toEqual([{ fileIds: null, raw: 'notify_file_id not-json' }]);
  });

  it('refuses a ws:// downgrade when the configured Nextcloud server uses HTTPS', async () => {
    const request = jest.fn((_params: RequestUrlParam, _timeoutMs: number) =>
      response(200, capabilities('ws://cloud.example.com/push/ws')));
    const { client, sockets } = makeClient({ request });

    await client.start();

    expect(client.getStatus().state).toBe('unavailable');
    expect(sockets).toHaveLength(0);
  });

  it('stays unavailable without notify_push instead of polling capabilities forever', async () => {
    const request = jest.fn((_params: RequestUrlParam, _timeoutMs: number) => response(200, capabilities()));
    const { client, sockets } = makeClient({ request });

    await client.start();
    jest.advanceTimersByTime(60_000);

    expect(client.getStatus()).toMatchObject({ state: 'unavailable', endpoint: null, authenticated: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
  });

  it('treats a missing OCS capabilities endpoint as permanently unavailable', async () => {
    const request = jest.fn((_params: RequestUrlParam, _timeoutMs: number) => response(404));
    const { client, sockets } = makeClient({ request });

    await client.start();
    jest.advanceTimersByTime(60_000);

    expect(client.getStatus().state).toBe('unavailable');
    expect(request).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
  });

  it('reconnects with backoff after a disconnect and reuses the discovered endpoint', async () => {
    const { client, sockets, request } = makeClient();
    await client.start();
    const first = sockets[0];
    first.open();
    first.message('authenticated');

    first.remoteClose(1006, 'network');
    expect(client.getStatus().state).toBe('reconnecting');

    jest.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await Promise.resolve();

    expect(sockets).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(1); // endpoint is cached across reconnects
  });

  it('immediately retries a pending backoff when the host explicitly requests reconnect', async () => {
    const { client, sockets } = makeClient();
    await client.start();
    const first = sockets[0];
    first.open();
    first.message('authenticated');
    first.remoteClose();

    await client.ensureConnected(true);

    expect(sockets).toHaveLength(2);
  });

  it('times out a socket that never authenticates', async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0].open();

    jest.advanceTimersByTime(15_000);

    expect(sockets[0].closed).toBe(true);
    expect(client.getStatus().state).toBe('reconnecting');
  });

  it('does not resurrect itself when stopped during capabilities discovery', async () => {
    let resolveRequest!: (value: RequestUrlResponse) => void;
    const pending = new Promise<RequestUrlResponse>((resolve) => { resolveRequest = resolve; });
    const request = jest.fn((_params: RequestUrlParam, _timeoutMs: number) => pending);
    const { client, sockets } = makeClient({ request });

    const start = client.start();
    client.stop();
    resolveRequest(await response(200, capabilities('wss://cloud.example.com/push/ws')));
    await start;

    expect(client.getStatus().state).toBe('stopped');
    expect(sockets).toHaveLength(0);
  });

  it('stop closes the socket and suppresses reconnects', async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0].open();
    sockets[0].message('authenticated');

    client.stop();
    jest.advanceTimersByTime(60_000);

    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(client.getStatus().state).toBe('stopped');
  });


  it('stays offline without probing the server until network connectivity returns', async () => {
    let online = false;
    const { client, sockets, request } = makeClient({ isOnline: () => online });

    await client.start();

    expect(client.getStatus()).toMatchObject({
      state: 'offline',
      authenticated: false,
      reason: 'Network reported offline',
      nextRetryAt: null,
    });
    expect(request).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);

    online = true;
    client.setNetworkOnline(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  it('cancels reconnect backoff while offline and reconnects immediately when online returns', async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0].open();
    sockets[0].message('authenticated');
    sockets[0].remoteClose(1006, 'network');

    expect(client.getStatus().nextRetryAt).toBe(124456);

    client.setNetworkOnline(false);
    expect(client.getStatus()).toMatchObject({
      state: 'offline',
      reason: 'Network reported offline',
      nextRetryAt: null,
    });

    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);

    client.setNetworkOnline(true);
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
  });

  it('records the transient failure reason and scheduled retry time', async () => {
    const request = jest.fn((_params: RequestUrlParam, _timeoutMs: number) => Promise.reject(new Error('ECONNREFUSED')));
    const { client, sockets } = makeClient({ request });

    await client.start();

    expect(client.getStatus()).toMatchObject({
      state: 'reconnecting',
      reason: 'Capabilities probe failed: ECONNREFUSED',
      nextRetryAt: 124456,
      endpoint: null,
      endpointSource: 'auto',
    });
    expect(sockets).toHaveLength(0);
  });

  it('records a stable unavailable reason without scheduling retries', async () => {
    const request = jest.fn((_params: RequestUrlParam, _timeoutMs: number) => response(200, capabilities()));
    const { client } = makeClient({ request });

    await client.start();

    expect(client.getStatus()).toMatchObject({
      state: 'unavailable',
      reason: 'notify_push capability not advertised by the server',
      nextRetryAt: null,
      endpointSource: 'auto',
    });
  });


  it('uses a configured endpoint override without probing capabilities', async () => {
    const sockets: FakeSocket[] = [];
    const request = jest.fn((_params: RequestUrlParam, _timeoutMs: number) => response(500));
    const client = new NextcloudPushClient({
      serverUrl: 'https://cloud.example.com/remote.php/dav/files/alice/',
      username: 'alice',
      password: 'app-password',
      networkTimeoutMs: 30_000,
      endpointOverride: 'wss://proxy.example.com/custom-push/ws',
      onFileNotification: () => undefined,
    }, {
      request,
      createWebSocket: (url) => {
        expect(url).toBe('wss://proxy.example.com/custom-push/ws');
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      now: () => 0,
      isOnline: () => true,
    });

    await client.start();

    expect(request).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    expect(client.getStatus()).toMatchObject({
      endpoint: 'wss://proxy.example.com/custom-push/ws',
      endpointSource: 'override',
    });
  });

  it('re-discovers an auto-detected endpoint after repeated unauthenticated socket failures', async () => {
    const { client, sockets, request } = makeClient();
    await client.start();

    // Six consecutive socket failures without a successful authentication invalidate the cached
    // endpoint. Explicit immediate retries keep the test independent of the backoff timings.
    for (let i = 0; i < 6; i++) {
      sockets[i].remoteClose();
      await client.ensureConnected(true);
    }

    expect(request).toHaveBeenCalledTimes(2);
    expect(sockets.length).toBeGreaterThanOrEqual(7);
  });
});

describe('parseFileNotification', () => {
  it('ignores unrelated push messages', () => {
    expect(parseFileNotification('notify_activity')).toBeNull();
    expect(parseFileNotification('authenticated')).toBeNull();
    expect(parseFileNotification('notify_file_id_extra [1]')).toBeNull();
  });

  it('keeps an empty id list as an id-aware notification', () => {
    expect(parseFileNotification('notify_file_id []')).toEqual({
      fileIds: [],
      raw: 'notify_file_id []',
    });
  });
});

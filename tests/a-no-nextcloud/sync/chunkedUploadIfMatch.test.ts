import { requestUrl } from 'obsidian';
import { ChunkedUploadStrategy } from '../../../src/sync/upload/ChunkedUploadStrategy';
import { UploadConfig } from '../../../src/sync/upload/IUploadStrategy';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings, PreconditionFailedError } from '../../../src/types';

// Existing files use PUT's precondition on the files DAV resource, even above the chunk threshold.

interface FakeClient {
  uploadFile: jest.Mock;
  uploadChunked: jest.Mock;
}

function fakeClient(): FakeClient {
  return {
    uploadFile: jest.fn().mockResolvedValue(undefined),
    uploadChunked: jest.fn().mockResolvedValue(undefined),
  };
}

function uploadConfig(over: { maxFileSizeMB?: number; uploadChunkThresholdMB?: number }): UploadConfig {
  const max = over.maxFileSizeMB ?? 0;
  return { maxFileSizeMB: () => max, uploadChunkThresholdMB: over.uploadChunkThresholdMB ?? 0.0000001 };
}

const data = new ArrayBuffer(10);

describe('[SPEC:G5-1]: ChunkedUploadStrategy uses a conditional PUT for updates', () => {
  it('forwards the live ETag to PUT for a large existing file', async () => {
    const client = fakeClient();
    const s = new ChunkedUploadStrategy(uploadConfig({ maxFileSizeMB: 100 }));
    const outcome = await s.upload(
      client as unknown as IWebDAVClient, 'big.bin', data, 1000, { ifMatchEtag: 'remote-etag' },
    );
    expect(outcome).toBe('uploaded');
    expect(client.uploadChunked).not.toHaveBeenCalled();
    expect(client.uploadFile).toHaveBeenCalledWith('big.bin', data, 1000, { ifMatchEtag: 'remote-etag' });
  });
});

describe('[SPEC:G5-1]: NextcloudClient.uploadChunked', () => {
  const mockRequestUrl = requestUrl as unknown as jest.Mock;

  const settings: DavSyncSettings = {
    ...DEFAULT_SETTINGS,
    serverUrl: 'https://nc/remote.php/dav/files/alice/',
    username: 'alice',
    deviceId: 'device-abcd1234',
  };

  const res = (status: number, headers: Record<string, string> = {}) =>
    Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers });

  const calls = (method: string) => mockRequestUrl.mock.calls.map((c) => c[0]).filter((r) => r.method === method);

  beforeEach(() => mockRequestUrl.mockReset());

  it('uses conditional PUT and maps a changed file to PreconditionFailedError', async () => {
    mockRequestUrl.mockImplementation(() => res(412));
    await expect(
      new NextcloudClient(settings, () => 'pw', 'Vault').uploadChunked('Notes/big.bin', new ArrayBuffer(2), 10 * 1024 * 1024, { ifMatchEtag: 'etag-xyz' }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(calls('MOVE')).toHaveLength(0);
    expect(calls('PUT')[0].headers?.['If-Match']).toBe('"etag-xyz"');
  });

  it('uses a non-overwriting MOVE for a new file', async () => {
    // Everything succeeds (201); the final PROPFIND checksum-verify step gets a non-207 status
    // (also 201 here) so it short-circuits without a mismatch — see verifyRemoteChecksum().
    mockRequestUrl.mockImplementation(() => res(201));
    await new NextcloudClient(settings, () => 'pw', 'Vault').uploadChunked(
      'Notes/big.bin', new ArrayBuffer(2), 10 * 1024 * 1024, { onlyIfAbsent: true },
    );
    const move = calls('MOVE')[0];
    expect(move.headers?.['If-Match']).toBeUndefined();
    expect(move.headers?.Overwrite).toBe('F');
  });
});

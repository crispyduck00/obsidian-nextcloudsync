import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings, FeatureUnsupportedError, FileVersion } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

function res(status: number, over: Partial<{ text: string; json: unknown; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> = {}) {
  return Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {}, ...over });
}

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'dev-1234',
};

function makeClient(): NextcloudClient {
  return new NextcloudClient(settings, 'app-pw', 'Vault');
}

describe('NextcloudClient versions', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('throws FeatureUnsupportedError when fileId is empty', async () => {
    await expect(makeClient().listVersions('')).rejects.toBeInstanceOf(FeatureUnsupportedError);
  });

  it('listVersions returns [] when collection is 404', async () => {
    mockRequestUrl.mockReturnValueOnce(res(404));
    const versions = await makeClient().listVersions('123');
    expect(versions).toEqual([]);
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.method).toBe('PROPFIND');
    expect(call.url).toContain('/remote.php/dav/versions/alice/versions/123');
  });

  it('parses Nextcloud version metadata exposed by the versions DAV endpoint', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns">
        <d:response>
          <d:href>/remote.php/dav/versions/alice/versions/123/169000</d:href>
          <d:propstat><d:prop>
            <d:getlastmodified>Tue, 18 Jul 2023 10:00:00 GMT</d:getlastmodified>
            <d:getcontentlength>42</d:getcontentlength>
            <d:getcontenttype>text/markdown</d:getcontenttype>
            <d:getetag>"etag-v1"</d:getetag>
            <nc:version-label>Before restructure</nc:version-label>
            <nc:version-author>conny</nc:version-author>
            <nc:has-preview>true</nc:has-preview>
          </d:prop></d:propstat>
        </d:response>
      </d:multistatus>` }));

    const versions = await makeClient().listVersions('123');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      versionId: '169000',
      size: 42,
      label: 'Before restructure',
      author: 'conny',
      mimeType: 'text/markdown',
      etag: '"etag-v1"',
      hasPreview: true,
    });
    const body = mockRequestUrl.mock.calls[0][0].body as string;
    expect(body).toContain('nc:version-author');
    expect(body).toContain('nc:version-label');
  });

  it('restoreVersion issues MOVE to restore/target', async () => {
    mockRequestUrl.mockReturnValueOnce(res(201));
    const version: FileVersion = { versionId: '169000', href: '/v/123/169000', lastModified: 1, size: 10 };
    await makeClient().restoreVersion(version, '123');
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.method).toBe('MOVE');
    expect(call.headers?.Destination).toContain('/remote.php/dav/versions/alice/restore/target');
    expect(call.url).toContain('/remote.php/dav/versions/alice/versions/123/169000');
  });

  it('getVersionContent issues GET and returns buffer', async () => {
    const buf = new TextEncoder().encode('hello').buffer;
    mockRequestUrl.mockReturnValueOnce(res(200, { arrayBuffer: buf }));
    const version: FileVersion = { versionId: '169000', href: '/v/123/169000', lastModified: 1, size: 5 };
    const out = await makeClient().getVersionContent(version, '123');
    expect(new Uint8Array(out)).toEqual(new Uint8Array(buf));
    expect(mockRequestUrl.mock.calls[0][0].method).toBe('GET');
  });
});

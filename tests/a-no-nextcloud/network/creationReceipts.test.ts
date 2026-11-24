import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { DEFAULT_SETTINGS, PreconditionFailedError } from '../../../src/types';

const request = requestUrl as unknown as jest.Mock;
const settings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice', username: 'alice', deviceId: 'device-abcd1234',
};
const response = (status: number, headers: Record<string, string> = {}) =>
  Promise.resolve({ status, headers, text: '', json: {}, arrayBuffer: new ArrayBuffer(0) });
const client = () => new NextcloudClient(settings, () => 'pw', 'Vault');

beforeEach(() => request.mockReset());

describe('first-creation identity receipts', () => {
  it.each([
    [201, '00042ocabc123', true, '42'],
    [204, '00042ocabc123', true, null],
    [201, 'not-an-id', true, null],
    [201, '00042ocabc123', false, null],
  ])('reports only an acknowledged conditional PUT creation (%s, %s, %s)', async (status, id, conditional, expected) => {
    request.mockImplementation(() => response(status, { 'Oc-FiLeId': id }));
    const created = jest.fn();
    await client().uploadFile('note.md', new ArrayBuffer(1), undefined, {
      onlyIfAbsent: conditional, onCreatedFileId: created,
    });
    expect(request.mock.calls[0][0].headers['If-None-Match']).toBe(conditional ? '*' : undefined);
    expect(created.mock.calls).toEqual(expected ? [[expected]] : []);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([NextcloudClient, StandardWebDAVClient])('refuses a concurrent path creation in %p', async (Client) => {
    request.mockImplementation(() => response(412));
    const created = jest.fn();
    await expect(new Client(settings, () => 'pw', 'Vault').uploadFile('note.md', new ArrayBuffer(1), undefined, {
      onlyIfAbsent: true, onCreatedFileId: created,
    })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(request.mock.calls[0][0].headers['If-None-Match']).toBe('*');
    expect(created).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses only the assembling MOVE receipt for chunked creation', async () => {
    request.mockImplementation((req) => response(201, { 'oc-fileid': req.method === 'MOVE' ? '00051ocabc' : '00099ocabc' }));
    const created = jest.fn();
    await client().uploadChunked('note.bin', new ArrayBuffer(2), 1, {
      onlyIfAbsent: true, onCreatedFileId: created,
    });
    const move = request.mock.calls.map(([req]) => req).find((req) => req.method === 'MOVE');
    expect(move.headers.Overwrite).toBe('F');
    expect(move.headers['If-None-Match']).toBeUndefined();
    expect(created.mock.calls).toEqual([['51']]);
  });

  it.each([201, 405, 423, 0])('brackets only in-scope actual MKCOL attempts, status %s', async (status) => {
    request.mockImplementation((req) => {
      if (req.url.endsWith('/Vault')) return response(405);
      if (status === 0) return Promise.reject(new Error('offline'));
      return response(status, { 'OC-FileId': '00061ocabc' });
    });
    const c = client();
    const finished = jest.fn();
    const begin = jest.fn(() => finished);
    c.trackKnownDirectories({
      getDir: () => undefined,
      getRemoteRootFileId: () => null,
      setRemoteRootFileId: () => undefined,
    }, begin);
    await c.createDirectory('new folder').catch(() => undefined);
    expect(begin.mock.calls).toEqual([['new folder']]);
    expect(finished.mock.calls).toEqual([[status === 201 ? '61' : null]]);
    const requests = request.mock.calls.length;
    if (status === 201 || status === 405) {
      await c.createDirectory('new folder');
      expect(request).toHaveBeenCalledTimes(requests);
      expect(begin).toHaveBeenCalledTimes(1);
    }
  });
});

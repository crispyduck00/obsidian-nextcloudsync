import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, PreconditionFailedError } from '../../../src/types';
import { authHeaderOf, makeClient } from '../support/clientFactory';
import { describeLive, requireUser2 } from '../support/env';
import { textBuf, decodeBuf } from '../support/helpers';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';

describeLive('Shared Nextcloud mutations', getEnv => {
  let owner: NextcloudClient;
  let peer: NextcloudClient;
  let ws: IsolatedWorkspace;

  beforeAll(async () => {
    const env = getEnv();
    ({ client: owner, ws } = await setupWorkspace(env));
    peer = makeClient(env, ws.remoteBase);
    await peer.connect();
  });

  afterAll(async () => { if (owner && ws) await cleanupWorkspace(owner, ws); });

  it('protects a newer body against a stale conditional DELETE', async () => {
    await owner.uploadFile('delete-race.md', textBuf('original'));
    const original = (await owner.statFile('delete-race.md'))!;
    expect(original.etag).toBeTruthy();
    await peer.uploadFile('delete-race.md', textBuf('new body'));
    await expect(owner.deleteFile('delete-race.md', original.checksum ?? '', original.etag!)).rejects.toMatchObject({ status: 412 });
    expect(decodeBuf(await owner.downloadFile('delete-race.md'))).toBe('new body');
    const current = (await owner.statFile('delete-race.md'))!;
    await owner.deleteFile('delete-race.md', current.checksum ?? '', current.etag!);
    expect(await owner.statFile('delete-race.md')).toBeNull();
  });

  it('rejects a second create at the same path for both PUT and chunk assembly', async () => {
    await owner.uploadFile('new.md', textBuf('first device'), undefined, { onlyIfAbsent: true });
    await expect(peer.uploadFile('new.md', textBuf('second device'), undefined, { onlyIfAbsent: true }))
      .rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(peer.uploadChunked('new.md', textBuf('chunked device'), 4, { onlyIfAbsent: true }))
      .rejects.toBeInstanceOf(PreconditionFailedError);
    expect(decodeBuf(await owner.downloadFile('new.md'))).toBe('first device');
  });

  it('checks the destination ETag during chunk assembly', async () => {
    await owner.uploadFile('chunk.md', textBuf('old'));
    const original = (await owner.statFile('chunk.md'))!;
    await peer.uploadFile('chunk.md', textBuf('other device'));
    await expect(owner.uploadChunked('chunk.md', textBuf('do not overwrite'), 4, { ifMatchEtag: original.etag }))
      .rejects.toBeInstanceOf(PreconditionFailedError);
    expect(decodeBuf(await peer.downloadFile('chunk.md'))).toBe('other device');
    const current = (await owner.statFile('chunk.md'))!;
    await owner.uploadChunked('chunk.md', textBuf('confirmed update'), 4, { ifMatchEtag: current.etag });
    expect(decodeBuf(await peer.downloadFile('chunk.md'))).toBe('confirmed update');
  });

  it('detects a second account’s share mount and observes removal and regrant of visibility', async () => {
    const env = getEnv();
    const second = requireUser2(env);
    const recipient = new NextcloudClient({ ...DEFAULT_SETTINGS, serverUrl: second.serverUrl, username: second.username },
      () => second.password, '');
    const folder = `shared-${ws.remoteBase.split('/').at(-1)}`;
    await owner.createDirectory(folder);
    await owner.uploadFile(`${folder}/visible.md`, textBuf('owner data'));
    const endpoint = `${new URL(env.serverUrl).origin}/ocs/v2.php/apps/files_sharing/api/v1/shares`;
    const headers = { Authorization: authHeaderOf(env), 'OCS-APIRequest': 'true', Accept: 'application/json' };
    const grant = async (permissions: string): Promise<number> => {
      const response = await fetch(endpoint, {
        method: 'POST', headers, body: new URLSearchParams({ path: `/${ws.remoteBase}/${folder}`,
          shareType: '0', shareWith: second.username, permissions }),
      });
      const result = await response.json() as { ocs: { meta: { statuscode: number }; data: { id: number } } };
      expect(result.ocs.meta.statuscode).toBe(200);
      return result.ocs.data.id;
    };
    const shared = await grant('31');
    expect(await recipient.inspectDirectory(folder, true)).toMatchObject({ protected: true, fileId: expect.any(String) });
    expect(decodeBuf(await recipient.downloadFile(`${folder}/visible.md`))).toBe('owner data');
    const revoke = await fetch(`${endpoint}/${shared}`, { method: 'DELETE', headers });
    expect(revoke.ok).toBe(true);
    expect(await recipient.statFile(`${folder}/visible.md`)).toBeNull();
    expect(decodeBuf(await owner.downloadFile(`${folder}/visible.md`))).toBe('owner data');
    await grant('1');
    expect(await recipient.inspectDirectory(folder)).toMatchObject({ protected: true, fileId: expect.any(String) });
    expect(decodeBuf(await recipient.downloadFile(`${folder}/visible.md`))).toBe('owner data');
    await expect(recipient.uploadFile(`${folder}/visible.md`, textBuf('forbidden edit'))).rejects.toMatchObject({ status: 403 });
  });
});

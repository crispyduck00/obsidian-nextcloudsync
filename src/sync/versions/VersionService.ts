// Nextcloud account URLs only (not public link shares): both operations throw FeatureUnsupportedError elsewhere (the modal shows it).
// They take no part in a sync session: no summary, no history entry, no merge base.
import { FileVersion, FeatureUnsupportedError, NextcloudFeatures, RemoteFileInfo } from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { isSafeVaultRelativePath } from '../../network/remotePath';
import { withLocalSignature } from '../../data/localSignature';
import { sha256 } from '../../util/hash';

export interface VersionDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'atomicWriteBinary'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile' | 'save' | 'setRemoteRootEtag'>;
}

export class VersionService {
  constructor(private readonly deps: VersionDeps) {}

  async listVersions(client: IWebDAVClient, features: NextcloudFeatures, path: string): Promise<FileVersion[]> {
    const { fileId } = await this.verifyTarget(client, features, path);
    return (await client.listVersions(fileId)).map(version => ({ ...version, sourceFileId: fileId }));
  }

  async restoreVersion(
    client: IWebDAVClient, features: NextcloudFeatures, path: string, version: FileVersion,
  ): Promise<void> {
    const { fileId, current } = await this.verifyTarget(client, features, path, version);
    if (!current.etag) throw new Error('Nextcloud did not supply a revision for the current file. Run Sync now and retry.');

    this.deps.stateDB.setRemoteRootEtag(null);
    await client.restoreVersion(version, fileId, { path, etag: current.etag });
    const before = await client.statFile(path);
    if (before?.fileId !== fileId) throw new Error('The file changed while it was being restored. Run Sync now.');
    const data = await client.downloadFile(path);
    const after = await client.statFile(path);
    if (after?.fileId !== fileId || before.etag !== after.etag) {
      throw new Error('The file changed while it was being restored. Run Sync now.');
    }
    await this.deps.localAdapter.atomicWriteBinary(path, data);
    // Both hashes are the restored content's hash.
    const localHash = await sha256(data);
    const stat = await this.deps.localAdapter.stat(path);
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: stat?.size ?? data.byteLength, mtime: stat?.mtime ?? Date.now(),
      remoteFileId: fileId, isConflicted: false,
    }));
    await this.deps.stateDB.save();
  }

  // Account DAV can find a file ID after the object was moved out of the configured vault.
  private async verifyTarget(
    client: IWebDAVClient, features: NextcloudFeatures, path: string, version?: FileVersion,
  ): Promise<{ fileId: string; current: RemoteFileInfo }> {
    if (!features.isNextcloud || !features.hasAccountDav || !isSafeVaultRelativePath(path)) {
      throw new FeatureUnsupportedError('versions');
    }
    const fileId = this.deps.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');
    const current = await client.statFile(path);
    if (current?.fileId !== fileId || (version?.sourceFileId && version.sourceFileId !== fileId)) {
      this.deps.stateDB.setRemoteRootEtag(null);
      throw new Error('The file at this path has changed. Run Sync now and reopen version history.');
    }
    return { fileId, current };
  }
}

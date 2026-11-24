// Nextcloud account URLs only (not public link shares): both operations throw FeatureUnsupportedError elsewhere (the modal shows it).
// They take no part in a sync session: no summary, no history entry, no merge base.
import { FileVersion, FeatureUnsupportedError, NextcloudFeatures } from '../../types';
import { LocalAdapter, LocalFileChangedError } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { invalidateLocalSignature } from '../../data/localSignature';
import { sha256 } from '../../util/hash';

export interface VersionDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'readBinary' | 'atomicWriteBinary'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile' | 'save'>;
  canApplyRestore?(path: string): boolean;
}

export class VersionService {
  constructor(private readonly deps: VersionDeps) {}

  async listVersions(client: IWebDAVClient, features: NextcloudFeatures, path: string): Promise<FileVersion[]> {
    const fileId = this.requireFileId(features, path);
    return client.listVersions(fileId);
  }

  async restoreVersion(
    client: IWebDAVClient, features: NextcloudFeatures, path: string, version: FileVersion,
  ): Promise<void> {
    const fileId = this.requireFileId(features, path);
    const canWrite = () => this.deps.canApplyRestore?.(path) !== false;
    if (!canWrite()) throw new LocalFileChangedError(path);
    const { localAdapter, stateDB } = this.deps;
    const stat = await localAdapter.stat(path);
    const hash = stat ? await sha256(await localAdapter.readBinary(path)) : undefined;

    await client.restoreVersion(version, fileId);
    const data = await client.downloadFile(path);
    try {
      await localAdapter.atomicWriteBinary(path, data, undefined, undefined, { stat, hash, canWrite });
    } catch (err) {
      if (!(err instanceof LocalFileChangedError)) throw err;
      invalidateLocalSignature(stateDB, path);
      await stateDB.save();
      throw new Error(`Nextcloud restored the version, but the local edit was kept. ${err.message} Run Sync now.`, { cause: err });
    }

    // The next sync hashes the local file so an edit just after the commit cannot inherit this baseline.
    const localHash = await sha256(data);
    stateDB.setFile({
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: data.byteLength, mtime: stat?.mtime ?? Date.now(),
      remoteFileId: fileId, isConflicted: false,
    });
    await stateDB.save();
  }

  // Versions are addressed by fileId and live in the account-only versions namespace, which a public link share lacks.
  private requireFileId(features: NextcloudFeatures, path: string): string {
    if (!features.isNextcloud || !features.hasAccountDav) throw new FeatureUnsupportedError('versions');
    const fileId = this.deps.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');
    return fileId;
  }
}

// Nextcloud account URLs only (not public link shares): both operations throw FeatureUnsupportedError elsewhere (the modal shows it).
// Restore converges remote identity and the shared merge base before reporting success.
import { FileVersion, FeatureUnsupportedError, NextcloudFeatures } from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { withLocalSignature } from '../../data/localSignature';
import { sha256 } from '../../util/hash';
import { remoteIdOf } from '../remoteIdentity';
import type { RemoteFileInfo } from '../../types';
import type { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { isAnomalousRemoteContent } from '../../util/limits';

export interface VersionDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'atomicWriteBinary'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile' | 'save' | 'setRemoteRootEtag'>;
  mergeBase?: Pick<MergeBaseRecorder, 'recordBytes'>;
  flushMergeBase?(): Promise<void>;
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

    await client.restoreVersion(version, fileId);
    // GET and PROPFIND are separate requests: a concurrent remote edit must not pair one body's
    // hash with another version's ETag. Read a stable identity around GET, retry once, then fail
    // without replacing the local file. The next full scan recovers the changed remote tree.
    const { data, remote } = await this.readRestoredFile(client, path, fileId);

    await this.deps.localAdapter.atomicWriteBinary(path, data);

    // 3. Converge StateDB to the same identity model used by normal sync classification.
    const localHash = await sha256(data);
    const { remoteId, idType } = remoteIdOf(remote);
    const stat = await this.deps.localAdapter.stat(path);
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path,
      localHash,
      remoteId,
      idType,
      size: remote.size || stat?.size || data.byteLength,
      mtime: remote.lastModified || stat?.mtime || Date.now(),
      remoteFileId: remote.fileId ?? fileId,
      isConflicted: false,
    }, remote.lastModified));
    this.deps.mergeBase?.recordBytes(path, data);
    // Persist the common base before the StateDB calls the restore converged. A crash must not
    // leave the old base paired with a newly saved restored baseline.
    await this.deps.flushMergeBase?.();
    await this.deps.stateDB.save();
  }

  private async readRestoredFile(
    client: IWebDAVClient, path: string, expectedFileId: string,
  ): Promise<{ data: ArrayBuffer; remote: RemoteFileInfo }> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await client.statFile(path);
        if (!before || (before.fileId !== null && before.fileId !== expectedFileId)) break;
        const data = await client.downloadFile(path);
        const after = await client.statFile(path);
        if (!after || (after.fileId !== null && after.fileId !== expectedFileId)) break;
        const stable = remoteIdOf(before).remoteId === remoteIdOf(after).remoteId
          && before.fileId === after.fileId && before.etag === after.etag && before.size === after.size
          && before.lastModified === after.lastModified;
        // Obsidian's iOS requestUrl can return a different nonzero byte length (docs/spec.md §9.2).
        // Match upstream's empty-body guard; stable server identity supplies the coherence proof.
        if (!stable || isAnomalousRemoteContent(after.size, data.byteLength) || (!after.checksum && !after.etag)) continue;
        return { data, remote: after };
      }
      throw new Error('Restored file changed while it was being read; run Sync now and retry.');
    } catch (err) {
      this.deps.stateDB.setRemoteRootEtag(null);
      throw err;
    }
  }

  // Versions are addressed by fileId and live in the account-only versions namespace, which a public link share lacks.
  private requireFileId(features: NextcloudFeatures, path: string): string {
    if (!features.isNextcloud || !features.hasAccountDav) throw new FeatureUnsupportedError('versions');
    const fileId = this.deps.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');
    return fileId;
  }
}

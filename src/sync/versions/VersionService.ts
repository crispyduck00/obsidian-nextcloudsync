// Nextcloud version history, lifted out of SyncEngine (upstream change, Phase 5).
//
// This service stays outside normal sync sessions. History reads are read-only; only restore mutates
// the server/local file. Enhanced history builds exclusively on Nextcloud's versions DAV endpoint
// and the tracked remote file id — no Activity API or path-based author heuristics.
// Restore also converges the remote identity and persisted common merge base.
import { FileVersion, FeatureUnsupportedError, NextcloudFeatures } from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { withLocalSignature } from '../../data/localSignature';
import { sha256 } from '../../util/hash';
import { LineHistoryResult, reconstructLineHistory, VersionSnapshot } from './lineHistory';
import { chronologicalVersionTimeline } from './versionTimeline';

import { remoteIdOf } from '../remoteIdentity';
import type { RemoteFileInfo } from '../../types';
import type { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { isAnomalousRemoteContent } from '../../util/limits';

export interface VersionDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'atomicWriteBinary'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile' | 'save' | 'setRemoteRootEtag'>;
  mergeBase?: Pick<MergeBaseRecorder, 'recordBytes'>;
  flushMergeBase?(): Promise<void>;
  isTextEligible?(path: string): boolean;
}

export interface VersionComparison {
  before: FileVersion;
  after: FileVersion;
  beforeText: string;
  afterText: string;
}

export class VersionService {
  constructor(private readonly deps: VersionDeps) {}

  /**
   * Return Nextcloud's retained versions, newest first, and identify the entry that represents the
   * current remote file. Nextcloud includes that current revision in the versions collection.
   */
  async listVersions(client: IWebDAVClient, features: NextcloudFeatures, path: string): Promise<FileVersion[]> {
    const fileId = this.requireFileId(features, path);
    const versions = await client.listVersions(fileId);
    const current = await client.statFile(path);
    if (!current || current.lastModified <= 0) return versions;

    const currentRevision = String(Math.floor(current.lastModified / 1000));
    let found = false;
    const marked = versions.map((version) => {
      const sameRevision = version.versionId === currentRevision
        || Math.floor(version.lastModified / 1000) === Math.floor(current.lastModified / 1000);
      if (sameRevision && !found) {
        found = true;
        return { ...version, isCurrent: true };
      }
      return { ...version, isCurrent: false };
    });

    const withCurrent = found
      ? marked
      : [{
          versionId: `current-${currentRevision}`,
          href: '',
          lastModified: current.lastModified,
          size: current.size,
          author: null,
          label: '',
          mimeType: '',
          etag: current.etag ?? undefined,
          isCurrent: true,
        }, ...marked];

    return this.addCurrentRevisionAnchor(withCurrent);
  }

  /**
   * A restore can make an old revision the live Current state while newer pre-restore revisions
   * remain retained. Core files_versions may consume the restored source file, so that old state
   * otherwise disappears from chronological browsing/provenance. Represent its historical position
   * with a virtual, non-restorable anchor backed by the live Current body.
   */
  private addCurrentRevisionAnchor(versions: FileVersion[]): FileVersion[] {
    const current = versions.find((version) => version.isCurrent);
    if (!current) return versions;
    const newerHistoricalExists = versions.some((version) =>
      !version.isCurrent && version.lastModified > current.lastModified,
    );
    if (!newerHistoricalExists) return versions;

    const anchor: FileVersion = {
      ...current,
      versionId: `current-anchor-${Math.floor(current.lastModified / 1000)}`,
      isCurrent: false,
      isCurrentRevisionAnchor: true,
      href: '',
    };
    return [...versions, anchor];
  }

  /** Compare two retained revisions (or one retained revision with current). Read-only. */
  async compareVersions(
    client: IWebDAVClient, features: NextcloudFeatures, path: string,
    before: FileVersion, after: FileVersion,
  ): Promise<VersionComparison> {
    if (!this.deps.isTextEligible?.(path)) {
      throw new Error('Version compare is available for text files only.');
    }
    const fileId = this.requireFileId(features, path);
    const [beforeData, afterData] = await Promise.all([
      this.readVersionData(client, path, fileId, before),
      this.readVersionData(client, path, fileId, after),
    ]);
    return {
      before,
      after,
      beforeText: new TextDecoder().decode(beforeData),
      afterText: new TextDecoder().decode(afterData),
    };
  }

  /**
   * Reconstruct the current file's line provenance from the RETAINED Nextcloud snapshots only.
   * Lazy by design: no old version body is downloaded until the user opens Line history.
   */
  async lineHistory(
    client: IWebDAVClient, features: NextcloudFeatures, path: string,
    listedVersions: FileVersion[], targetVersion: FileVersion,
  ): Promise<LineHistoryResult> {
    if (!this.deps.isTextEligible?.(path)) {
      throw new Error('Line history is available for text files only.');
    }
    const fileId = this.requireFileId(features, path);
    const timeline = chronologicalVersionTimeline(listedVersions);
    const targetIndex = timeline.findIndex((version) =>
      version.versionId === targetVersion.versionId && version.isCurrent === targetVersion.isCurrent,
    );
    if (targetIndex < 0) throw new Error('Selected version is no longer available.');

    // Historical targets stop at that retained revision. Current is different: it is the latest
    // STATE even when a restore gave it an old mtime, so its lineage always includes every retained
    // historical snapshot followed by the live Current body.
    const ordered = timeline.slice(0, targetIndex + 1);
    const snapshots: VersionSnapshot[] = [];
    let liveCurrentText: string | null = null;
    for (const version of ordered) {
      let text: string;
      if ((version.isCurrent || version.isCurrentRevisionAnchor) && liveCurrentText !== null) {
        text = liveCurrentText;
      } else {
        const data = await this.readVersionData(client, path, fileId, version);
        text = new TextDecoder().decode(data);
        if (version.isCurrent || version.isCurrentRevisionAnchor) liveCurrentText = text;
      }
      snapshots.push({ version, text });
      // Yield between downloads/diffs so opening history for a deep file does not monopolize Android.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }

    if (targetVersion.isCurrent) {
      const currentSnapshot = snapshots[snapshots.length - 1];
      if (currentSnapshot?.version.isCurrent) {
        // A restored Current may exactly equal an older retained (Group Folders) or virtual
        // current-revision state (core user storage). Line provenance describes where the CURRENT
        // content can first be traced, not every state transition that happened after that content
        // existed. In that case stop at the earliest exact historical match.
        const matchIndex = snapshots.findIndex((snapshot, index) =>
          index < snapshots.length - 1 && snapshot.text === currentSnapshot.text,
        );
        if (matchIndex >= 0) return reconstructLineHistory(snapshots.slice(0, matchIndex + 1));
      }
    }

    return reconstructLineHistory(snapshots);
  }

  /** Read one retained revision (or Current) as text for the read-only version browser. */
  async readVersionText(
    client: IWebDAVClient, features: NextcloudFeatures, path: string, version: FileVersion,
  ): Promise<string> {
    if (!this.deps.isTextEligible?.(path)) {
      throw new Error('Version browser is available for text files only.');
    }
    const fileId = this.requireFileId(features, path);
    const data = await this.readVersionData(client, path, fileId, version);
    return new TextDecoder().decode(data);
  }

  /** Restore the specified historical version, apply it locally, and update the state DB. */
  async restoreVersion(
    client: IWebDAVClient, features: NextcloudFeatures, path: string, version: FileVersion,
  ): Promise<void> {
    if (version.isCurrent || version.isCurrentRevisionAnchor) return;
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

  private readVersionData(
    client: IWebDAVClient, path: string, fileId: string, version: FileVersion,
  ): Promise<ArrayBuffer> {
    return version.isCurrent || version.isCurrentRevisionAnchor
      ? client.downloadFile(path)
      : client.getVersionContent(version, fileId);
  }

  // Versions are addressed by fileId and live in the account-only versions namespace, which a public link share lacks.
  private requireFileId(features: NextcloudFeatures, path: string): string {
    if (!features.isNextcloud || !features.hasAccountDav) throw new FeatureUnsupportedError('versions');
    const fileId = this.deps.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');
    return fileId;
  }
}

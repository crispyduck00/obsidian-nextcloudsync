import { App, normalizePath } from 'obsidian';
import { IWebDAVClient, RemoteDirectoryInspection } from '../../network/IWebDAVClient';
import { isSafeVaultRelativePath } from '../../network/remotePath';
import { StateDB } from '../../data/StateDB';
import { RemoteDirInfo, SyncSessionSummary } from '../../types';
import { ancestorMatching, parentDir } from '../policy';

/** A local folder operation can emit child events before the folder event. Check the absent ancestor itself. */
export class RemoteFolderGuard {
  private readonly checks = new WeakMap<SyncSessionSummary, Map<string, Promise<RemoteDirectoryInspection | null>>>();

  constructor(private readonly app: App, private readonly state: Pick<StateDB, 'getDir'>) {}

  async assertRemovalAllowed(
    client: IWebDAVClient, path: string, directory = false, summary?: SyncSessionSummary,
    isExcluded?: (path: string) => boolean,
  ): Promise<void> {
    if (!isSafeVaultRelativePath(path)) throw new Error('The path is outside the vault.');
    if (!client.inspectDirectory) {
      if (isExcluded) {
        const [files, dirs] = await Promise.all([client.getFiles(path), client.getDirectories(path)]);
        if ([...files, ...dirs].some(entry => isExcluded(entry.path))) {
          throw new Error(`Folder ${path} contains paths outside the sync scope.`);
        }
      }
      return;
    }
    let target = directory ? path : '';
    for (let parent = parentDir(path); parent; parent = parentDir(parent)) {
      // The vault index may still contain a folder after its children emitted delete events.
      const stat = await this.app.vault.adapter.stat(normalizePath(parent));
      if (stat?.type === 'folder') break;
      target = parent;
    }
    if (!target) return;
    let checks = summary && this.checks.get(summary);
    if (summary && !checks) {
      checks = new Map();
      this.checks.set(summary, checks);
    }
    let check = checks?.get(target);
    if (!check) {
      const scan = client.inspectDirectory.bind(client);
      check = scan(target).then(result => !result || result.protected ? result : scan(target, true, isExcluded));
      checks?.set(target, check);
    }
    const result = await check;
    const expectedId = this.state.getDir(target)?.remoteFileId;
    if (!result || result.protected || (expectedId && result.fileId !== expectedId)) {
      throw new Error(`Folder ${target} is protected or inaccessible on Nextcloud. Its remote contents were kept.`);
    }
  }
}

/** A different collection at the same path may be a replacement for a revoked mount. */
export function replacedRemoteFolders(
  listed: readonly RemoteDirInfo[], state: Pick<StateDB, 'getDir'>, isExcluded: (path: string) => boolean,
): Set<string> {
  const replaced = new Set<string>();
  for (const dir of listed) {
    const path = dir.path.replace(/\/+$/, '');
    const previous = state.getDir(path)?.remoteFileId;
    if (previous && dir.fileId && previous !== dir.fileId && !isExcluded(path)) replaced.add(path);
  }
  return replaced;
}

/** Do not let a missing tracked parent be recreated by PUT, MOVE or MKCOL. */
export async function assertTrackedParentReadable(
  client: IWebDAVClient, state: Pick<StateDB, 'getDir'> & Partial<Pick<StateDB, 'getRemoteRootFileId'>>,
  path: string, includeSelf = false,
): Promise<void> {
  const rootFileId = state.getRemoteRootFileId?.();
  const tracked = includeSelf && state.getDir(path) ? path : ancestorMatching(path, p => !!state.getDir(p));
  const parent = tracked ?? (rootFileId ? '' : undefined);
  if (parent === undefined) return;
  const expected = parent ? state.getDir(parent)?.remoteFileId : rootFileId;
  const current = client.inspectDirectory ? await client.inspectDirectory(parent) : await client.remoteExists(parent);
  if (!current || (typeof current !== 'boolean' && expected && current.fileId !== expected)) {
    throw new Error(`The remote ${parent ? `folder ${parent}` : 'vault folder'} is missing, inaccessible or a different collection. Local changes were kept.`);
  }
}

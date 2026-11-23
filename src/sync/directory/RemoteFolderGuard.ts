import { App, normalizePath } from 'obsidian';
import { IWebDAVClient, RemoteDirectoryInspection } from '../../network/IWebDAVClient';
import { isSafeVaultRelativePath } from '../../network/remotePath';
import { StateDB } from '../../data/StateDB';
import { SyncSessionSummary } from '../../types';
import { ancestorMatching, parentDir } from '../policy';

/** A local folder operation can emit child events before the folder event. Check the absent ancestor itself. */
export class RemoteFolderGuard {
  private readonly checks = new WeakMap<SyncSessionSummary, Map<string, Promise<RemoteDirectoryInspection | null>>>();

  constructor(private readonly app: App, private readonly state: Pick<StateDB, 'getDir'>) {}

  async assertRemovalAllowed(client: IWebDAVClient, path: string, directory = false, summary?: SyncSessionSummary): Promise<void> {
    if (!isSafeVaultRelativePath(path)) throw new Error('The path is outside the vault.');
    if (!client.inspectDirectory) return;
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
      check = scan(target).then(result => !result || result.protected ? result : scan(target, true));
      checks?.set(target, check);
    }
    const result = await check;
    const expectedId = this.state.getDir(target)?.remoteFileId;
    if (!result || result.protected || (expectedId && result.fileId !== expectedId)) {
      throw new Error(`Folder ${target} is protected or inaccessible on Nextcloud. Its remote contents were kept.`);
    }
  }
}

/** Do not let a missing tracked parent be recreated by PUT, MOVE or MKCOL. */
export async function assertTrackedParentReadable(
  client: IWebDAVClient, state: Pick<StateDB, 'getDir'>, path: string, includeSelf = false,
): Promise<void> {
  const parent = includeSelf && state.getDir(path) ? path : ancestorMatching(path, p => !!state.getDir(p));
  if (!parent) return;
  const present = client.inspectDirectory ? await client.inspectDirectory(parent) : await client.remoteExists(parent);
  if (!present) throw new Error(`Folder ${parent} is missing or inaccessible on Nextcloud. Local changes were kept.`);
}

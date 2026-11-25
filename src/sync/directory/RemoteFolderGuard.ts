import { IWebDAVClient } from '../../network/IWebDAVClient';
import { StateDB } from '../../data/StateDB';
import { ancestorMatching } from '../policy';

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

import type { StateDB } from '../../data/StateDB';
import type { MergeBaseStore } from '../../data/MergeBaseStore';
import type { CleanSideStore } from '../../data/CleanSideStore';
import { inFolder } from '../PendingFolderMoves';

export async function prepareFolderMoveTracking(state: StateDB, source: string, destination: string,
  bases?: MergeBaseStore, snapshots?: CleanSideStore): Promise<{ commit(): void; cleanOldCaches(): void }> {
  const files = state.getAllFiles().filter(file => inFolder(file.path, source));
  const dirs = state.getAllDirs().filter(dir => inFolder(dir.path, source));
  const target = (path: string): string => destination + path.slice(source.length);
  for (const file of files) {
    const next = target(file.path);
    const base = bases?.get(file.path);
    if (base === undefined) bases?.delete(next);
    else bases?.set(next, base);
    const snapshot = snapshots?.get(file.path);
    if (!snapshot) snapshots?.delete(next);
    else snapshots?.set(next, snapshot);
  }
  if (files.length) await Promise.all([bases?.save(), snapshots?.save()]);
  return {
    commit: () => {
      for (const file of files) {
        state.deleteFile(file.path);
        state.setFile({ ...file, path: target(file.path) });
      }
      for (const dir of dirs) {
        state.deleteDir(dir.path);
        state.setDir({ ...dir, path: target(dir.path) });
      }
      state.setSyncToken(null);
      state.setRemoteRootEtag(null);
    },
    cleanOldCaches: () => {
      for (const file of files) {
        bases?.delete(file.path);
        snapshots?.delete(file.path);
      }
      if (files.length) {
        bases?.requestSave();
        snapshots?.requestSave();
      }
    },
  };
}

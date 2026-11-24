import { App, TFolder, normalizePath } from 'obsidian';
import { isSafeVaultRelativePath } from '../../network/remotePath';

/** Non-recursive even if a file arrives between the listing and rmdir. */
export async function removeEmptyLocalDirectory(app: App, path: string, markOwnEvent: (path: string, deletion?: boolean) => void): Promise<boolean> {
  if (!isSafeVaultRelativePath(path)) return false;
  const adapter = app.vault.adapter;
  const normalized = normalizePath(path);
  const folder = app.vault.getAbstractFileByPath(path);
  if (!(folder instanceof TFolder)) return !(await adapter.exists(normalized));
  const { files, folders } = await adapter.list(normalized);
  if (files.length || folders.length) return false;
  markOwnEvent(path, true);
  await adapter.rmdir(normalized, false);
  return true;
}

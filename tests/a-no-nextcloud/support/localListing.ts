// Immediate directory entries for the small map-backed engine fixtures. File
// ancestors exist implicitly, matching their stat/read behavior.
export function localListing(parent: string, filePaths: Iterable<string>, folderPaths: Iterable<string> = []): { files: string[]; folders: string[] } {
  const files = [...filePaths];
  const folders = new Set(folderPaths);
  for (const path of [...files, ...folders]) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const parentOf = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return { files: files.filter(path => parentOf(path) === parent), folders: [...folders].filter(path => parentOf(path) === parent) };
}

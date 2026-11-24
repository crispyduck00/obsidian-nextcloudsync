import { assertUnambiguousLocalPaths, LocalPathIdentityError } from '../../../src/sync/scan/localPathIdentity';

function filesystem(entries: string[], aliases = false) {
  const directories = new Set<string>();
  for (const path of entries) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  return {
    stat: jest.fn(async (path: string) => entries.some(entry => aliases
      ? entry.toLowerCase() === path.toLowerCase() : entry === path) ? { size: 10, mtime: 1 } : null),
    list: jest.fn(async (parent: string) => {
      const parentOf = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      return {
        files: entries.filter(path => parentOf(path) === parent),
        folders: [...directories].filter(path => parentOf(path) === parent),
      };
    }),
  };
}

it('does no additional filesystem work for unchanged path sets', async () => {
  const paths = Array.from({ length: 1000 }, (_, i) => `Notes/${i}.md`);
  const adapter = filesystem(paths);
  await assertUnambiguousLocalPaths(adapter, paths, [...paths].reverse());
  expect(adapter.stat).not.toHaveBeenCalled();
  expect(adapter.list).not.toHaveBeenCalled();
});

it('accepts genuine remote creates and local deletions without directory scans', async () => {
  const adapter = filesystem([]);
  await assertUnambiguousLocalPaths(adapter, ['deleted.md'], ['new.md']);
  expect(adapter.stat).toHaveBeenCalledTimes(2);
  expect(adapter.list).not.toHaveBeenCalled();
});

it.each([
  ['note.md', 'note.md', 'Note.md'],
  ['Note.md', 'note.md', 'Note.md'],
  ['Folder/Sub/note.md', 'Folder/Sub/note.md', 'folder/Sub/note.md'],
  ['Folder/Sub/note.md', 'Folder/Sub/note.md', 'Folder/sub/note.md'],
])('stops an existing alias: actual=%s, Vault=%s, remote=%s', async (actual, local, remote) => {
  const adapter = filesystem([actual], true);
  await expect(assertUnambiguousLocalPaths(adapter, [local], [remote]))
    .rejects.toThrow('Sync stopped before changing files');
});

it('accepts two physically distinct case variants', async () => {
  const adapter = filesystem(['note.md', 'Note.md']);
  await assertUnambiguousLocalPaths(adapter, ['note.md'], ['Note.md']);
  expect(adapter.list).toHaveBeenCalledTimes(1);
});

it('accepts an explicitly corrected local spelling', async () => {
  const adapter = filesystem(['Note.md'], true);
  await assertUnambiguousLocalPaths(adapter, ['Note.md'], ['Note.md']);
  expect(adapter.list).not.toHaveBeenCalled();
});

it('preserves distinct names and their exact Unicode spellings', async () => {
  const paths = ['Notes/Cafe\u0301.md', 'Notes/Café-other.md', 'Notes/ A #1.md'];
  const adapter = filesystem(paths);
  await assertUnambiguousLocalPaths(adapter, paths, []);
  expect(adapter.stat).toHaveBeenCalledTimes(3);
  expect(adapter.list).toHaveBeenCalledTimes(2);
});

it('reads each needed directory only once within a preflight', async () => {
  const paths = Array.from({ length: 20 }, (_, i) => `Projects/Team/${i}.md`);
  const adapter = filesystem(paths);
  await assertUnambiguousLocalPaths(adapter, paths, []);
  expect(adapter.list.mock.calls.map(([path]) => path)).toEqual(['', 'Projects', 'Projects/Team']);
});

it('keeps filesystem read failures visible rather than interpreting them as absence', async () => {
  const adapter = filesystem(['note.md']);
  adapter.list.mockRejectedValue(new Error('Filesystem unavailable'));
  await expect(assertUnambiguousLocalPaths(adapter, ['note.md'], []))
    .rejects.toThrow('Filesystem unavailable');
  await expect(assertUnambiguousLocalPaths(adapter, ['note.md'], []))
    .rejects.not.toBeInstanceOf(LocalPathIdentityError);
});

it('identifies a proven alias as a manual repair, not a transient I/O failure', async () => {
  await expect(assertUnambiguousLocalPaths(filesystem(['note.md'], true), ['note.md'], ['Note.md']))
    .rejects.toBeInstanceOf(LocalPathIdentityError);
});

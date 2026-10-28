import { FileVersion } from '../../../src/types';
import { reconstructLineHistory, VersionSnapshot } from '../../../src/sync/versions/lineHistory';

function version(id: string, at: number, author: string | null): FileVersion {
  return { versionId: id, href: `/v/${id}`, lastModified: at, size: 1, author };
}

function snap(v: FileVersion, text: string): VersionSnapshot {
  return { version: v, text };
}

describe('retained Nextcloud line history', () => {
  it('keeps unchanged lines attributed to the oldest retained version where they are visible', () => {
    const a = version('1', 1000, 'andi');
    const b = version('2', 2000, 'conny');
    const current = { ...version('3', 3000, 'andi'), isCurrent: true };

    const result = reconstructLineHistory([
      snap(a, 'one\ntwo'),
      snap(b, 'one\ninserted\ntwo'),
      snap(current, 'one\ninserted\ntwo\ncurrent'),
    ]);

    expect(result.lines.map((l) => [l.text, l.version.versionId])).toEqual([
      ['one', '1'],
      ['inserted', '2'],
      ['two', '1'],
      ['current', '3'],
    ]);
    expect(result.versionCount).toBe(3);
    expect(result.oldestVersionTime).toBe(1000);
    expect(result.approximate).toBe(false);
  });

  it('attributes a changed line to the newer available version, not to the previous author', () => {
    const a = version('1', 1000, 'andi');
    const b = version('2', 2000, 'conny');

    const result = reconstructLineHistory([
      snap(a, 'title\nold text'),
      snap(b, 'title\nnew text'),
    ]);

    expect(result.lines[0].version.author).toBe('andi');
    expect(result.lines[1].version.author).toBe('conny');
  });

  it('preserves the caller supplied logical lineage instead of re-sorting by mtime', () => {
    const a = version('1', 1000, 'andi');
    const b = version('2', 2000, 'conny');

    const result = reconstructLineHistory([
      snap(b, 'a\nb'),
      snap(a, 'a'),
    ]);

    expect(result.lines.map((l) => [l.text, l.version.versionId])).toEqual([
      ['a', '2'],
    ]);
  });

  it('keeps restored Current as the final target even when its mtime is older than retained history', () => {
    const old = version('old', 1000, 'andi');
    const later = version('later', 3000, 'andi');
    const current = { ...version('current', 1000, 'andi'), isCurrent: true };

    const result = reconstructLineHistory([
      snap(old, 'kept\nold-only'),
      snap(later, 'kept\nlater-only'),
      snap(current, 'kept\nrestored-only'),
    ]);

    expect(result.lines.map((l) => l.text)).toEqual(['kept', 'restored-only']);
    expect(result.lines.some((l) => l.text === 'later-only')).toBe(false);
  });
});

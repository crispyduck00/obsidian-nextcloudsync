import { buildVersionUnifiedDiffRows } from '../../../src/ui/versionUnifiedDiff';

describe('mobile unified version diff', () => {
  it('renders unchanged lines once and changes as removal/addition', () => {
    const rows = buildVersionUnifiedDiffRows(
      'same\nold\nend',
      'same\nnew\nend',
    );

    expect(rows).toEqual([
      { type: 'same', oldLine: 1, newLine: 1, text: 'same' },
      { type: 'del', oldLine: 2, text: 'old' },
      { type: 'add', newLine: 2, text: 'new' },
      { type: 'same', oldLine: 3, newLine: 3, text: 'end' },
    ]);
  });

  it('keeps line numbers independent for insertions', () => {
    const rows = buildVersionUnifiedDiffRows(
      'a\nc',
      'a\nb\nc',
    );

    expect(rows).toEqual([
      { type: 'same', oldLine: 1, newLine: 1, text: 'a' },
      { type: 'add', newLine: 2, text: 'b' },
      { type: 'same', oldLine: 2, newLine: 3, text: 'c' },
    ]);
  });
});

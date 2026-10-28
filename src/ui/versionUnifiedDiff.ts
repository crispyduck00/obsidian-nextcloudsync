export type VersionUnifiedDiffType = 'same' | 'del' | 'add';

export interface VersionUnifiedDiffRow {
  type: VersionUnifiedDiffType;
  oldLine?: number;
  newLine?: number;
  text: string;
}

/**
 * Git-like unified line diff used only by the version-history mobile view.
 * Existing shared diff rendering stays untouched.
 */
export function buildVersionUnifiedDiffRows(beforeText: string, afterText: string): VersionUnifiedDiffRow[] {
  const before = beforeText.split('\n');
  const after = afterText.split('\n');
  const m = before.length;
  const n = after.length;

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: VersionUnifiedDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (before[i] === after[j]) {
      rows.push({ type: 'same', oldLine: i + 1, newLine: j + 1, text: before[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', oldLine: i + 1, text: before[i] });
      i++;
    } else {
      rows.push({ type: 'add', newLine: j + 1, text: after[j] });
      j++;
    }
  }
  while (i < m) {
    rows.push({ type: 'del', oldLine: i + 1, text: before[i] });
    i++;
  }
  while (j < n) {
    rows.push({ type: 'add', newLine: j + 1, text: after[j] });
    j++;
  }

  return rows;
}

/** Render one unified stream: unchanged lines once, removals with −, additions with +. */
export function renderVersionUnifiedDiff(
  container: HTMLElement, beforeText: string, afterText: string,
): HTMLElement | null {
  const rows = buildVersionUnifiedDiffRows(beforeText, afterText);
  let firstChanged: HTMLElement | null = null;

  for (const row of rows) {
    const el = container.createDiv({ cls: 'ncs-version-unified-row' });
    if (row.type !== 'same') {
      el.addClass(row.type === 'add' ? 'is-add' : 'is-del');
      firstChanged ??= el;
    }

    el.createDiv({ text: row.oldLine ? String(row.oldLine) : '', cls: 'ncs-version-unified-num' });
    el.createDiv({ text: row.newLine ? String(row.newLine) : '', cls: 'ncs-version-unified-num' });
    el.createDiv({
      text: row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ',
      cls: 'ncs-version-unified-marker',
    });
    el.createDiv({ text: row.text || ' ', cls: 'ncs-version-unified-text' });
  }

  return firstChanged;
}

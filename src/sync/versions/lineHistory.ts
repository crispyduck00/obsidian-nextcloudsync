import { FileVersion } from '../../types';

export interface VersionSnapshot {
  version: FileVersion;
  text: string;
}

export interface LineHistoryLine {
  lineNumber: number;
  text: string;
  /** Retained Nextcloud version in which this current line first appears in the available history. */
  version: FileVersion;
}

export interface LineHistoryResult {
  lines: LineHistoryLine[];
  versionCount: number;
  /** Timestamp of the oldest retained snapshot that participated, even if none of its lines survive. */
  oldestVersionTime: number | null;
  /** True when a bounded-memory fallback was needed for at least one very large comparison. */
  approximate: boolean;
}

const MAX_LCS_CELLS = 1_500_000;

function splitLines(text: string): string[] {
  // Keep the same line model as the existing diff UI. An empty document has one empty line.
  return text.split('\n');
}

/**
 * Return exact-line LCS pairs [oldIndex, newIndex].
 *
 * The full DP table gives stable attribution for ordinary notes. For very large documents it can
 * be too expensive on Android, so callers switch to the bounded-memory ordered matcher below.
 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> | null {
  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) return null;

  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(n + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Bounded-memory fallback for unusually large notes. It only preserves identical lines in forward
 * order; unmatched lines are conservatively attributed to the newer available version.
 */
function orderedExactPairs(a: string[], b: string[]): Array<[number, number]> {
  const positions = new Map<string, number[]>();
  for (let i = 0; i < a.length; i++) {
    const list = positions.get(a[i]) ?? [];
    list.push(i);
    positions.set(a[i], list);
  }

  const cursors = new Map<string, number>();
  const pairs: Array<[number, number]> = [];
  let lastOld = -1;
  for (let j = 0; j < b.length; j++) {
    const list = positions.get(b[j]);
    if (!list) continue;
    let cursor = cursors.get(b[j]) ?? 0;
    while (cursor < list.length && list[cursor] <= lastOld) cursor++;
    if (cursor >= list.length) continue;
    const oldIndex = list[cursor];
    cursors.set(b[j], cursor + 1);
    lastOld = oldIndex;
    pairs.push([oldIndex, j]);
  }
  return pairs;
}

/**
 * Reconstruct line provenance from the retained Nextcloud snapshots.
 *
 * This is deliberately NOT Git blame: an unchanged exact line keeps the oldest retained attribution
 * we can still prove; a line newly appearing between two retained snapshots is attributed to the
 * newer VERSION (and therefore shown with that version's author). Missing/pruned intermediate
 * versions cannot be reconstructed.
 */
export function reconstructLineHistory(snapshots: VersionSnapshot[]): LineHistoryResult {
  if (snapshots.length === 0) {
    return { lines: [], versionCount: 0, oldestVersionTime: null, approximate: false };
  }

  // The caller supplies the LOGICAL state lineage. Do not sort by mtime here: Current may
  // legitimately carry an old restored timestamp while still being the final state. Re-sorting
  // would move Current into the historical chain and make later retained snapshots become the
  // apparent target, surfacing lines that are not present in Current at all.
  const ordered = snapshots;
  let previousLines = splitLines(ordered[0].text);
  let attribution: FileVersion[] = previousLines.map(() => ordered[0].version);
  let approximate = false;

  for (let s = 1; s < ordered.length; s++) {
    const nextLines = splitLines(ordered[s].text);
    const exactPairs = lcsPairs(previousLines, nextLines);
    const pairs = exactPairs ?? orderedExactPairs(previousLines, nextLines);
    if (!exactPairs) approximate = true;

    const nextAttribution: FileVersion[] = nextLines.map(() => ordered[s].version);
    for (const [oldIndex, newIndex] of pairs) {
      nextAttribution[newIndex] = attribution[oldIndex];
    }
    previousLines = nextLines;
    attribution = nextAttribution;
  }

  return {
    lines: previousLines.map((text, i) => ({ lineNumber: i + 1, text, version: attribution[i] })),
    versionCount: ordered.length,
    oldestVersionTime: ordered[0].version.lastModified,
    approximate,
  };
}

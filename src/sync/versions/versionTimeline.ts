import { FileVersion } from '../../types';

function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return a === b
    || (a.versionId === b.versionId && Boolean(a.isCurrent) === Boolean(b.isCurrent));
}

/**
 * Logical version timeline: retained historical revisions in timestamp order, followed by Current.
 *
 * Current is a state, not a point on the retained-history clock. After restoring an old revision,
 * its live mtime may be old (normal user storage) or new (Group Folders). Either way Current is the
 * latest state and therefore always belongs at the end of the lineage.
 */
export function chronologicalVersionTimeline(versions: FileVersion[]): FileVersion[] {
  const historical = versions
    .filter((version) => !version.isCurrent)
    .sort((a, b) => a.lastModified - b.lastModified);
  const current = versions.find((version) => version.isCurrent);
  return current ? [...historical, current] : historical;
}

/** Current first for display, then retained history newest → oldest. */
export function displayVersionTimeline(versions: FileVersion[]): FileVersion[] {
  return [...chronologicalVersionTimeline(versions)].reverse();
}

/**
 * Previous logical state for compare:
 * - historical target → immediately older retained revision
 * - Current → newest retained historical revision, regardless of Current mtime
 */
export function previousVersionInTimeline(
  versions: FileVersion[], target: FileVersion,
): FileVersion | null {
  const timeline = chronologicalVersionTimeline(versions);
  const index = timeline.findIndex((version) => sameVersion(version, target));
  return index > 0 ? timeline[index - 1] : null;
}

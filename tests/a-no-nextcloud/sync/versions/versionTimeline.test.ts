import {
  chronologicalVersionTimeline,
  displayVersionTimeline,
  previousVersionInTimeline,
} from '../../../../src/sync/versions/versionTimeline';
import { FileVersion } from '../../../../src/types';

function v(id: string, lastModified: number, isCurrent = false): FileVersion {
  return { versionId: id, href: '', lastModified, size: 1, isCurrent };
}

describe('versionTimeline', () => {
  it('always places Current last chronologically even when its mtime is old', () => {
    const current = v('current', 2, true);
    const v3 = v('v3', 4);
    const v2 = v('v2', 3);
    const v1 = v('v1', 1);

    expect(chronologicalVersionTimeline([v2, current, v1, v3]))
      .toEqual([v1, v2, v3, current]);
  });

  it('pins Current first for display while retaining newest-to-oldest history', () => {
    const current = v('current', 2, true);
    const v3 = v('v3', 4);
    const v2 = v('v2', 3);
    const v1 = v('v1', 1);

    expect(displayVersionTimeline([v2, current, v1, v3]))
      .toEqual([current, v3, v2, v1]);
  });

  it('uses newest retained history as previous for Current regardless of Current mtime', () => {
    const current = v('current', 1, true);
    const v3 = v('v3', 4);
    const v2 = v('v2', 3);

    expect(previousVersionInTimeline([current, v2, v3], current)).toBe(v3);
  });

  it('uses the immediately older retained revision for a historical target', () => {
    const v1 = v('v1', 1);
    const v2 = v('v2', 2);
    const v3 = v('v3', 3);

    expect(previousVersionInTimeline([v3, v1, v2], v3)).toBe(v2);
    expect(previousVersionInTimeline([v3, v1, v2], v1)).toBeNull();
  });
});

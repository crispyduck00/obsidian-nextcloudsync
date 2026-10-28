# fixes/remote-file-id-index

## Problem and behavior

Preserve reverse file-ID mappings during path replacement.

Delete old reverse mappings only when they still point to the replaced path. Keep rename and ID reuse safe for the existing scanner and targeted Push.

## Upstream base and independence

- Base: upstream `1.0.13`, commit `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous topic head: `62f1a9359355f9d39167638a9f255348bde10d70` (reachable from the archived 0.1.1 development integration).
- No topic dependency.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

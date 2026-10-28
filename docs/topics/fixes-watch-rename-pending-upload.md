# fixes/watch-rename-pending-upload

## Problem and behavior

Retain a pending local content change when its path is renamed.

Move edit protection and the pending upload to the new path; reconcile content after MOVE. The Android lifecycle uses its own queue wrapper in the combined build.

## Upstream base and independence

- Base: upstream `1.0.13`, commit `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous topic head: `5da5f2ad515cff1535c83bb475e124a27044a9d0` (reachable from the archived 0.1.1 development integration).
- No mandatory topic dependency; composition with Android Watch is explicitly retained.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

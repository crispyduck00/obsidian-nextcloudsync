# fixes/watch-folder-delete-safety

## Problem and behavior

Never infer a safe recursive folder DELETE from stale tracking alone.

Keep locking when available and prove live remote emptiness before deletion. Preserve tracking if a remote child appears or emptiness cannot be established.

## Upstream base and independence

- Base: upstream `1.0.13`, commit `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous topic head: `10c33bd3ec81aa5ea6418a86e0a517de9646b0eb` (reachable from the archived 0.1.1 development integration).
- No mandatory topic dependency; integration composes this check inside the shared activity gate.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

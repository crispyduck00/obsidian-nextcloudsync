# fixes/watch-own-debug-log

## Problem and behavior

Keep the active own diagnostic log out of the Watch debounce queue.

Retain the early host filter as well as the engine exclusion. Preserve unrelated user notes and foreign log files.

## Upstream base and independence

- Base: upstream `1.0.13`, commit `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous topic head: `78c33351c4fa6da03b18ea940dc019ee0449ab38` (reachable from the archived 0.1.1 development integration).
- No topic dependency.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

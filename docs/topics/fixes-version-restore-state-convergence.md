# fixes/version-restore-state-convergence

## Problem and behavior

A Restore must converge remote identity and the common merge base before reporting success.

Read stable server identity around GET, verify server identity around GET and reject anomalously empty bodies using upstream’s guard, retry once and fail safely on a moving/replaced remote file. Keep the established Restore timestamp policy. Record restored bytes through MergeBaseRecorder and flush the base before saving StateDB. Regression: Restore removes a line; A re-adds it and B edits another line; the next merge must retain both. Do not decode binary files just to seed a base.

## Upstream base and independence

- Base: upstream `1.0.13`, commit `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous topic head: `3abcdc5c101406bfa40bf32d83f0b9e229e7b73c` (reachable from the archived 0.1.1 development integration).
- Applies directly to upstream. The enhanced history UI and the exclusive activity gate are independent topics.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

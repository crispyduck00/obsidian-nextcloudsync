# fixes/automatic-sync-collision-feedback

## Problem and behavior

Avoid noisy busy notices for automatic trigger collisions.

Explicit manual Sync now retains feedback; automatic Push/Watch/periodic collisions stay silent. Preserve upstream manual/automatic status arguments.

## Upstream base and independence

- Base: upstream `1.0.18`, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `24b1d8161efeb3eb365fbf168bc22cbf77db3e0e` (parent of the archived Beta.1 integration).
- No topic dependency.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

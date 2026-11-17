# fixes/watch-rename-pending-upload

## Problem and behavior

Retain a pending local content change when its path is renamed.

Move edit protection and the pending upload to the new path; reconcile content after MOVE. The Android lifecycle uses its own queue wrapper in the combined build.

## Upstream base and independence

- Base: upstream `1.0.17`, commit `557e9c5955f4e44ba421e08b03e9b121fe18ecfd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `fc94e4362a3d1fbba7c3da48e6f30e50bb7e9396` (parent of the archived Beta.1 integration).
- No mandatory topic dependency; composition with Android Watch is explicitly retained.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

# features/mobile-sync-status

## Problem and behavior

Keep the compact Android action-strip status.

Retain idle, syncing, conflict, network and error states. The combined build composes lightweight Watch/Push outcome presentation with the same existing status surfaces.

## Upstream base and independence

- Base: upstream `1.0.18`, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `3d7a4c8ed952953b185a719652d66a82b50b68b8` (parent of the archived Beta.1 integration).
- No mandatory topic dependency. Push pulse/status composition is integration wiring only.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

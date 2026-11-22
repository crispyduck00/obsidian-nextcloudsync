# features/mobile-watch

## Problem and behavior

Preserve explicitly enabled Android foreground Watch and suspension recovery.

Keep Android opt-in migration and existing saved choices. Preserve upstream cellular and plugin-path guards. Filter plugin events before scheduling a file debounce or structural recovery; a plugin folder event during a full scan must not queue another recovery. Desktop Watch remains on the normal engine paths; iOS remains gated.

## Upstream base and independence

- Base: upstream `1.0.18`, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `489d9a22eca24fc3d29e476c6e399b6970c3bce5` (parent of the archived Beta.1 integration).
- No stacked topic dependency; uses upstream WatchOperations. Shared/exclusive engine coordination is composed separately.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

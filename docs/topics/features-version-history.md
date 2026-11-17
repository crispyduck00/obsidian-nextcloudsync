# features/version-history

## Problem and behavior

Preserve enhanced Nextcloud retained-version comparison, browser and line provenance.

Keep author metadata, compare current/previous, mobile/desktop views, restored-source anchors and logical Current order for core and Group Folder backends. Require account DAV for version endpoints. Creation time is independent of revision/current detection. Restore correctness is owned by the independent restore-state fix.

## Upstream base and independence

- Base: upstream `1.0.17`, commit `557e9c5955f4e44ba421e08b03e9b121fe18ecfd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `08a93a30898c4252c3e93218bffa263f0410e023` (parent of the archived Beta.1 integration).
- Compose with fixes/version-restore-state-convergence, fixes/sync-activity-coordination and fixes/compare-markdown-diff.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

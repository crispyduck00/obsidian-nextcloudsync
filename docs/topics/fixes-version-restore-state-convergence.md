# fixes/version-restore-state-convergence

## Problem and behavior

A Restore must converge remote identity and the common merge base before reporting success.

Read stable server identity around GET, verify server identity around GET and reject anomalously empty bodies using upstream’s guard, retry once and fail safely on a moving/replaced remote file. Keep the established Restore timestamp policy. Record restored bytes through MergeBaseRecorder and flush the base before saving StateDB. Regression: Restore removes a line; A re-adds it and B edits another line; the next merge must retain both. Do not decode binary files just to seed a base.

Restored revisions can retain a checksum from an intermediate version. Record the confirmed remote ETag, distrust checksum metadata that conflicts with its revision, and condition body downloads on the listed ETag. The same revision proof applies to ordinary sync, deletion, initial comparison and Mirror. Upload responses report their confirmed ETag into the converged baseline.

## Upstream base and independence

- Base: upstream `1.0.18`, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `a46f6f58c86bd8a253a3932a09cc0729f063a127` (parent of the archived Beta.1 integration).
- Applies directly to upstream. The enhanced history UI and the exclusive activity gate are independent topics. Legacy first-contact deletion checks use the optional directory-inspection capability supplied by fixes/guarded-folder-reconciliation when composed. The standalone topic preserves existing behavior when that capability is absent.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

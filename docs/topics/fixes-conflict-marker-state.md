# fixes/conflict-marker-state

## Problem and behavior

Transport convergence must not hide unresolved marker conflicts.

Keep the prior conflict flag while complete markers remain, including upstream checksum and byte-equality shortcuts. Keep a useful pre-conflict merge base instead of overwriting it with marker text. Do not decode converged binaries for a marker check unless the state already indicates a conflict.

## Upstream base and independence

- Base: upstream `1.0.18`, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `7976a78d0d09d91843887cebbcc59969e064063d` (parent of the archived Beta.1 integration).
- Applies directly to upstream; identity metadata refresh is independently composed.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

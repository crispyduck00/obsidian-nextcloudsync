# fixes/conflict-marker-state

## Problem and behavior

Transport convergence must not hide unresolved marker conflicts.

Keep the prior conflict flag while complete markers remain, including upstream checksum and byte-equality shortcuts. Keep a useful pre-conflict merge base instead of overwriting it with marker text. Do not decode converged binaries for a marker check unless the state already indicates a conflict.

## Upstream base and independence

- Base: upstream `1.0.13`, commit `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous topic head: `db3ff0fb33b7c8721de05b3c3a4861042244711f` (reachable from the archived 0.1.1 development integration).
- Applies directly to upstream; identity metadata refresh is independently composed.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

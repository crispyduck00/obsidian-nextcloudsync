# fixes/sync-activity-coordination

## Problem and behavior

Serialize full sync and Restore against lightweight operations.

Retain writer-preferred shared/exclusive coordination and upstream per-path locks, plugin exclusions and cellular guards. Restore takes the same exclusive gate. Maintenance waits for an in-flight Restore before resetting tracking. The gate is process-local; another device is handled through normal remote identity/precondition checks.

## Upstream base and independence

- Base: upstream `1.0.13`, commit `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous topic head: `02d203f6b8442390c8f84068d699ab2e65f487c6` (reachable from the archived 0.1.1 development integration).
- Applies directly to upstream. Client Push routes its per-path operation through the shared gate when composed.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

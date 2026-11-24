# fixes/sync-activity-coordination

## Problem and behavior

Serialize full sync and Restore against lightweight operations.

Retain writer-preferred shared/exclusive coordination and upstream per-path locks, plugin exclusions and cellular guards. Restore takes the same exclusive gate. Maintenance waits for an in-flight Restore before resetting tracking. The gate is process-local; another device is handled through normal remote identity/precondition checks.

## Upstream base and independence

- Base: upstream `1.0.18`, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `2ec3c490c93437fbbcfc6cfc8363d6e14e3a0619` (parent of the archived Beta.1 integration).
- Applies directly to upstream. Client Push routes its per-path operation through the shared gate when composed.

Remote Mirror pauses ordinary full sync and Watch while its preview or apply dialog remains open. Closing or failing that dialog resumes deferred work on the same active engine. Disposing the host clears its engine reference, so an old dialog cannot revive a replaced engine.

The size-notice regression test now checks that a manual sync waits for active Watch work and counts only its own skips.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

Watch structural events arriving after a full scan has inspected their path request one fresh ordinary scan when the run finishes. The follow-up rechecks current state, coalesces bursts, and preserves pending work through cancellation without replaying stale individual DELETE, MOVE or MKCOL requests.

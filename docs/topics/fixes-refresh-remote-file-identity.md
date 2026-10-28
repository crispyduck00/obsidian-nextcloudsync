# fixes/refresh-remote-file-identity

## Problem and behavior

Refresh file identity without discarding correct metadata for unchanged content.

Keep known file IDs when a response omits them; refresh IDs in unchanged branches. Preserve failed ctime attempt fields across identical-content convergence for the same remote file, so harmless ETag changes cannot restart rejected metadata writes. A replacement file ID starts fresh.

## Upstream base and independence

- Base: upstream `1.0.13`, commit `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous topic head: `489cef1f369d5840f77298488209f2db54491fdb` (reachable from the archived 0.1.1 development integration).
- Applies directly to upstream; complements fixes/remote-file-id-index and Client Push.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

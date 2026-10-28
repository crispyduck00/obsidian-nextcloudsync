# features/client-push

## Problem and behavior

Keep low-latency account Push as a hint for the upstream reconciliation engine.

Root scope is unchanged: unchanged root is ignored, changed root can select known file IDs, uncertain scope uses full sync. Validate the whole ID batch before acting. Known plugin paths return plugin-pending; notes in a known mixed batch still reconcile. Pending plugins and unresolved operations clear the transient Push checkpoint, never the authoritative StateDB baseline. Generic/unknown/structural notifications and connection gaps retain conservative fallback. Public-link credentials never enter account OCS/Push, even with a manual endpoint override.

## Upstream base and independence

- Base: upstream `1.0.13`, commit `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous topic head: `8e1e8ba9e5ae694fea371a33765993c767ed89ef` (reachable from the archived 0.1.1 development integration).
- Compose with fixes/sync-activity-coordination, fixes/remote-file-id-index and fixes/refresh-remote-file-identity for the maintained all-topic build. They remain separate patches on the same upstream base.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

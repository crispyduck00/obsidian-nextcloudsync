# features/client-push

## Problem and behavior

Keep low-latency account Push as a hint for the upstream reconciliation engine.

Root scope is unchanged: unchanged root is ignored, changed root can select known file IDs, uncertain scope uses full sync. Validate the whole ID batch before acting. Known plugin paths return plugin-pending; notes in a known mixed batch still reconcile. Pending plugins and unresolved operations clear the transient Push checkpoint, never the authoritative StateDB baseline. Generic/unknown/structural notifications and connection gaps retain conservative fallback. Public-link credentials never enter account OCS/Push, even with a manual endpoint override.

Push uses the same live app-password source as WebDAV. A change restarts discovery and socket authentication with one credential, cancels the old attempt and preserves the existing reconnect catch-up. A missing secret parks Push without network retries. While the cached DAV connection belongs to an earlier password, the scope gate requests normal reconciliation so the engine can reconnect before trusting a root ETag or selecting file IDs.

## Upstream base and independence

- Base: upstream `1.0.18`, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `23c634677841bdfedd589286e78567df4bbe3bda` (parent of the archived Beta.1 integration).
- Compose with fixes/sync-activity-coordination, fixes/remote-file-id-index and fixes/refresh-remote-file-identity for the maintained all-topic build. They remain separate patches on the same upstream base.

Size-limited targeted work also defers the batch checkpoint. Other known notes in that batch are still processed.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

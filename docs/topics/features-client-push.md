# features/client-push

## Problem and behavior

Keep low-latency account Push as a hint for the upstream reconciliation engine.

Root scope is unchanged: unchanged root is ignored, changed root can select known file IDs, uncertain scope uses full sync. Validate the whole ID batch before acting. Known plugin paths return plugin-pending; notes in a known mixed batch still reconcile. Pending plugins and unresolved operations clear the transient Push checkpoint, never the authoritative StateDB baseline. Generic/unknown/structural notifications and connection gaps retain conservative fallback. Public-link credentials never enter account OCS/Push, even with a manual endpoint override.

Push uses the same live app-password source as WebDAV. A change restarts discovery and socket authentication with one credential, cancels the old attempt and preserves the existing reconnect catch-up. A missing secret parks Push without network retries. While the cached DAV connection belongs to an earlier password, the scope gate requests normal reconciliation so the engine can reconnect before trusting a root ETag or selecting file IDs.

### Newly discovered Team Folders

Nextcloud `notify_push` 1.4.2 caches a storage's recipient list for four to five minutes. A new Team Folder can initially have an empty or incomplete list. File edits made during that window can miss the other account's socket, and cache expiry alone does not replay them. For established mounts, file notifications use the usual Push path. [Recipient cache in notify_push 1.4.2](https://github.com/nextcloud/notify_push/blob/e393d172087e872fa88dc87baa39e6eb1bbde496/src/storage_mapping.rs#L32-L44)

With Client Push enabled, a complete vault listing identifies in-scope Team Folder mounts by their Nextcloud DAV properties and file IDs. When a full sync first sees a mount ID, the window starts after that sync finishes, even for a long initial download. The first check of the vault root ETag is due ten seconds later, followed by five checks at one-minute intervals. If other sync work blocks the final check, it gets one more opportunity ten seconds later. Mounts found together share the same checks. Seeing the same mounts again leaves the deadline alone. A newly discovered mount can extend it. Each check needs an eligible, visible, connected client. A changed vault root triggers the existing sync. An unchanged vault root costs one depth-zero request. After the window, ordinary Push, resume, reconnect and manual sync apply. Running **Sync now** also discovers mounts added since the last full vault listing.

## Upstream base and independence

- Base: upstream `1.0.18`, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `23c634677841bdfedd589286e78567df4bbe3bda` (parent of the archived Beta.1 integration).
- Compose with fixes/sync-activity-coordination, fixes/remote-file-id-index and fixes/refresh-remote-file-identity for the maintained all-topic build. They remain separate patches on the same upstream base.

Size-limited targeted work also defers the batch checkpoint. Other known notes in that batch are still processed.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

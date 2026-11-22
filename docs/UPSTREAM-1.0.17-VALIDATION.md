# Upstream 1.0.17 development candidate

Upstream tag **1.0.17** is pinned to commit `557e9c5955f4e44ba421e08b03e9b121fe18ecfd`. The development integration combines the four feature topics, twelve fix topics and fork documentation. Beta.1's integration is retained at `archive/integration-0.2.0-beta.1`.

The Beta.2 manual test bundle is built from the development tree. It uses the Fast Nextcloud Sync ID so that a copied, isolated test vault can exercise its existing settings and StateDB. Promotion to the standalone repository follows live acceptance.

## Size-limit correction

A cached full listing includes the observed server metadata of paths skipped by the size limit. This metadata is committed with the root ETag after reconciliation and is separate from the common file base and the file-ID index. A local edit, local deletion or new file cannot mistake a size-skipped path for an unchanged or absent server file. A changed cap causes one real listing. A legacy state keeps its existing file and directory bases and refreshes the root listing. An invalidation during reconciliation, including a conflict no-op, timestamp failure or failed local deletion, cannot be overwritten by the candidate root.

## Compatibility checks

| Area | Automated checks |
| --- | --- |
| Client Push | Unchanged root, known IDs, structural changes, mixed/unknown IDs, reconnect gaps, busy deferrals, and account/public-link discovery boundaries |
| Push with a known oversized path | A mixed batch still downloads its changed note. The oversized path and known plugin are deferred. No immediate full sync is scheduled, and a later unexplained generic event can still request one. |
| Full scans | Cache reuse with a persistent large file, recovery after changing the cap, protection against stale edits and deletes, migration, and invalidation during a run |
| Community plugins | Selected bundles keep full-session ordering, restart handling and data holds. Known plugin pushes are deferred. Unexplained parent IDs can still request normal reconciliation. |
| Android foreground Watch and compact status | Network and Wi-Fi gates, suspend/resume, serial coordination with a full sync, folder operations, early plugin-event filtering, and status/notice behavior |
| File identities, conflicts and timestamps | Reverse-ID changes, checked writes/deletes, conflict markers, checksum equality, creation-time retries and Push echoes, and modification times |
| Versions and Restore | Account DAV, current/revision chronology for regular storage and Group Folders, end-to-end base refresh, restore races, and a two-writer merge after restore |
| Upstream changes | Live per-upload cap, manual-only size notices, mirror behavior, browser login and TLS guidance |

Local validation uses the upstream frozen lockfile with Node 26 and pnpm 12.15. The GitHub development validation runs build, lint, the public Jest suite and secret checks. The optional private settings mockup is the only expected skip in the integrated public suite.

## Live acceptance before standalone promotion

Use Windows and Android with Obsidian 1.13.0 or newer. Create a distinct local test vault and confirm its resolved remote DAV path. Test an internal user share and a Group Folder alongside ordinary files. Use only expendable test data.

1. Establish a test baseline with 0.1.1, close Obsidian and back up that vault's plugin settings and state. Install Beta.2 manually using the same plugin ID and verify that the device ID, settings and file history survive the upgrade. Check the first real scan and the subsequent root shortcut.
2. Exceed Android's cap with a server-side change to a small synced file and edit the older local copy. Check that both versions survive the push and the next full sync. Raise the cap and check that the next manual sync re-evaluates the file. Repeat with a skipped file absent locally.
3. Change a normal note alongside frequent writes to an allowlisted plugin's `data.json` and an oversized attachment. Check selective note delivery, silent automatic size skips, and plugin updates during a regular full session. Create or move an unknown path and check the fallback.
4. Background Android and reconnect after a remote edit. Check Wi-Fi-only, watch recovery, and read-only share behavior. Confirm that the same setup still supports rename, delete and versions in the existing internal share.
5. Restore a Group Folder note and review the version list. Edit that note independently on the two devices. Check the merged body, current/revision order and resulting versions. Observe creation-time alignment and verify that it settles without recurring transfers.

The device and server checks load a manual ZIP into the test vault. BRAT can discover prereleases, so the test build is distributed as a file. The standalone source transfer, version record, release and BRAT rollout are gated on the real-vault result.

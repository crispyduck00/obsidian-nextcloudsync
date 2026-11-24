# Upstream 1.0.18 development candidate

The manual candidates use upstream tag **1.0.18**, commit `21f89023fdaee58068276df3cff876fcc74a1e95`. Beta.2 and all its topic heads are reachable from `archive/integration-0.2.0-beta.2`. Earlier results below record their respective development stages. The current build and acceptance scope are recorded under RC15.

## Password refresh and Client Push

Upstream now resolves the Obsidian Secret Storage app password before DAV requests. The engine rebuilds a cached connection if the value changed and rechecks server capabilities. This covers edits within the selected secret, selecting another secret and completing initial setup after startup.

Client Push reads the same value. A change invalidates pending discovery, closes the superseded socket and authenticates again. A missing value parks Push until a credential becomes available. The first connection and subsequent reconnects retain their established startup and catch-up rules. A root probe using superseded connection data requests normal sync so the engine reconnects before making a scoped decision. The public-share guard applies to automatic discovery and endpoint overrides.

## Compatibility checks

| Area | Coverage |
| --- | --- |
| Secret Storage and WebDAV | Value changes, secret selection, initial setup, missing credentials, failed reconnect and feature detection |
| Client Push | Rotation during discovery and handshake, delayed socket events, active-session reconnect, rejected credentials and public links |
| Root ETag and tracked IDs | Recheck after credential changes, fallback for unknown or structural changes, oversized-file metadata, legacy-state migration, and validation of tracked IDs |
| Android Watch and Android status | Foreground recovery, Wi-Fi-only behavior, overlap with full sync, guarded directory deletion and conflict indicators |
| Community plugins | Bundle order, restart holds, selected plugin paths, and note updates in mixed Push batches |
| Versions and conflict handling | Restore convergence, base and remote identity, concurrent writes, conflict markers and creation time |

## Historical Beta.3 validation

- The 17 topic branches each pass TypeScript and ESLint checks and their relevant Jest tests. A three-way comparison with each preceding topic confirms that Client Push is the only topic with new runtime changes beyond incorporating upstream.
- The complete Nextcloud-independent suite reports 3,454 passing tests across 225 suites. Six tests for the optional private settings mockup are skipped. The production build, lint and Secretlint pass with Node 26.12.1 and pnpm 12.15.0.
- A live headless test with Nextcloud 34.0.6 and notify_push 1.4.2 confirms a real Push-triggered sync before and after a password rotation on one engine. It verifies two separate valid app passwords, the WebSocket frames, removal and restoration of the selected value. The upstream wrong-password recovery test also passes on the same server. The separate Apache mod_dav suite passes all seven tests.
- The initial broad Nextcloud run reports 253 passing, 19 failing and 15 skipped tests. The local PHP session directory was missing. The network proxy also answered a request to the deliberately unreachable hostname. After correcting the test configuration and keeping password validation local, the six suites for public links, Versions, server locks and creation time pass with 22 tests and three skips. The deliberately unreachable external hostname was outside that rerun.
- Desktop UI automation could not start Obsidian in this environment. Windows, Android and the test account's Group Folder and internal share remain part of the device acceptance below.

## Historical RC1 safeguards

The manual `0.2.0-rc.1` build integrates `fixes/guarded-folder-reconciliation` and `fixes/scoped-version-history` on the same upstream commit. The folder topic covers protections advertised by Nextcloud and Folder Protection, confirmed absence of local directories, concurrent writes and delete races, and recovery when read access returns. The version topic verifies the file ID at the current vault-relative path and uses a DAV condition for restore. The integration applies the same scope check to Compare and Line history.

An ACL change on a Team Folder can leave the vault root ETag unchanged. Explicit **Sync now** requests a fresh listing. Automatic sync keeps its bounded ETag optimization. After a 404 on an established Nextcloud vault root, the engine stops, keeps local content and tracking, and avoids creating a private replacement in normal sync or Watch. An unobserved root can still be created during first setup. A missing subdirectory is reconciled only after targeted checks. The deletion limit applies to files and directories, and changed or new local content stays local until the original remote path can be reconciled.

Shared writes retain HTTP preconditions and check the available SHA-256 for an existing Nextcloud file. A real server can reuse an ETag for a different body. The file is checked immediately before the conditional write, so a later concurrent change still relies on the server evaluating the HTTP condition. Existing large files use a conditional PUT because the Nextcloud chunk-assembly MOVE can accept a stale destination ETag. New large files keep the chunked upload path.

The integrated Nextcloud-independent suite passes 3,473 tests across 226 suites, with six optional settings-mockup tests skipped. An isolated Nextcloud 34.0.6.2 deployment with Team Folders 22.0.6 and Folder Protection 2.5.2 passes five access tests. They cover child-first Watch events at a mount, ACL-only revocation and regrant, disappearance of the configured mount during full sync and Watch, a write-to-read-only role change, and a protected descendant blocking deletion and MOVE of its parent. The separate headless sync checks use two devices and real Nextcloud DAV and notify_push connections.

## Historical RC2 directory safeguards

`0.2.0-rc.2` adds the directory changes to `fixes/guarded-folder-reconciliation` on upstream `1.0.18`. The integration retains Client Push, Android Watch and the enhanced Versions views. Push verifies the vault identifier along with the root ETag. Known-file reconciliation checks that the parent still belongs to the synced folder before processing the file.

- A new upload checks its tracked parent live even when a stale root ETag allows a cached listing. The client skips MKCOL for previously tracked directories during PUT, MOVE and chunk assembly recovery.
- Same-path replacements hold both file and directory tracking. A replaced vault root stops Sync now, Watch writes and the application of an earlier Mirror plan. An unreadable Nextcloud directory listing halts a full scan before file processing.
- Routine sync and Watch leave remote collections in place after local removal. The Nextcloud 34.0.6.2 lab returned 412 for conditional collection DELETE even with its current ETag. The collection remained. The normal file deletion checks continue to apply to its children.
- Watch skips a server MOVE when the source or destination crosses a sync exclusion. Folder moves also check excluded or protected children before sending the request.

## RC15 canonical reconstruction and validation

The runtime target is the tested RC15 candidate `d72545c032a294e954e27e38b14496ff66eac0d1`.
Its published candidate is `97785d7677d31c9da219118c9d5226fbc6ff6f57`; both point to tree
`80458981845cf3256ca899a1dd40500dc908b5e8`. The normalized integration merges all 27 selected
independent topic heads. Its complete tracked runtime and build inputs are byte-identical to RC15.
The differences retain additional isolated-topic regression tests and explain composition ownership.

The original RC15 baseline passed 3,626 Nextcloud-independent tests, 391 real Nextcloud tests and
seven Apache mod_dav tests. Six optional private-settings-mockup tests and fifteen declared
Nextcloud cases were skipped. These counts describe separate suites and do not count the later
standalone-topic rechecks again.

The canonical replay covers 3,668 passing tests across all 239 default-discovered suites, with the
same six optional settings-mockup skips and zero failures. The initial full replay ran all 239 files
exactly once across sixteen serial ts-jest isolated-modules shards to bound memory use. A subsequent
fixture-only type correction was verified with ordinary typed Jest on all eleven cases in that
file. Hash and case/status parity checks confirm that the other 238 files are unchanged. Compared
with the original RC15 results, 42 cases are added and no baseline case or result status is removed.
Earlier monolithic attempts were terminated by the environment before producing results and are
not counted as passes.

The production TypeScript check and explicit source/unit-test type audit pass. An independently
archived production build produces the
same installable `main.js` as RC15, SHA-256
`93140967f3ea1cc6ce42ea30d65876ff06c7fb0fec0f0eed561d59b5efcd3709`.

Source ESLint and the complete frozen-snapshot Secretlint scan pass. The first fresh three-case
day-to-day run passes both writable scenarios. Its read-only scenario fails strict local-tree
equality because Android retains one extra old-path Folder Note; all five remote identities and
contents and the desktop state remain correct. That run did not trace the extra note's origin.
A traced read-only replay with a fully adopted initial local baseline passes the unchanged strict
assertion, ends with zero sync errors and sends zero idle DAV requests or extra full syncs. This
control establishes the settled workflow without proving the original extra note's cause.

A separate controlled read-only case deliberately interrupts initial adoption before the offline
gap. Actual Folder Notes and heading-sync hooks create a local note with an existing parent and no
tracking baseline. After the other user moves the remote folder, exactly that draft is retained
with visible safety errors; canonical remote content and identities remain intact. Manual refresh
keeps the hold. A 7.5-second idle observation sends zero DAV requests and starts no extra full sync.
In this controlled case the draft matches the canonical note; verified local cleanup clears all
errors. This confirms the unadopted-draft safety behavior without assigning it as the untraced
original failure's cause.

The final persistent-rename topic additionally passes the exact six-case directory-creation race
suite on real Nextcloud. It covers folder-first and note-first events, implicit MKCOL, a lost creation
response, an existing collection and a peer replacing the collection. The existing focused live
recovery check passed 22 tests across three suites. The final resource-bounded runner changes only
test transpilation and PHP worker count; production source and assertions are unchanged.

The baseline upgrade checks preserve settings, Secret Storage selection, device identity, tracking,
pending locked moves and history across RC14 to RC15. Desktop/Android host simulations run the
released Folder Notes and heading-sync hooks against real isolated Nextcloud 35. Native Obsidian
on Windows and Android could not be run in this environment and remains the acceptance step.

Two deliberate behaviors remain visible during acceptance:

- If an offline device edits a note while a second user moves its remote parent folder, the old-path
  local draft is retained and sync reports a safety hold. Copy the edits into the canonical note at
  the new path, verify its upload, then remove the obsolete local tree. Automatic move following is
  outside this RC, as agreed for the acceptance build.
- Folder Notes can create a local note inside a read-only share. Upload then reports HTTP 403 and
  retains the local draft. The clean read-only control uses owner-created notes after initial sync
  has fully adopted their local baselines and all creation queues have settled. This does not grant
  the receiving user write access or settle a newly created local draft automatically.

The manual ZIP remains `Fast-Nextcloud-Sync-0.2.0-rc.15-Test.zip`, SHA-256
`4b957c72b7684353fe92fe5777fccf5e7fa2aed6de13dda732c8cd1999d171b7`. Topic normalization does not
create a new plugin identity or an official release. The standalone repository and BRAT rollout
remain unchanged until real-vault acceptance succeeds.

## Real-vault acceptance before standalone promotion

Use a separate Windows and Android test vault and a dedicated remote test folder. Back up that test vault's plugin directory, then close Obsidian and install `0.2.0-rc.15` manually under the same Fast Nextcloud Sync plugin ID. Preserve the test vault's existing device ID, state and Secret Storage selection.

1. Confirm the resolved DAV path and run a two-way sync. Enable Client Push and verify a remote edit arrives. Use a second valid app password for the same test account. Change the selected secret in place and run Sync Now without restarting Obsidian. Verify another remote edit arrives. Repeat by selecting a different secret. Clear the selected secret's value, confirm that sync asks for credentials, then restore it and confirm that sync and Push recover.
2. Put Android in the background, make a remote edit, and resume or recover Wi-Fi. Verify the note, the Push status, foreground Watch and Wi-Fi-only behavior. Test the existing internal share, a read-only or public share, and a Group Folder with expendable data.
3. Change an ordinary note and a selected plugin's data together. Verify selective note delivery and plugin reconciliation in a regular full session. Create, rename and delete files, create and rename folders, and track the fallback for unknown or structural Push. Confirm that a folder removed locally remains on Nextcloud and that intentional deletion on Nextcloud reconciles locally.
4. Lower the size limit and make a remote file exceed it while editing an older local copy. Check that the server keeps the newer body and that the next sync can see both versions. Raise the limit and verify reconciliation. Repeat for an oversized file absent locally.
5. Restore a test note in a Group Folder. Check the version list, then make independent edits on both devices. Verify the resulting content and version sequence.
6. Revoke and restore read access for a disposable Team Folder subdirectory. Use Sync now after each change. Verify that unchanged copies follow the remote listing and that local edits and drafts are available when access returns. Repeat with a genuinely deleted test subdirectory and with a missing configured vault root. Verify that the missing root leaves local content intact.

The manual ZIP is the acceptance build. The standalone repository and BRAT rollout follow successful real-vault acceptance.

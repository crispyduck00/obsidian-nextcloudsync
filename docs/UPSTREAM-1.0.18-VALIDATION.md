# Upstream 1.0.18 development candidate

The manual candidates use upstream tag **1.0.18**, commit `21f89023fdaee58068276df3cff876fcc74a1e95`. Beta.2 and all its topic heads are reachable from `archive/integration-0.2.0-beta.2`. Earlier results below record their respective development stages. RC15 is withdrawn. RC16 passed automated acceptance; its recorded source, package identity and remaining native acceptance are below.

## Current status: RC16 automated acceptance passed; RC15 withdrawn

**RC16 passed the automated acceptance recorded below. RC15 remains withdrawn.** All default
unit/build checks and selected standard live cases pass, along with the separate add-on,
compatibility, Unicode and modeled safety checks. No remaining automated failure is concealed by
a changed assertion or a runtime workaround for a fixture problem.

The historical sections preserve their original counts and hashes for those source snapshots.
The final RC16 record below identifies the tested source and keeps independent result groups
separate. Verify the manual package digest and the public candidate's GitHub Actions before
installation. Native Windows and Android Obsidian acceptance is still required. This is a release
candidate, not an official stable release or a standalone-repository/BRAT promotion.

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

## Historical RC15 canonical reconstruction and validation — withdrawn

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

The withdrawn manual ZIP was `Fast-Nextcloud-Sync-0.2.0-rc.15-Test.zip`, SHA-256
`4b957c72b7684353fe92fe5777fccf5e7fa2aed6de13dda732c8cd1999d171b7`. This hash identifies the
archived RC15 package; do not use it as the current acceptance build. Topic normalization did not
create a new plugin identity or an official release.

## RC16 safety follow-up — automated acceptance passed

The selected set grows from 27 to **28 independent topics: six features, twenty-one fixes and
`docs/fork-overview`**. The new `fixes/remote-rename-safety` starts directly on upstream
`21f89023fdaee58068276df3cff876fcc74a1e95`. Own-write/replacement, Push and persistent-rename
corrections extend their existing owners; no new feature is introduced. The integration reuses
existing held-path predicates, the pending-rename assertion and guarded-write contracts.

### Reproduced RC15 failures and correction ownership

| Trigger and verified pre-fix result | Correction and owning topic |
| --- | --- |
| Remote `note.md` to `Note.md` rename on a case-insensitive, case-preserving local adapter: one full sync can remove the aliased local file and the next can conditionally delete the remote file without reporting an error. Mirror and first-setup/preview race variants also reproduce unsafe behavior. | General `fixes/remote-rename-safety`: exact-name preflight and authoritative reconciliation for token-reported renames. Ambiguity stops visibly before reconciliation writes; no automatic case rewriting is added. |
| A decomposed Unicode local name uploads to Nextcloud's canonical server spelling. Subsequent sync can create two local names for the same remote ID; deleting the old local copy can then delete the one server resource and later the remaining local copy. | The same general name-safety topic: detect Unicode-equivalent ambiguity, protect direct deletion from legacy same-ID aliases and accept metadata-only recovery after an exact manual filename correction. |
| A force download or Mirror transfer enters unconditional local replacement. The adapter removes the target and then rejects; tracking remains unchanged. A later full sync can interpret the missing target as a local deletion and delete the unchanged remote file. | Existing `fixes/guard-local-download`: route the two Resolution callers and Transfer fallback through the existing expected/guarded atomic-write API. Both public force-pull and edited-Mirror failure/next-full-sync model cases pass on the composed runtime; the complete standard live replay also passes. |
| A user deletes a recently downloaded/moved note during the own-write event window. The delete event is ignored and the Watch queues become idle while the server and peer retain the file. | The same own-write topic: use its existing expiry timer for one missing-and-still-tracked check, scoped to the current engine/account and invalidated by superseding rename or teardown. |

The case-alias reproductions model the filesystem semantics with the real sync chain; they are not
native Windows runs. The Unicode failures were reproduced against isolated Nextcloud with the
released heading-sync hooks. The failed-replacement proof invokes public force-download/full-sync
entry points and the shared transfer path. These pre-fix failures withdraw RC15 regardless of its
historical passing counts.

### Checked RC16 invariants

- File spelling comparisons do not rewrite paths, change the sync root or infer new identities.
  Exact directory entries distinguish a physical local name from a filesystem alias.
- Manual Unicode-name recovery requires the same observed Nextcloud ID, an absent exact old local
  name, an existing exact canonical name and compatible tracking/base/clean-side metadata. It
  changes metadata only and clears the local stat signature so a real content read is required.
- A pending rename owns both of its paths. General metadata recovery cannot claim its reserved
  destination; the existing owning assertion reports a visible manual hold.
- Push can consume an explicitly manual safety hold without starting an autonomous retry loop.
  The error stays visible and the shared full-run result remains incomplete for Mobile. Deferred
  Watch edits stay queued behind the failed reconciliation. Transport failures retain bounded
  retries; normal configured syncs and later genuine Push hints remain eligible.
- A recognized same-ID server-normalized rename does not send another MOVE or invent a new content
  baseline. Locks, denied access, destination conflicts and unrelated spellings retain their
  existing hold/retry behavior.
- Existing replacement guards handle manual-force and transfer/Mirror failures. This correction
  adds no new recovery journal or automatic folder-move-following feature.

### Frozen source and completed unit/build gate

| Provenance | Verified snapshot |
| --- | --- |
| Validated source snapshot before publication | `efa2991392327f1820ba89c0eb589fbc46be2e2d` |
| Validated source tree | `6794b29ac3659d423d5f8a82c2d2bc7475825bee` |
| Published source commit | `de2049b0357e28cea7d0714f2de508116588c3ec` |
| Live/model source commit | `e6e60051d00e19625a5d0274145fcc3e97ab7c90` |
| Common runner runtime-source SHA-256 | `9d60d2c21ef758d21ff7b48383fbba8128d08db22a78f9ec30edd246be2c963a` |
| Production `main.js` SHA-256 from the unit/build snapshot | `2f2bf4e4a30b94cc972946171ddb9aaf375c3141682b5ed8bc94c4a188b9ce1f` |
| Production `styles.css` SHA-256 | `f3a6d70efb09e4ec798a1bbd231c757b1c1cad4c5d7714a79b3bab7a6af5a5e6` |
| Manual `Fast-Nextcloud-Sync-0.2.0-rc.16-Test.zip` SHA-256 | `c6047ae04b4771355c4ef34509e6438ffa57738e34222cdfaf8ad0a1f4fa1ec5` |

The final archive verifies all 605 tracked Git blobs. The final unit/build gate runs on the exact
validated source commit above. Against the earlier live freeze, 603 tracked payloads are
byte-identical and only two owning test fixtures differ:

| Changed test fixture | Owning topic and preserved behavior |
| --- | --- |
| `tests/a-no-nextcloud/sync/newItemDelay.test.ts` | `features/new-item-delay`: model actual directory children and correct a stale comment; test bodies/assertions unchanged |
| `tests/b1-nextcloud-headless/sync/observedFolderDeletion.b1.test.ts` | `fixes/guarded-folder-reconciliation`: place the forced sibling-before-child barrier at child processing instead of every read-only preflight stat; all nine test bodies, 29 expectations and original deadlines unchanged |

The final runtime, build inputs and all other tracked headless-test inputs remain byte-identical.
The common runtime-source hash matches the standard live replay and every separate acceptance
group below. Per-lane records additionally verify external fixture hashes before and after runs.
No test-only correction changes product behavior. The final full unit gate is counted once;
repeated earlier unit runs and focused proofs are not added to its result.

| Completed check | Result on the recorded source |
| --- | --- |
| Default Nextcloud-independent Jest suite | **3,790 passed**, 248 suites, zero failures, six existing optional settings-mockup skips |
| Baseline case/status parity | All **3,668** prior cases preserved with the same status; **122** cases added; each default file run exactly once |
| Production and explicit source/all-unit TypeScript audits | Passed |
| Production build, source ESLint and frozen-snapshot Secretlint | Passed with Node 26.12.1 |
| Exact composed-runtime safety models | **24 passed** across seven suites; source and fixture hashes unchanged |
| Standard real-Nextcloud replay | **383 passed**, fifteen known skips, zero final failures; 82 selected files, 80 executed suites and two pre-existing entirely skipped suites |
| Combined add-on/mount acceptance | **Nine unique cases passed**, zero final failures/skips, using real Team Folders, two accounts, notify_push and released add-on hooks |
| Additional compatibility/failure checks | **Eleven passed**: seven Apache mod_dav, one maintenance/offline recovery and three first-upload delete/recreate/peer-edit races |
| Actual Nextcloud Unicode-name recovery | **One live case passed**, with the released add-on hooks and unchanged source/fixtures |

The 24 safety models comprise 22 alias/token/Mirror/restart cases and two public failed-replacement
regressions. They exercise force-pull and edited Mirror followed by another full sync, along with
case-sensitive controls, case-preserving aliases, initial empty tracking and preview/apply races.
They use the composed production sync chain, not native Windows or a live Nextcloud server.

The separate live Unicode case uses Nextcloud 35.0.2.2, Folder Notes 1.8.26 and Filename Heading
Sync 1.12.0 in a simulated Obsidian host. It retains remote ID `2660`, first reports the intended
name-safety hold, then clears the error after an exact manual filename correction. The add-on
updates the heading; recovery sends one PUT and no MOVE or DELETE. Both legacy same-ID alias
Watch-delete directions preserve the remaining local copy and the server resource. A 7.5-second
idle observation sends zero DAV requests. This is one explicitly identified live case, not an
additional unit suite or a native-device run.

Against the RC15 runtime, the complete RC16 change is a net **258 TypeScript lines across twelve
runtime files**. It includes a 67-line shared name-safety helper and seven StateDB lines for a
private in-memory identity generation. There is no persisted-state schema change, new journal,
queue or timer. The deferred own-write deletion check reuses the existing timer. These size and
ownership checks describe the frozen runtime, not test/documentation volume.

### Completed live replay and resolved fixture failures

The standard replay selects every file once and matches the pinned baseline case names and
statuses. The fifteen skipped cases and two entirely skipped files are pre-existing:
`watch/folderPropagation.b1.test.ts` and `network/token.b1.test.ts`. Retests replace the affected
selected file's earlier outcome; they are not additional cases in the 383 total.

The original failing logs remain archived. Their resolutions are verified independently:

| Initial failure | Verified resolution without a runtime change |
| --- | --- |
| Five ENOENT failures in one historical add-on suite | Restore its released-bundle dependency path. The same five cases pass with unchanged runtime, test/wrapper bytes, names and assertions. |
| Seven observed-folder-deletion deadlocks after the new read-only name preflight | Correct the synthetic barrier's interception point in its existing owning fix topic. The full file passes nine cases with all nine bodies, 29 expectations and original deadlines unchanged. Independent traces prove seven forced sibling-before-child scenarios and fifteen child-processing entries, each after sibling restoration. |
| One combined add-on timeout against an expected server snapshot | The snapshot was taken 3.309 seconds before the watched deletion completed. At the original failure, the actual server, both local trees, tracked IDs and note bodies already agreed. Four fixture lines now await the intended remote absence before taking that snapshot. Both strict matrix cases pass; every original final assertion and timeout is retained. |

The external dependency repair and snapshot wait are harness changes. The two tracked fixture
corrections remain with `features/new-item-delay` and `fixes/guarded-folder-reconciliation`.
Own-write, Client Push and persistent-rename corrections stay in their existing topics; the one
new general topic is `fixes/remote-rename-safety`, and this validation is owned by
`docs/fork-overview`. Those are the six existing-topic updates plus the new general fix. There is
no new feature, no runtime change made to turn a fixture green and no duplicate pass counting.

The nine-case add-on acceptance consists of seven original passing controls plus the two strict
corrected matrix cases. It exercises Folder Notes 1.8.26 and Filename Heading Sync 1.12.0 against
real Nextcloud with two accounts and a Team Folder. Push/Watch and truly manual-only modes cover
project/folder-note creation, heading-to-filename and folder-note rename cascades, subtree and
multi-file moves, delete/recreate, binary children and idle convergence. Both matrix cases finish
with matching content/IDs, no errors or queued work, zero idle DAV requests, zero idle mutations
and zero extra idle full syncs. This bounded observation does not promise zero future metadata
requests for every unresolved error or account event.

### Publication checks and native acceptance

The automated source gate is complete. The public source and manual ZIP digest in the provenance
table identify the installable candidate. Check the public candidate's [GitHub Actions](https://github.com/crispyduck00/obsidian-nextcloudsync/actions) for the source commit above before
installation. Package verification confirms the recorded build hashes, the existing
`fast-nextcloud-sync` manifest identity and an unchanged previous standalone manifest except for
version `0.2.0-rc.16`. The ZIP is 231,110 bytes. No remote CI completion is inferred from the local gate. Native Windows and Android Obsidian acceptance follows on
expendable test vaults. No official stable release or standalone/BRAT rollout is made here.

The completed replay covers create/edit/rename/move/delete/restore, nested folders and multi-file
operations, two accounts and Team Folders, full sync/Push/Watch, released Folder Notes auto-create
hooks and heading/filename synchronization. It also verifies offline/server failures, manual safety
holds, repaired replacement failures and bounded idle behavior. Native Windows and Android
acceptance remains separate; no physical device result is claimed here.

The agreed extreme overlap remains a visible safety stop: an offline local edit combined with
another user's parent-folder move may need manual merge at the canonical destination. Cross-mount
folder moves remain protected holds rather than automatic copy-and-delete migrations. With Push
and Watch disabled, add-on-created notes can need another explicit full sync after their hooks and
creation grace settle; the manual-only replay explicitly drives that tail.

The verified manual `0.2.0-rc.16` package retains the existing Fast Nextcloud Sync plugin ID and
compatible settings/Secret Storage selection, device identity, tracking, pending moves and history.
Do not reset tracking or remove credentials as an upgrade step. It remains a test candidate until
native acceptance and the separate intentional stable-release decision.

## Real-vault acceptance before standalone promotion

After verifying the recorded RC16 package digest and public candidate CI, use a separate Windows and Android test vault and a dedicated remote test folder. Back up that test vault's plugin directory, close Obsidian and install `0.2.0-rc.16` manually under the same Fast Nextcloud Sync plugin ID. Preserve the test vault's existing device ID, state and Secret Storage selection.

1. Confirm the resolved DAV path and run a two-way sync. Enable Client Push and verify a remote edit arrives. Use a second valid app password for the same test account. Change the selected secret in place and run Sync Now without restarting Obsidian. Verify another remote edit arrives. Repeat by selecting a different secret. Clear the selected secret's value, confirm that sync asks for credentials, then restore it and confirm that sync and Push recover.
2. Put Android in the background, make a remote edit, and resume or recover Wi-Fi. Verify the note, the Push status, foreground Watch and Wi-Fi-only behavior. Test the existing internal share, a read-only or public share, and a Group Folder with expendable data.
3. Change an ordinary note and a selected plugin's data together. Verify selective note delivery and plugin reconciliation in a regular full session. Create, rename and delete files, create and rename folders, and track the fallback for unknown or structural Push. Confirm that a folder removed locally remains on Nextcloud and that intentional deletion on Nextcloud reconciles locally.
4. Lower the size limit and make a remote file exceed it while editing an older local copy. Check that the server keeps the newer body and that the next sync can see both versions. Raise the limit and verify reconciliation. Repeat for an oversized file absent locally.
5. Restore a test note in a Group Folder. Check the version list, then make independent edits on both devices. Verify the resulting content and version sequence.
6. Revoke and restore read access for a disposable Team Folder subdirectory. Use Sync now after each change. Verify that unchanged copies follow the remote listing and that local edits and drafts are available when access returns. Repeat with a genuinely deleted test subdirectory and with a missing configured vault root. Verify that the missing root leaves local content intact.

The verified RC16 manual ZIP is for test-vault/device acceptance. The standalone repository and BRAT rollout follow successful real-vault acceptance and an intentional release decision.

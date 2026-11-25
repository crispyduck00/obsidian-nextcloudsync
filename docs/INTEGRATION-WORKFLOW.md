# Development integration workflow

`integration/all-topics` is the tested integration branch for the `crispyduck00/obsidian-nextcloudsync` development fork. The name **Fast Nextcloud Sync** is reserved for the standalone installable repository/plugin (`crispyduck00/fast-nextcloud-sync`).

## Current candidate status

**RC17 passed the automated gate. RC15 and RC16 remain withdrawn.** A fresh replay found a real
Folder Notes integration failure in RC16: replacing a closed note temporarily renamed its indexed
path, and the released add-on interpreted that event as a request to rename the containing folder.
The same root cause affects binary attachments with the folder's basename. Earlier RC16 passing
claims below are historical and are superseded by this finding; they are not installation approval.

RC17 keeps the correction in `fixes/guard-local-download`, directly on the existing upstream-based
topic. It uses atomic text callbacks with verified recovery snapshots and a basename-preserving
binary recovery extension. It adds no feature, scheduler, queue or persisted-state schema.
The standalone plugin repository and BRAT rollout remain unchanged.

### RC17 gate (2026-11-25)

The final composed runtime passes 3,807 default tests (six existing optional-fixture skips),
350 standard Nextcloud cases (fifteen existing skips), twelve separately reported add-on/failure
acceptance cases, six installed-native-method protocol cases and seven Apache DAV cases.
A twelve-case live download/Restore subset is repeated after the add-on run and is not added to
the standard total. The standalone owner passes 281 focused tests in 23 suites plus its own
production build/types, lint and secret scan. All 3,796 previous unit cases and all 364 previous
standard live cases retain their multiplicity and result status. Seventeen unit cases and one
standard live case are added. All 605 tracked source files and fifteen external fixture files
remain pinned throughout the final runs.

The single RC17 runtime correction is a net 57 TypeScript lines in `LocalAdapter.ts`. Its public
owner commit is `eb797a6c3e6595538ef2737fff1aa56f84d81a3f`. The composed runtime commit
`e07fd45ad87287df41adf4e5bc4a896203991222` has tested tree
`ab95078187e5dbafa8801ab6bcd455ba9759a287`; the final merge adds only the maintained fork
documentation. The canonical owner branches remain independent upstream-based topics. Pending
RC16 topic heads are fast-forwarded to their already integrated commits; no published history is
rewritten. Draft PR #33 owns this correction and #43 exposes the separate general rename fix.

The manual RC17 ZIP is 232,157 bytes with SHA-256
`3501b61274144c566ff8c30cc1c7352530753ee9930a972a62812d9b2f7794f1`.
Its Fast Nextcloud Sync manifest is unchanged from the prior installed identity except version
`0.2.0-rc.17`. Install only the three plugin files and preserve settings, credentials, device ID,
tracking, pending moves and history. Resolve recovery holds before any rollback to older builds.
Native Windows and physical Android acceptance remains open; inspect the public integration CI
for this source before installation. There is no GitHub Release, stable tag or BRAT promotion.


## Purpose

Keep upstream `main` pristine while maintaining independently reviewable fixes and features that can
be rebased, tested and proposed upstream one topic at a time.

`integration/all-topics` is the only integration branch. Topic branches are intentionally isolated.

## Upstream base

- Upstream repository: `siosig/obsidian-nextcloudsync`
- Current upstream base: `1.0.18` (`21f89023fdaee58068276df3cff876fcc74a1e95`)
- Fork `main`: kept identical to upstream

## Branch model

- `main` — pristine upstream mirror
- `fixes/*` — isolated bug fixes, normally based directly on `main`
- `features/*` — isolated features, normally based directly on `main`
- `integration/all-topics` — tested integration of selected fixes and features
- `backup/*` — temporary safety references retained during branch reconstruction
- `validation/*` — temporary CI-only branches, safe to remove after validation

A feature may have a functional dependency on a fix, but the feature branch must not be stacked on
that fix branch. Dependencies are documented in the corresponding draft PR.

### CI workflow note

The development fork keeps `main` identical to upstream, including upstream-owned GitHub Actions workflows. Topic branches therefore inherit those workflows unchanged. A topic with an open Draft PR may legitimately receive both a `push` and a `pull_request` workflow run. Fork-only CI-noise changes are not kept as product `fixes/*` topics; correctness and upstream-aligned branch history take priority over eliminating duplicate successful CI runs.

## Integrated features

### Client Push

Branch: `features/client-push`

Adds optional Nextcloud `notify_push` support with:
- WebSocket transport and reconnect/backoff
- automatic endpoint discovery and manual override
- vault-root scoping
- debounced/coalesced push scheduling
- selective reconciliation of known pushed file IDs
- conservative fallback to a normal full sync for ambiguous/structural cases

The normal SyncEngine remains authoritative for merge/conflict decisions. An error can explicitly
require manual resolution. Push consumes that hint while the error stays visible, the root
checkpoint remains invalid and the shared full-run result stays incomplete for Mobile recovery.
Deferred Watch edits remain queued behind the failed reconciliation. Ordinary transport failures
retain the existing bounded retry; a later genuine hint or configured/manual sync remains eligible.

### Android foreground Watch

Branch: `features/mobile-watch`

Adds opt-in Android foreground watch behavior:
- local file create/modify debounce
- network/Wi-Fi-only awareness
- pending work across temporary network loss
- foreground/background lifecycle handling
- authoritative structural recovery
- post-full-sync recovery when structural events overlap a running scan
- one-time Android opt-in migration

iOS remains disabled.

### Compact Android sync status

Branch: `features/mobile-sync-status`

Adds a compact Android action-strip sync indicator:
- syncing / idle / success
- conflicts and errors
- network-blocked state
- optional Client Push realtime background/pulse
- click-through to the existing Sync Status UI
- reduced-motion support

The current layout keeps the tap target unchanged while making the foreground icon slightly smaller
and visually biased to the right.

### Enhanced Nextcloud Version History

Branch: `features/version-history`

Adds a richer UI around versions retained by Nextcloud:
- version metadata and author information when exposed by Nextcloud
- Compare current / Compare previous
- desktop side-by-side and mobile unified diff views
- retained-version Line History
- read-only Version Browser with timeline navigation and Markdown Rendered / Source modes
- restore entry points from history, compare, line history, and the browser
- logical Current-state handling across ordinary storage and Team / Group Folder restore semantics

Line History is retained-version provenance rather than Git blame; pruned intermediate versions cannot be reconstructed.

### Configurable edit debounce

Branch: `features/watch-debounce`

Makes the per-file quiet period for Sync on change configurable. Desktop and Android use the same
queue, and further edits extend that file's deadline. Manual sync uses the authoritative full-sync path.

### New-item first-upload delay

Branch: `features/new-item-delay`

Adds a separate configurable grace period for newly observed notes and folders. It gives filename,
heading and Folder Notes hooks time to settle before first upload. Renames retain the original
creation deadline, and manual sync flushes the grace through the existing reconciliation path.

## Integrated fixes

- `fixes/sync-activity-coordination`
  - serializes full sync against lightweight/watch operations with a shared/exclusive gate
  - owns Mirror-dialog exclusion, deferred structural scans and asynchronous host lifecycle ownership

- `fixes/guard-local-download`
  - preserves real local edits during downloads, restores and the sync-own-write event window
  - rechecks an ignored user deletion once through the existing own-write timer, after verifying that the path is still missing and tracked by the same owner
  - routes force-download and transfer/Mirror replacement callers through the existing guarded atomic-write contract; both public failure/next-full-sync model regressions pass on the combined runtime

- `fixes/remote-rename-safety`
  - reconciles token-reported remote renames from an authoritative complete listing instead of changing tracking alone
  - stops ambiguous local filesystem aliases and different Unicode spellings before reconciliation or Mirror can delete the wrong resource
  - accepts a manually corrected exact server filename only after matching its existing Nextcloud ID and compatible tracking, merge-base and clean-side metadata; clears the cached local signature so content is read again
  - protects direct deletion from legacy same-ID Unicode aliases without rewriting names, guessing a move or adding a new journal

- `fixes/local-vault-availability`
  - holds reconciliation when the local adapter cannot provide a trustworthy vault view

- `fixes/upload-snapshot`
  - records the exact uploaded body and its local signature without trusting a later file read

- `fixes/preserve-prefix-merges`
  - preserves both texts when independently created notes share a prefix

- `fixes/watch-connection-recovery`
  - contains Watch connection failures and permits later ordinary reconciliation to recover

- `fixes/remote-file-id-index`
  - preserves correct reverse remote-file-ID mappings across path replacement

- `fixes/refresh-remote-file-identity`
  - refreshes remote identity metadata even when content is unchanged

- `fixes/watch-rename-pending-upload`
  - preserves a debounced local edit across a rename

- `fixes/watch-own-debug-log`
  - ignores writes to the plugin's active diagnostic log in Watch mode

- `fixes/automatic-sync-collision-feedback`
  - keeps automatic busy collisions silent while retaining manual feedback

- `fixes/compare-markdown-diff`
  - keeps Markdown eligible for text comparison independently of auto-merge file types

- `fixes/conflict-marker-state`
  - keeps marker-based conflicts unresolved while a complete conflict-marker set remains present

- `fixes/optional-settings-mockup-test`
  - allows the public test suite to run without the intentionally untracked local settings mockup

- `fixes/watch-folder-delete-safety`
  - introduced a preflight check for shared folder deletion. The current folder reconciliation topic retains remote collections during routine sync and Watch.

- `fixes/version-restore-state-convergence`
  - records the server's real remote identity, mtime and file ID after a version restore so the next sync does not falsely merge/re-upload the restored file

- `fixes/oversize-root-etag`
  - keeps the remote metadata of size-skipped paths available during the root-ETag short circuit

- `fixes/guarded-folder-reconciliation`
  - verifies protected collections and child operations, preserves pending edits when a folder becomes invisible, and bounds local removal
  - checks live revision preconditions before shared writes and keeps an established Nextcloud root from being silently created again
  - refreshes the remote listing on explicit Sync now, including permission changes with an unchanged root ETag
  - keeps the original Nextcloud folder ID across syncs and holds local work when a folder is replaced at the same path
  - retains remote collections after local deletion, propagates independently verified file deletions, and keeps Watch moves within the selected sync scope

- `fixes/persistent-file-renames`
  - persists blocked file and folder moves per device along with the original Nextcloud identities
  - holds both paths through lock, read-only and conflict states. A full sync resumes the conditional MOVE after access returns.
  - retains acknowledged first PUT/MKCOL identities through concurrent local rename and move events
  - recognizes a manually corrected server-normalized filename only when the destination has the original Nextcloud ID and the old local filename is absent
  - the integration sends relevant Client Push IDs through the full-sync gate even with an unchanged root ETag and keeps the directory identity checks

- `fixes/scoped-version-history`
  - verifies the live vault path and file ID before opening, comparing or restoring versions
  - the integration also uses this verification in the enhanced history and line history views

## Historical RC15 topic reconstruction

The selected set contains six feature topics, twenty fix topics and `docs/fork-overview`. Every
selected topic starts directly from the pinned upstream commit, contains no merge commit and does
not contain another selected topic. Follow-up commits remain within the owning topic. All 27 heads
are merged into `integration/all-topics`, preserving its previous canonical history.

The reconstruction preserves every tracked runtime and build input from the tested RC15 candidate
`d72545c032a294e954e27e38b14496ff66eac0d1`. Additional regression tests and documentation explain
the isolated topics and their composition. That reconstruction added no runtime behavior beyond RC15. The RC16 changes below are separate follow-ups.

| Overlap | Integration responsibility |
| --- | --- |
| Push and root proof | Compose `fixes/oversize-root-etag` listing generations, guarded-folder root identity and version-convergence confirmed revisions. Pending moves keep ambiguous hints on the authoritative fallback path. |
| Restore and enhanced history | Apply the general local-write and revision guards to enhanced-history entry points and the separately scoped version lookup. |
| Upload and pending moves | Combine one immutable upload snapshot with conditional creation, confirmed server identity and revision receipts. |
| Edit debounce and new-item delay | Share one queue and central held-path predicates with persistent move recovery. Manual sync flushes creation grace. |
| Mirror and host lifecycle | Compose the shared activity gate with Watch queues, Push parking and Android status. Late callbacks may act only on the current plugin/engine owner. |
| Folder reconciliation | Reuse guarded-root, creation-receipt and local-write contracts while retaining independent delete and move intent. |

These are adaptations between independently usable topics. Shared helpers are composed once.
A bug in a feature stays in that feature topic. General fixes own upstream behavior, and a new
independent behavior gets its own feature topic.

## RC16 ownership and composition

The selection contains **28 topics: six features, twenty-one fixes and one documentation
topic**. The new general topic is `fixes/remote-rename-safety`, directly based on the same pristine
upstream commit. Existing topics receive their own follow-up fixes; this work adds no feature.

| Change | Owning topic |
| --- | --- |
| Filesystem/Unicode name safety and authoritative remote-rename reconciliation | `fixes/remote-rename-safety` |
| User deletion during the own-write window and guarded replacement callers | `fixes/guard-local-download` |
| Push consumption of explicitly manual safety holds | `features/client-push` |
| Recognition of an already-arrived server-normalized file rename | `fixes/persistent-file-renames` |
| New-item directory-listing unit fixture correction; assertions unchanged | `features/new-item-delay` |
| Observed-folder-deletion test barrier at the intended child-processing phase; assertions unchanged | `fixes/guarded-folder-reconciliation` |
| Candidate status, validation history and branch workflow | `docs/fork-overview` |

All selected topics remain independent patches on upstream `1.0.18`. Follow-up commits advance their
owning topic without stacking a feature on a fix. Draft PRs document any optional contracts and the
combined integration keeps its previous history.

The name-safety fix uses raw filesystem entries to distinguish an exact local name from a resolved
alias. NFC is only an ambiguity comparison; sync paths are not globally normalized or lowercased.
The existing guarded-write API handles replacement failures. No second rename algorithm, recovery
journal or content-baseline inference is added.

Composition reuses the existing held-path predicates and pending-rename assertion. A metadata
re-key cannot claim a destination reserved by another pending rename. The owning assertion keeps
its existing message and reports the same optional manual-resolution error contract as the general
name guard. Push handles that contract without importing or requiring the general fix. The shared
full-sync result remains incomplete for other callers; a visible manual hold is not successful
Mobile structural recovery.

The frozen RC16 source snapshot `efa2991392327f1820ba89c0eb589fbc46be2e2d` passes all 248
default-discovered suites: 3,790 tests pass and the six existing optional settings-mockup cases stay
skipped. All 3,668 previous cases retain their result status; 122 cases are added. Source/unit type
checks, production build, lint and the frozen-snapshot secret scan pass. The archive verifies all
605 tracked Git blobs. The standard Nextcloud replay passes 383 cases with fifteen known skips
across 82 selected files: 80 suites execute and two pre-existing suites remain entirely skipped.
Separate acceptance reports pass nine add-on/mount cases, eleven compatibility/failure cases,
twenty-four safety models and one real Unicode-name recovery case. These groups are recorded
separately and are not added to the default unit or standard live counters.

The change from RC15 is a net 258 TypeScript runtime lines across twelve files, including one
67-line shared name-safety helper and seven StateDB lines for a private identity-cache generation.
There is no persisted-state schema change or new queue/timer; own-write deletion reuses its
existing expiry timer. Follow-ups remain in their owning topic.

The new general fix and six existing-topic updates remain isolated: own-write handling, Client
Push, persistent renames, the two owning test fixtures and fork documentation. No new feature is
introduced. Dependency-path and external add-on synchronization corrections belong to the test
harness; they change no runtime behavior or final payload/identity assertions.

[Upstream 1.0.18 validation](UPSTREAM-1.0.18-VALIDATION.md) records the exact sources, hashes,
resolved fixture failures and acceptance limits. Earlier RC15 passing counts remain historical
evidence and do not restore approval of RC15. Native Windows and Android acceptance remains open.

## Superseded topics

Upstream 1.0.13 already covers `fixes/mirror-empty-remote-directories` and `fixes/mirror-state-persistence`. They are retained in the 0.1.1 archive and are not re-applied as duplicate changes. Their former Draft PRs document the supersession.

## Validation

Integration validation includes:

- `pnpm build`
- `pnpm lint`
- full `pnpm test`
- secret scan

The integration branch includes all currently selected `features/*`, `fixes/*`, and maintained
fork-documentation topic heads. Historical RC15 checks used simulated desktop/Android Obsidian hosts
with real isolated Nextcloud DAV, Versions, Team Folders and notify_push connections. RC16 repeats
the full pinned standard matrix and affected acceptance checks on the proven identical runtime.
Native Windows and Android acceptance remains required; host simulations and older interactive
checks do not replace that step.

## Upstream workflow

When upstream publishes a new version:

1. Archive the previous integration. Align fork `main` with the pinned upstream commit and use expected old heads when updating rebased refs.
2. Rebase/test each `fixes/*` and `features/*` branch independently.
3. Drop any fix that upstream has already incorporated.
4. Rebuild `integration/all-topics` from the remaining tested topics.
5. Run full integration validation.
6. Perform a short real-device smoke test.

This keeps every topic independently understandable and upstreamable.

## Pull-request documentation

Each topic has a public **Draft Pull Request against this fork's own `main`**.

These draft PRs are documentation/review surfaces only. They are not requests to merge into upstream.
If the upstream maintainer is interested in a topic, the corresponding isolated branch can later be
proposed upstream without changing the integration branch.

## Future work

Potential future feature:
- conflict-copy based conflict handling, replacing marker propagation for unresolved conflicts

That work is intentionally not mixed into the current fixes/features.

## 1.0.13 adaptation

The old development integration is preserved as `archive/integration-0.1.1`; the standalone stable `0.1.1` tag/release is unchanged. Each maintained product topic has `docs/topics/<topic>.md` with its scope, independence and composition dependencies. `docs/UPSTREAM-1.0.13-VALIDATION.md` records integration evidence and the remaining live acceptance work.

Selected plugins run only inside upstream's full bundle sessions. Known plugin Push IDs are deferred without certifying the root checkpoint. Unknown/generic/structural hints and invalid root baselines still take conservative full reconciliation; plugin selection/restart holds may legitimately invalidate the baseline. There is no promise to suppress every server metadata event or full listing.

A new standalone test build stays on a separate branch with a manually installable ZIP until the real-server/device acceptance matrix passes. Do not replace stable 0.1.1 or erase its local settings/tracking to test this upgrade.

BRAT can select public prereleases by default. Do not assume a prerelease flag protects existing installations: keep unaccepted builds out of GitHub Releases and retain stable main/release 0.1.1 until rollout is intentional.

## 1.0.17 development candidate

The Beta.1 integration is retained at `archive/integration-0.2.0-beta.1`. The manual Beta.2 test build is compiled from the development integration and uses the Fast Nextcloud Sync manifest identity for the upgrade test. Run the separate test-vault acceptance before promoting the sources to the standalone plugin.

[Upstream 1.0.17 validation](UPSTREAM-1.0.17-VALIDATION.md) records the automated and live checks, including the size-limit fix and its interaction with Push.

## 1.0.18 development candidate

Beta.2 is retained at `archive/integration-0.2.0-beta.2`. The Beta.3 manual build adds upstream's live app-password refresh and carries the Push adaptation in the independent Client Push topic. The other feature and fix patches remain directly based on upstream.

The manual acceptance builds `0.2.0-rc.15` and `0.2.0-rc.16` are withdrawn. The fresh RC16
replay supersedes its earlier passing claims. RC17 validation and its package digest are recorded at the top of this document. Its manual package must retain the Fast Nextcloud Sync
plugin identity and preserve settings, Secret Storage selection, device identity, tracking,
pending moves and history. Verify the recorded package digest and public CI before installing it
for native-device acceptance. The standalone repository, stable release and BRAT rollout remain a
separate promotion after real-vault acceptance.

[Upstream 1.0.18 validation](UPSTREAM-1.0.18-VALIDATION.md) records compatibility checks and real-vault acceptance.

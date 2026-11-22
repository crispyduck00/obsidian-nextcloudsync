# Upstream 1.0.13 adaptation and acceptance

Date: 2026-10-28. Status: automated validation passed; real-server/device acceptance pending for the new candidate.

## Preserved baseline and branch model

- Upstream: `siosig/obsidian-nextcloudsync` 1.0.13, `a3d206c30c33cb2cb1f81ed71db3a60f08ee01bd`.
- Development `main` is the exact upstream commit. Product topics branch directly from it; integration is their merge composition.
- Previous development integration: `archive/integration-0.1.1` -> `5145fb9bb49afdffdf50ef618b60ba7f11cb1ada`.
- Previous upstream baseline: `archive/upstream-1.0.8` -> `c83816deeabc9c3911f24cac8ff6ff45f592c7d1`.
- Standalone stable tag/release **0.1.1 is unchanged**. The new standalone candidate is **0.2.0-beta.1**, a separate test-build branch (no public GitHub Release/tag yet). Standalone main remains on the stable line until live acceptance.
- The upstream history was rewritten. Topics were adapted against the explicit old content baseline and recreated on the pinned new commit, rather than merging the obsolete historical base back in. Remote ref updates use explicit expected old SHAs and an archive.
- 4 feature topics, 11 fix topics, 1 fork-documentation topic. Two former Mirror fixes are superseded by upstream; they remain in the archive, not as duplicate runtime patches.

## Automated evidence

Toolchain: Node **26.12.1**, pnpm **12.15.0**, unchanged upstream frozen lockfile. No hand-edited dependency resolution is shipped.

- Full integrated public suite: **207 suites, 3,073 passed, 0 failed, 6 skipped**. The skips are only the optional, intentionally unpublished local settings HTML mockup checks. All other tests in that file still run.
- Full integrated run with `--detectOpenHandles`: passed.
- Integrated production build, ESLint and full-tree secretlint: passed.
- Gitleaks 8.30.1: development history scan passed (the final pre-push scan records the final commit count).
- Every product topic: TypeScript and ESLint, plus changed/added unit tests. Six topics with significant new interactions additionally ran the broad public suite independently. Only `ui/sliderLimits.test.ts` was excluded in those independent broad runs because the unmodified upstream fixture is private; the integrated suite includes the isolated optional-fixture fix and runs that file.

| Independently checked topic | Passed in broad run | Failed |
|---|---:|---:|
| `features/client-push` | 2931 | 0 |
| `features/mobile-watch` | 2882 | 0 |
| `features/version-history` | 2846 | 0 |
| `fixes/sync-activity-coordination` | 2831 | 0 |
| `fixes/version-restore-state-convergence` | 2830 | 0 |
| `fixes/watch-folder-delete-safety` | 2825 | 0 |

Key regressions exercise real product classes and host event wiring:

- Root ETag unchanged/changed/unknown; known/unknown/mixed IDs and positively identified parent/root IDs.
- Thirty changing known-plugin Push batches: no immediate plugin transfer/full-sync loop; no root checkpoint certification.
- Delayed plugin IDs invalidate an earlier transient checkpoint at the same root. A later generic hint still takes the conservative full path.
- Known notes mixed with plugins continue to reconcile. Unknown or unexplained structural identities never get hidden by the plugin exception.
- Plugin temp/status/folder events are filtered before Android lifecycle recovery, including events during a full scan. A real note beside plugin noise still queues.
- Pure creation-time corrections settle with both unchanged-root and changed-root metadata echoes; no repeated PROPPATCH after convergence.
- Failed creation-time attempts survive identical-content convergence for the same file, and reset for a replacement file identity.
- Complete conflict markers remain unresolved through both checksum and fetched-byte equality shortcuts; the useful clean merge base is retained.
- Restore refreshes and flushes the common merge base. A subsequently re-added line on A and an unrelated remote edit on B both survive the next real merge.
- Restore/full sync/maintenance use the same activity gate. Separate-device races are checked with stable server metadata around GET, a bounded retry and safe failure on replacement/moving identity.
- Restore keeps upstream's nonempty iOS response-length compatibility; it does not reintroduce a blanket byte-length/checksum rejection of an otherwise stable response.
- Account DAV gates still protect Versions and chunk upload; public-link credentials never enter account Push discovery/authentication.

## Push contract and remaining performance boundary

The authoritative Root ETag in StateDB advances only through the normal scanner. A transient Push checkpoint is separate and only certifies completed targeted work. Selected plugin bundles run only in full sessions; individual Push/Watch operations never bypass their bundle preparation, manifest ordering or restart holds.

Known plugin paths can be deferred when scope is trustworthy. Unknown IDs, generic notifications at an unexplained root, directory-only/structural events, a missing/invalid root baseline and reconnect gaps still fall back conservatively. Plugin restart/data holds can invalidate the root baseline. Therefore this version does **not** promise zero extra scans for every plugin or server metadata event. It preserves the correctness fallback instead of guessing that unknown changes are plugin noise.

Local plugin writes produce no server Push by themselves. Only selected bundle files can be uploaded; arbitrary cache/temp subtrees and this sync plugin's own directory remain excluded. `data.json` may contain real frequently changing state, and selected plugins with such content can still transfer genuine changes at a regular full session.

## Timestamp and version contract

Download mtime is applied locally with the upstream write API; creation-time alignment is metadata work. A remote `nc:creation_time` PROPPATCH can emit a notify_push cache event even with an unchanged ETag. Initial upgrade metadata bursts are possible, but corrections must converge instead of re-uploading content indefinitely.

Creation time is independent of version/revision time and the enhanced history Current marker. The Nextcloud source event path indicates that a pure creation-time cache change should not create a content revision; that is source analysis plus client-side tests, not a measured assertion about the maintainer's live Group Folder backend. Keep actual content uploads, merges and restores in the normal server version path.

## Live acceptance before stable promotion

Use a separate test vault on Windows and Android, and verify its displayed resolved remote path before the first sync. The vault name contributes to the remote path. Do not point a copied test vault at production by assumption. Keep the official and standalone sync engines from running simultaneously in the same vault.

| Case | Required observation | New-candidate live status |
|---|---|---|
| Existing 0.1.1 state/settings -> candidate | No index reset, accidental resurrection, lost file IDs, device identity or Android opt-in | Pending |
| Personal files, internal share, mounted Group Folder | Edits, rename, delete and permissions retain existing behavior | Pending |
| Frequently changing selected plugin data.json | No forced immediate plugin transfer loop; eventual normal-session convergence; no missed note alongside it | Pending |
| Plugin code update on enabled plugin | Ordered bundle application, held settings and restart warning follow upstream | Pending |
| Initial creation-time alignment | Metadata activity settles; no repeated content upload after convergence | Pending |
| Pure creation-time correction, each backend | Compare version list/count, contents, authors and revision dates before/after; no extra content revision solely from ctime | Pending |
| Chunked upload and metadata fallback | Correct content/mtime/ctime; bounded follow-up notifications | Pending |
| Restore, then concurrent A/B edits | No lost line; correct identity, Current/anchor chronology, author and retained versions | Pending |
| Read-only share / temporary 423 or network loss | Rejection vs retry remains bounded and conservative | Pending |
| Android suspend/resume, Wi-Fi-only and reconnect | One authoritative catch-up when required; no swallowed note or replayed unsafe deletion | Pending |
| Old 0.1.1 and candidate concurrently | Normal notes remain compatible; creation times do not ping-pong; plugin selection remains per-device | Pending |

No production server configuration, notify_push endpoint, reverse proxy or shared-folder restructuring is required by this adaptation. No live server, vault, credentials, devices or version stores were modified in automated validation.

## Rollback and promotion

Install the candidate ZIP manually in a test vault. BRAT currently requests releases including prereleases by default, so merely marking a release as prerelease or not-latest does not isolate production installations. No candidate release/tag is published until explicit rollout after live acceptance. Stable 0.1.1 remains the return version. Keep a copy of that vault's plugin settings and per-device state before changing versions; a downgrade can drop settings unknown to the older schema, including the new community-plugin selection. Do not reset StateDB as an upgrade/rollback procedure.

After the live matrix passes, promote the same validated runtime into a stable standalone version, retain source provenance and publish a fresh immutable tag. Do not move stable 0.1.1 or silently replace it with this unaccepted candidate.

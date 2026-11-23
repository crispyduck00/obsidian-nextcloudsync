# Development integration workflow

`integration/all-topics` is the tested integration branch for the `crispyduck00/obsidian-nextcloudsync` development fork. The name **Fast Nextcloud Sync** is reserved for the standalone installable repository/plugin (`crispyduck00/fast-nextcloud-sync`).

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

The normal SyncEngine remains authoritative for merge/conflict decisions.

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

## Integrated fixes

- `fixes/sync-activity-coordination`
  - serializes full sync against lightweight/watch operations with a shared/exclusive gate

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

- `fixes/scoped-version-history`
  - verifies the live vault path and file ID before opening, comparing or restoring versions
  - the integration also uses this verification in the enhanced history and line history views

## Superseded topics

Upstream 1.0.13 already covers `fixes/mirror-empty-remote-directories` and `fixes/mirror-state-persistence`. They are retained in the 0.1.1 archive and are not re-applied as duplicate changes. Their former Draft PRs document the supersession.

## Validation

Integration validation includes:

- `pnpm build`
- `pnpm lint`
- full `pnpm test`
- secret scan

The integration branch includes all currently selected `features/*`, `fixes/*`, and maintained fork-documentation topic heads. Version History restore/browser/Line History behavior was also exercised interactively on desktop and Android during the 2026-10-05 update.

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

[Upstream 1.0.18 validation](UPSTREAM-1.0.18-VALIDATION.md) records compatibility checks and real-vault acceptance.

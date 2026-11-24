# Persistent file and folder renames

This general fix persists a local rename before any WebDAV MOVE. The original file or collection identity and every unresolved source/destination remain reserved across retries and app restarts. Locked, denied, ambiguous, replaced and excluded paths stop safely and appear in sync status. Full scans can identify an unobserved move without authorizing a destructive replay.

The existing file-rename topic now also owns folder MOVE recovery, nested file-rename rebasing, cache/baseline relocation, and a deleted or replaced local destination. A moved child missing locally is restored and checked before its absence can propagate a remote deletion. Rename intent during the first PUT or MKCOL is confirmed only by the successful creation response. A later lookup cannot prove that a concurrent replacement is the object originally created.

## Upstream base

The branch extends the independent file-rename topic (`8ee80825`, `a43dccaa`) directly on upstream 1.0.18 (`21f89023fdaee58068276df3cff876fcc74a1e95`). This port extracts the existing RC folder MOVE and creation-receipt algorithms from `b63e7154`, `aa821ac5`, `7e768feb`, `dff9c855`, `3d6e4975` and `84ffdc0a`. It introduces no new sync mode, queue or timer.

## Composition

This standalone port keeps the upstream full-scan representation and ordinary manual/Watch entry points. Push scheduling, mobile event handling, configurable debounce/new-item grace, revision validation and immutable upload snapshots remain separate topics. The new-item grace adapter filters pending MOVE readiness; it reuses the persisted rename intent. The snapshot adapter preserves the first-upload completion callback while changing the upload argument representation.

Tracked-parent readability uses the shared optional directory-inspection/root-identity ports. The guarded-folder topic supplies the full Nextcloud root/permission validation and observed local-deletion policy. Local-vault availability is another optional shared port. The combined application composes these guards and the general sync-activity gate before network writes. Revision-specific inferred-file validation composes its trusted-checksum and conditional-GET checks separately.

Tests stay in the general test suites: the rename algorithm and network creation receipts apply independently of Push or mobile features. The live suites replace Push-only triggers with ordinary sync and use a second sync for a move captured after the current scan passed its files; immediate deferred Watch replay belongs to the activity-coordination topic. The integrated candidate tests both behaviors separately.

## Validation

The focused default suite covers durable file renames, Watch folder operations and Wi-Fi gates, transfer identity indexing, first-upload creation times, and held directory reconciliation. Separate network regressions cover conditional PUT/chunk assembly, acknowledged MKCOL receipts, rejection, lost responses, request caching and scope. Real Nextcloud tests cover persistent nested folder moves and file/folder renames overlapping the first creation. The integration additionally verifies the composed runtime against the already tested RC15 source.

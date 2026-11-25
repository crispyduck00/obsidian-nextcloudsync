# fixes/guard-local-download

## Behavior

Carry the classified local revision through a remote-to-local write. A file created, edited, or replaced while a download or Restore is in flight keeps its local bytes and the original common base. The next reconciliation hashes the local content again. A successful Restore records the committed body without trusting a later filesystem stat that may already describe another edit.

Guarded UTF-8 updates use the existing atomic text callback for closed files as well as open notes. The callback validates the saved text, the indexed path when available and the current edit guard. A verified recovery snapshot is written without renaming the user's note. This prevents rename-driven add-ons from interpreting an internal backup operation as a request to rename a folder. BOMs and line endings round-trip unchanged.

Binary data and adapters without the atomic text API keep the staged replacement protocol. Its recovery extension preserves the original basename: `Pictures.png` is parked as `Pictures.ncs-previous-1-png`. Folder Notes therefore sees no basename change. The suffix distinguishes extensions (including no extension), so same-basename attachments can be replaced independently. Both the old hidden recovery names and the new binary recovery names remain protected from cleanup and excluded from sync. A retained copy blocks replacement; two copies require a manual decision. If the new recovery name would exceed 255 UTF-8 bytes, replacement stops before renaming the original and asks the user to shorten the filename. New files and UTF-8 updates retain their existing long-name support.

If an in-place write fails after its callback accepted the revision, retain the verified snapshot. A missing destination can recover it; a live destination beside the snapshot stops visibly for manual recovery, including after restart. This stops the next ordinary sync from uploading a partial write. Disable the plugin before manually restoring the saved copy and removing the recovery file; do not rename or move an unresolved damaged note as a substitute for recovery. The existing recovery filename is the marker: no new persisted schema, journal, scheduler or queue is introduced.

The host records genuine editor changes even during a recent-download ignore window. Saved-file and editor events coalesce through the existing debounce. A temporary-file rename stays internal. A rename between ordinary paths remains user intent and rechecks the new path after the remote move when its source was recently written by sync.

A delete inside the own-write echo window is rechecked once after the existing timer expires. The existing local stat/recovery check first restores a parked previous copy when possible; only a still-missing, still-tracked path re-enters the ordinary proven deletion path. Explicit plugin trash and failed replacement removals retain their own-delete provenance. A later file or subtree rename, engine/account change, or disposal invalidates even a check whose local inspection has already started. If a rejected unconditional removal already unlinked its target, the staged replacement is retained. Manual force-pull, clean-side writes, and downloads without an earlier expectation also pass their existing local stat to the guarded write, so a failed replacement remains recoverable by the next full sync.

## Independence and composition

The topic extends the existing guard-local-download fix on upstream 1.0.18 (`21f89023fdaee58068276df3cff876fcc74a1e95`). It uses upstream Watch and VersionService directly. It has no Push, Android Watch, enhanced version-history, or persistent-rename implementation dependency.

The complete integration composes the same editor and rename checks with plugin/log path filtering and the maintained pending-rename workflow. The enhanced VersionService uses the optional Restore guard to include pending move and active-editor protection. Remote revision validation remains in the separate version-restore-state-convergence topic.

## Validation

### Open binary previews (RC18 follow-up)

RC17's open `Vault.modifyBinary` branch had no verified recovery copy. A native partial write could
be uploaded as a local edit after restart. Guarded updates now stop before mutation whenever an open
active or deferred preview cannot use the safe UTF-8 callback. The visible error asks to close all
previews of that file and run Sync now; the existing closed-file replacement then completes normally.
Text updates keep their callback/recovery behavior. No queue, timer or persisted field is added.
The real-filesystem regressions cover binary incoming bytes and binary previous bytes, both active
and deferred leaves, unchanged original bytes on hold, and successful retry after closing the preview.
The legacy unguarded API remains covered separately; production downloads/Restore use expectations.

The earlier standalone validation passed 401 focused tests in 22 suites. The add-on compatibility follow-up passes 281 focused tests in 23 suites. These include real-filesystem regressions for closed text files, same-moment edits and renames, invalid UTF-8, damaged snapshots, partial writes and restart recovery, plus binary recovery naming, independent same-basename attachments, legacy recovery and the long-name safety stop. The live regression follows a failed write through a fresh engine and checks that no damaged bytes reach Nextcloud. Full composed-runtime and released-add-on acceptance is recorded separately after the integration gate.

Deletion regressions exercise real host event wiring and LocalAdapter timers, own-trash partial failures, text/binary removal failures before and after unlink, a genuine delete after successful replacement, file/subtree rename supersession, engine/account changes, and disposal during asynchronous inspection. The implementation adds no separate timer, persistent state, or reconciliation queue.

# fixes/guard-local-download

## Behavior

Carry the classified local revision through a remote-to-local write. A file created, edited, or replaced while a download or Restore is in flight keeps its local bytes and the original common base. The next reconciliation hashes the local content again. A successful Restore records the committed body without trusting a later filesystem stat that may already describe another edit.

The host records genuine editor changes even during a recent-download ignore window. Saved-file and editor events coalesce through the existing debounce. A temporary-file rename stays internal. A rename between ordinary paths remains user intent and rechecks the new path after the remote move when its source was recently written by sync.

A delete inside the own-write echo window is rechecked once after the existing timer expires. The existing local stat/recovery check first restores a parked previous copy when possible; only a still-missing, still-tracked path re-enters the ordinary proven deletion path. Explicit plugin trash and failed replacement removals retain their own-delete provenance. A later file or subtree rename, engine/account change, or disposal invalidates even a check whose local inspection has already started. If a rejected unconditional removal already unlinked its target, the staged replacement is retained. Manual force-pull, clean-side writes, and downloads without an earlier expectation also pass their existing local stat to the guarded write, so a failed replacement remains recoverable by the next full sync.

## Independence and composition

The topic extends the existing guard-local-download fix on upstream 1.0.18 (`21f89023fdaee58068276df3cff876fcc74a1e95`). It uses upstream Watch and VersionService directly. It has no Push, Android Watch, enhanced version-history, or persistent-rename implementation dependency.

The complete integration composes the same editor and rename checks with plugin/log path filtering and the maintained pending-rename workflow. The enhanced VersionService uses the optional Restore guard to include pending move and active-editor protection. Remote revision validation remains in the separate version-restore-state-convergence topic.

## Validation

The standalone topic passes production build, source/test type checks, ESLint, secret scan and 401 focused tests in 22 suites. The regressions exercise the actual guarded LocalAdapter, same-stat edits during Restore/download/staging, editor-versus-save event ordering, ordinary renames after a download, and temporary-write echoes.

Deletion regressions exercise real host event wiring and LocalAdapter timers, own-trash partial failures, text/binary removal failures before and after unlink, a genuine delete after successful replacement, file/subtree rename supersession, engine/account changes, and disposal during asynchronous inspection. The implementation adds no separate timer, persistent state, or reconciliation queue.

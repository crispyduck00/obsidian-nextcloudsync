# fixes/guard-local-download

## Behavior

Carry the classified local revision through a remote-to-local write. A file created, edited, or replaced while a download or Restore is in flight keeps its local bytes and the original common base. The next reconciliation hashes the local content again. A successful Restore records the committed body without trusting a later filesystem stat that may already describe another edit.

The host records genuine editor changes even during a recent-download ignore window. Saved-file and editor events coalesce through the existing debounce. A temporary-file rename stays internal. A rename between ordinary paths remains user intent and rechecks the new path after the remote move when its source was recently written by sync.

## Independence and composition

The topic extends the existing guard-local-download fix on upstream 1.0.18 (`21f89023fdaee58068276df3cff876fcc74a1e95`). It uses upstream Watch and VersionService directly. It has no Push, Android Watch, enhanced version-history, or persistent-rename implementation dependency.

The complete integration composes the same editor and rename checks with plugin/log path filtering and the maintained pending-rename workflow. The enhanced VersionService uses the optional Restore guard to include pending move and active-editor protection. Remote revision validation remains in the separate version-restore-state-convergence topic.

## Validation

The standalone topic passes production build, source ESLint, secret scan and 144 focused tests in nine suites. The regressions exercise the actual guarded LocalAdapter, same-stat edits during Restore/download/staging, editor-versus-save event ordering, ordinary renames after a download, and temporary-write echoes.

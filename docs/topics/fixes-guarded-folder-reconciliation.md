# Guarded folder reconciliation

The topic verifies directory identity and permissions before using a remote listing to create, remove, or restore tracked paths. A missing or replaced Nextcloud root retains local data and tracking. Ordinary sync retains remote collections after a local folder deletion while individually verified file deletions remain eligible.

A tracked local folder that disappears without an observed deletion holds its remote children. An observed deletion is scoped to the account, endpoint, vault and tracked directory identity. A full scan records matching missing descendants before a sibling download can recreate their ancestor. The remaining children still require their own current content, identity and conditional-delete checks. Recreated local paths, account changes and replacement directory identities invalidate the old intent.

The local adapter marks missing ancestors as its own writes before restoring a descendant. Those create events preserve the earlier observed deletion. Folder deletion observation is active when automatic Watch is disabled, so an explicit later full sync uses the same safety policy.

## Upstream base

The branch extends the independent five-commit guarded-folder topic on upstream 1.0.18, commit `21f89023fdaee58068276df3cff876fcc74a1e95`. Its ancestry contains the upstream base and general fixes.

## Composition

The standalone port uses the existing optional directory-inspection capability. Persistent rename and MOVE handling supplies its own held-path checks when composed. The combined application uses the same observed-deletion policy with the more specific tracked-folder capability.

The separate local-write guard preserves a local draft that appears during a delete-versus-edit restore. Local-vault availability checks and persistent rename state are maintained in their own general topics.

## Validation

Focused tests exercise the real SyncEngine and StateDB for unexplained disappearance, recorded ancestor deletion through partial restoration, account changes, recreation and directory replacement. Existing protected-directory, conditional deletion, local adapter and root-listing regressions accompany the port. The integration additionally verifies the product source against the tested RC15 tree and exercises the shared Nextcloud workflows.

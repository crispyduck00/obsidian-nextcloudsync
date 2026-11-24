# Remote rename and path spelling safety

Base: upstream `21f89023fdaee58068276df3cff876fcc74a1e95` (1.0.18).
This topic applies directly to that base without another feature or fix branch.

## Problem and behavior

On a filesystem that resolves differently cased names to the same entry, a remote
rename can otherwise be mistaken for a missing local file and become a remote
deletion on the next sync. The same sequence affects empty folders and mirror
plans. A token-reported rename must not merely change State without changing the
physical local name.

The shared preflight compares exact directory entries, including ancestors, when
the local and remote path sets differ. Ambiguous files and folders stop visibly
before their reconciliation. Canonically equivalent Unicode spellings also stop:
Nextcloud may normalize an uploaded decomposed name, and two local spellings must
not become two tracked paths that can delete the same server object. Paths are
never automatically lowercased, normalized or physically renamed.

The incremental engine prepares community plugin scope before the preflight and
before processing token deletions. A detected remote-ID rename falls back to an
authoritative full listing. A stopped session invalidates its token/root checkpoint
and retains queued watch edits instead of draining them past the stop. The public
sync API remains `Promise<void>`.

After the user has manually matched a Unicode-normalized server name, a full scan
can re-key compatible metadata using the unchanged remote file ID. It preserves
merge bases/clean sides and invalidates the local stat signature so an edit made
while correcting the name is read again. Incompatible metadata, both names still
present, or neither name present require manual resolution. No credentials or
state schema change is involved.

The deletion sink independently refuses a DELETE while a tracked equivalent
Unicode spelling with the same remote ID remains local. Its per-run duplicate-ID
index uses an in-memory State identity generation: ordinary bulk deletions do not
rescan the complete State for every file; additions, identity changes, reload and
reset invalidate the proof. The generation and cache are never persisted.

## Cost and limits

The preflight adds no DAV request. Unchanged path sets need no additional stat or
directory listing; mismatches share directory listings within each preflight.
Normal Unicode comparisons and metadata checks are linear in the observed paths.
Token-ID renames deliberately perform one real full listing.

This is a conservative safety stop, not automatic remote-move following. A remote
rename combined with offline edits may still require manual conflict resolution.
Physically distinct case variants remain supported on a case-sensitive filesystem.
Canonically equivalent Unicode variants require resolving their names. Incoming
case variants on an empty case-insensitive filesystem and write-time races also
use the separately owned local-download guard when composing the complete RC.

Mirror validates file and empty-folder names both during planning and after plugin
preparation at apply time, including the original planned deletion paths. It does
not perform metadata recovery. The preflight cannot freeze the filesystem or the
server between asynchronous calls.

## Composition

The shared error exposes `requiresManualResolution = true`. The independently
upstream-based Client Push feature can consume that semantic flag while keeping
the visible error, rather than retrying the same unresolved name on a timer.
The persistent-rename feature must retain its existing source/target hold checks
around metadata recovery; that feature owns its pending-rename policy.

Community plugin bundles retain their existing inclusion rules. Excluded paths
are filtered before either file or folder preflight. No new scheduler, retry queue,
capability probe, filesystem-wide name rewrite or automatic move machinery is added.

## Validation

Regressions cover leaf case/ancestor identity, unchanged-path cost, transient I/O,
initial/full/token integration, prepared plugin scope, deferred watch edits,
mirror file/folder preview/apply races, Unicode repair/base preservation, duplicate
ID deletion guards, concurrent identity additions and the proof-cache lifecycle.

Public-engine tests use the real `LocalAdapter` and `StateDB` with a deterministic
case-aliasing filesystem host. They run a baseline and two subsequent syncs for
both case-sensitive and case-insensitive names, with token and full-list paths,
plus an empty-folder case. A direct two-run directory test reproduced a remote
collection DELETE before the fix and remains as a regression.
The same public engine host checks Unicode holds over two runs and explicit user
name correction on both token and full-list paths without a remote DELETE.

Standalone production and explicit all-unit TypeScript audits, ESLint, production
build and secret scan are required before committing. The upstream default unit
suite references a private `specs/main/desktop/settings.html` mockup that is absent
from this checkout; the unrelated optional-mockup fix is deliberately not stacked
onto this topic. Native Android/Windows execution and live Nextcloud checks belong
to the composed RC validation and must be reported separately from these hosts.

Standalone result (2026-11-24): 203 executable suites / 3,247 tests passed; the
single optional mockup suite fails at collection because its private HTML file is
absent. Production build/types, explicit all-unit types, ESLint, secret scan and
all 84 focused checks passed. No unrelated optional-test fix is included here.

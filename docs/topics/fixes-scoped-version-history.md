# fixes/scoped-version-history

## Problem and behavior

Nextcloud version history uses account-wide file IDs. A previously tracked ID may still exist after its file was moved outside the configured vault or a different file replaced the old path.

Verify the current vault-relative path and live file ID before listing or restoring versions. Carry that source ID with each version entry. Restore also requires the current ETag, binds the server request to the verified path, and checks identity around reading the restored body. A stale target invalidates the cached root listing and asks the user to sync and reopen history.

## Upstream base and independence

- Upstream base is 1.0.18, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- Original isolated implementation is `360292ded326f69bdf5e515577ae874ee9163ecd`, directly on that base.
- This general fix has no enhanced-history, Push, or mobile-watch dependency. Integration applies the same scope verification to the enhanced version-history entry points.

## Validation and limits

`sessionModules.test.ts` verifies VersionService's account-DAV requirements, missing or stale target identities, and the ordinary restore flow. The topic also includes `network/versions.b1.test.ts` for live Nextcloud validation. The doc-only topic check runs the relevant Nextcloud-independent tests, TypeScript build, and source lint. Live account namespace behavior is verified separately in the integrated candidate's server tests.

The standalone topic verification passed 45 assertions in 2 suites, plus the production build and source lint.

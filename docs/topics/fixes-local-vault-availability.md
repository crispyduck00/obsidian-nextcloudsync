# fixes/local-vault-availability

## Problem and behavior

A disconnected local vault can look like a large set of local deletions. The host supplies a probe for the installed plugin directory inside the selected vault. A missing or unreadable directory stops the full sync and prevents an absence-based remote deletion.

Check availability at full-sync entry and again before remote file or collection deletion, including watched collection deletion. Keep the callback optional for callers that do not have an Obsidian host. The host uses LocalAdapter's existing adapter to check the directory.

## Upstream base and independence

- Upstream base is 1.0.18, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- Original isolated implementation is `e5d9ff3e1ea11075f4281bd5717e7a631093d5d8`, directly on that base.
- This general safety fix has no Push, Android-watch, or persisted-rename dependency. Other deletion guards compose with its availability check.

## Validation and limits

The Nextcloud-independent deletion, directory-reconciliation, Watch, and LocalAdapter suites check compatibility with their existing callers. The dedicated `network/localVaultAvailability.b1.test.ts` tests a missing local root against a real server. The doc-only topic check runs the independent suites, TypeScript build, and source lint. Physical VHD or OS unmount behavior remains a real-device acceptance case.

The standalone topic verification passed 120 assertions in 6 suites, plus the production build and source lint.

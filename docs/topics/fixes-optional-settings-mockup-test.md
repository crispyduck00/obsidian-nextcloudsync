# fixes/optional-settings-mockup-test

## Problem and behavior

Run the public suite without an intentionally untracked local settings mockup.

Skip only mockup-dependent checks when the optional HTML file is absent. Do not skip product logic or the spec-coverage suite.

## Upstream base and independence

- Base: upstream `1.0.17`, commit `557e9c5955f4e44ba421e08b03e9b121fe18ecfd`.
- This topic is based directly on that commit, not on integration or another feature.
- Previous 1.0.13 topic head: `fb0b7e55f8ee2c627592964935f04e848a69502f` (parent of the archived Beta.1 integration).
- No topic dependency.

## Validation and limits

TypeScript build checks, ESLint and the changed/added Nextcloud-independent tests run for this topic before integration. The combined tree additionally runs the full public suite and regression scenarios. Exact counts and toolchain are recorded in the integration validation document.

Live Group Folder/internal-share, Nextcloud version-count and Windows/Android checks remain required for stable promotion. Existing 0.1.1 real-device tests are the preserved baseline; they are not claimed as tests of this new candidate.

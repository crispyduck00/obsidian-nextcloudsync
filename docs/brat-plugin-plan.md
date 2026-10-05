# Standalone / BRAT repository plan

This document records the packaging model for the standalone `fast-nextcloud-sync` repository. The repository has now been created and is used as the BRAT/distribution surface after a validated integration state is promoted from the development fork.

## Goal

Create a separate, installable plugin repository for personal/family testing through BRAT without colliding with the official **Nextcloud Sync** community plugin.

The development fork remains useful for upstream tracking and isolated topic branches. The standalone repository is the distribution surface.

## Proposed repository

Suggested repository name:

`crispyduck00/fast-nextcloud-sync`

Suggested plugin identity:

- **manifest id:** `fast-nextcloud-sync`
- **display name:** `Fast Nextcloud Sync`
- **description:** clearly identify it as an unofficial fork of Nextcloud Sync focused on low-latency push/watch behavior and enhanced Nextcloud integration

The exact name/ID should be finalized before the repository is created. Once users have installed a plugin under an ID, changing it later is disruptive.

## Source baseline

Use the validated `fast-nextcloud-sync` integration tree as the code baseline.

Do not use the development fork's `main` branch as the standalone source: that branch intentionally tracks upstream without the integrated fork features.

## Required identity changes

At minimum review/update:

- `manifest.json`
  - `id`
  - `name`
  - `description`
  - `author` / project attribution wording as appropriate
- `package.json` package name if necessary
- release/build metadata that references the upstream plugin ID
- README installation paths/examples that currently use `.obsidian/plugins/nextcloud-sync/`
- any tests that intentionally pin the manifest ID/name

Do **not** casually rename internal state files or settings keys unless required. A separate plugin ID already gives the plugin its own Obsidian plugin directory and data/state namespace.

## License and attribution

The upstream project is MIT licensed.

The standalone repository must:

- include the existing `LICENSE` file and its original copyright notice
- clearly state that the project is derived from `siosig/obsidian-nextcloudsync`
- link to the upstream repository
- preserve relevant copyright/license notices in copied source files
- distribute fork modifications under compatible MIT terms
- avoid implying that the standalone fork is an official upstream release

A useful README wording is:

> Fast Nextcloud Sync is an unofficial fork of Nextcloud Sync by Daisuke ITO. It is based on the upstream project and distributed under the same MIT license.

## BRAT distribution

The standalone repository should expose the artifacts BRAT/Obsidian needs from releases/builds:

- `manifest.json`
- `main.js`
- `styles.css` when present

The repository README should explain that BRAT is the intended testing/family-distribution route and that the official Community Plugins entry remains the upstream project.

## Keeping the standalone repository in sync

Prefer a reproducible update process rather than manually copying individual fixes.

A practical workflow:

1. update/rebase the development fork's `main` from upstream
2. recreate or update independent topic branches as necessary
3. merge the validated topics into `fast-nextcloud-sync`
4. run the complete validation matrix there
5. update the standalone repository from that validated integration tree
6. re-apply only the small standalone identity/package layer
7. build/test
8. publish a tagged release for BRAT

The standalone identity changes should remain small and isolated so upstream/fork updates are easy to carry forward.

## Validation before first release

Run at least:

- `pnpm build`
- `pnpm lint`
- full `pnpm test`
- secret scan
- desktop smoke test
- Android smoke test
- login/auth test
- Client Push connected/disconnected fallback test
- normal sync without Client Push
- version history/browser/restore
- personal-folder restore
- Team/Group Folder restore
- conflict handling
- fresh install under the new plugin ID beside/after the official plugin

## Migration / coexistence

Because the standalone plugin will use a different plugin ID, Obsidian will treat it as a separate plugin.

Do not enable the official plugin and the standalone fork against the **same vault at the same time**. Two sync engines acting on the same vault would be unsafe.

For family deployment, document a clean switch procedure:

1. disable the official plugin
2. install the standalone fork
3. configure/authenticate it
4. verify the displayed remote sync target
5. run a controlled first sync
6. only then remove the old plugin if desired

## Future packaging ideas

Later, the standalone repo could add:

- automated release builds
- a changelog generated from the maintained topic set
- a compatibility table against upstream/Nextcloud versions
- a clear experimental/stable channel distinction
- release notes that call out any required Nextcloud server-side features such as `notify_push`

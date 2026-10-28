# Draft: upstream GitHub Discussion

## Suggested title

Experimental fork: Client Push, Android foreground watch, and richer Nextcloud version UX

## Suggested post

First of all, thank you for building and maintaining Nextcloud Sync.

I started from this project because the upstream sync engine has been very reliable for my use case and already solves the hard parts I did not want to reinvent: Nextcloud-specific file IDs/checksums/sync tokens, safe reconciliation, conflict handling, version access, mobile support, and a strong test-oriented design.

My original goal was fairly small: I wanted sync to feel even more immediate across my own and my family's devices, so that users mostly do not have to think about synchronization at all.

That experiment grew into a fork:

https://github.com/crispyduck00/obsidian-nextcloudsync

The fork keeps its `main` branch aligned with upstream. Each feature/fix is developed independently from upstream/main and documented with a Draft PR. The combined build lives only on `integration/all-topics`.

A short demo of the integrated build:

![Fast Nextcloud Sync demo](https://raw.githubusercontent.com/crispyduck00/obsidian-nextcloudsync/integration/all-topics/docs/assets/fast-nextcloud-sync-demo.gif)

The demo shows real Desktop ↔ Android synchronization through Nextcloud and briefly opens the enhanced Version History.

Mobile sync status:

<img src="https://raw.githubusercontent.com/crispyduck00/obsidian-nextcloudsync/integration/all-topics/docs/assets/mobile-sync-status.png" width="360" alt="Fast Nextcloud Sync compact Android sync status">

Version comparison:

![Fast Nextcloud Sync version comparison](https://raw.githubusercontent.com/crispyduck00/obsidian-nextcloudsync/integration/all-topics/docs/assets/version-history-diff.png)

For the final Discussion post, the original MP4 can also be attached directly so the sync latency is easier to inspect than in the compact GIF.

The main experimental additions are:

- **Nextcloud Client Push / notify_push**: remote notifications trigger targeted reconciliation when the pushed file ID can be resolved safely, with fallback to the normal authoritative full reconciliation for unknown/structural cases.
- **Optional Android foreground watch mode**: the existing watch path is allowed while Obsidian is active on Android. It deliberately does not claim reliable Android background execution; resume/full reconciliation remains the safety net.
- **Compact Android sync status**: a small persistent status entry because mobile has no desktop-style status bar.
- **Enhanced Nextcloud Versions UI**: version authors/metadata, compare current/previous, mobile unified diff, retained-version line provenance, and a read-only timeline/version browser with rendered/source Markdown views and restore.

While testing those faster paths across multiple devices, I also ran into several smaller edge cases. I kept those as separate fix branches rather than hiding them in the combined fork: full/lightweight-operation coordination, remote file-ID bookkeeping, watch rename/deletion cases, mirror persistence/empty directories, version-restore state convergence, and a few UX/test refinements.

I am not posting this with the expectation that the whole fork should be merged upstream. Some parts are intentionally opinionated for my own/family setup. I mainly wanted to share the work, explain why it exists, and make the individual topics easy to inspect if any of them are useful upstream.

The fork overview is here:

https://github.com/crispyduck00/obsidian-nextcloudsync/blob/integration/all-topics/FORK.md

Relevant Draft PRs in the fork include:

- Client Push: https://github.com/crispyduck00/obsidian-nextcloudsync/pull/13
- Android foreground watch: https://github.com/crispyduck00/obsidian-nextcloudsync/pull/14
- Android status: https://github.com/crispyduck00/obsidian-nextcloudsync/pull/15
- Version history/browser: https://github.com/crispyduck00/obsidian-nextcloudsync/pull/16
- Restore-state convergence: https://github.com/crispyduck00/obsidian-nextcloudsync/pull/17

One future idea I am considering is moving away from inline conflict markers toward **explicit conflict files**. The idea would be to keep a canonical file plus a device/time-named conflict copy that synchronizes like an ordinary file, so every client can see unresolved conflict state, including for binary files. A UI could then help resolve those copies without making the unresolved state device-local.

The fork is primarily for my own/family use, but I have now also published a separate BRAT-friendly build with its own plugin ID so it can be installed independently without colliding with the official plugin:

https://github.com/crispyduck00/fast-nextcloud-sync

Current stable test release: https://github.com/crispyduck00/fast-nextcloud-sync/releases/tag/0.1.1

The standalone build is mainly a convenient distribution channel for my family/testing, but if somebody else finds it useful they are welcome to try it, report issues, contribute improvements, or even help maintain it. I cannot promise long-term maintenance or a release cadence.

For transparency: a substantial part of my fork-specific code, tests, and documentation was produced with AI coding assistance. I direct the work, keep every feature/fix isolated, review the resulting changes, run the automated test suite, and test the integrated build on real desktop/Android clients against Nextcloud. I still treat it as experimental software and do not consider AI output authoritative by itself.

If useful parts fit upstream, I would be very happy for them to be merged wholly or partially rather than remaining fork-only.

Again, many thanks for the upstream project. The fork exists because it provided a strong base to experiment on, not because I wanted to replace it.

I would be interested in your thoughts on which directions, if any, fit the upstream project's design.

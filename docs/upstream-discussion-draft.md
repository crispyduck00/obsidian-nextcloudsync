# Draft: upstream GitHub Discussion

## Suggested title

Experimental fork: Client Push, Android foreground watch, and richer Nextcloud version UX

## Suggested post

First of all, thank you for building and maintaining Nextcloud Sync.

I started from this project because the upstream sync engine has been very reliable for my use case and already solves the hard parts I did not want to reinvent: Nextcloud-specific file IDs/checksums/sync tokens, safe reconciliation, conflict handling, version access, mobile support, and a strong test-oriented design.

My original goal was fairly small: I wanted sync to feel even more immediate across my own and my family's devices, so that users mostly do not have to think about synchronization at all.

That experiment grew into a fork:

https://github.com/crispyduck00/obsidian-nextcloudsync

The fork keeps its `main` branch aligned with upstream. Each feature/fix is developed independently from upstream/main and documented with a Draft PR. The combined build lives only on `fast-nextcloud-sync`.

The main experimental additions are:

- **Nextcloud Client Push / notify_push**: remote notifications trigger targeted reconciliation when the pushed file ID can be resolved safely, with fallback to the normal authoritative full reconciliation for unknown/structural cases.
- **Optional Android foreground watch mode**: the existing watch path is allowed while Obsidian is active on Android. It deliberately does not claim reliable Android background execution; resume/full reconciliation remains the safety net.
- **Compact Android sync status**: a small persistent status entry because mobile has no desktop-style status bar.
- **Enhanced Nextcloud Versions UI**: version authors/metadata, compare current/previous, mobile unified diff, retained-version line provenance, and a read-only timeline/version browser with rendered/source Markdown views and restore.

While testing those faster paths across multiple devices, I also ran into several smaller edge cases. I kept those as separate fix branches rather than hiding them in the combined fork: full/lightweight-operation coordination, remote file-ID bookkeeping, watch rename/deletion cases, mirror persistence/empty directories, version-restore state convergence, and a few UX/test refinements.

I am not posting this with the expectation that the whole fork should be merged upstream. Some parts are intentionally opinionated for my own/family setup. I mainly wanted to share the work, explain why it exists, and make the individual topics easy to inspect if any of them are useful upstream.

The fork overview is here:

https://github.com/crispyduck00/obsidian-nextcloudsync/blob/fast-nextcloud-sync/FORK.md

Relevant Draft PRs in the fork include:

- Client Push: #13
- Android foreground watch: #14
- Android status: #15
- Version history/browser: #16
- Restore-state convergence: #17

One future idea I am considering is moving away from inline conflict markers toward **explicit conflict files**. The idea would be to keep a canonical file plus a device/time-named conflict copy that synchronizes like an ordinary file, so every client can see unresolved conflict state, including for binary files. A UI could then help resolve those copies without making the unresolved state device-local.

The fork is currently primarily for my own/family use. I also plan a separate BRAT-friendly repository with a different plugin ID so it can be installed independently without colliding with the official plugin.

Again, many thanks for the upstream project. The fork exists because it provided a strong base to experiment on, not because I wanted to replace it.

I would be interested in your thoughts on which directions, if any, fit the upstream project's design.

# Fast Nextcloud Sync fork

This repository is a fork of [siosig/obsidian-nextcloudsync](https://github.com/siosig/obsidian-nextcloudsync).

The upstream plugin is the foundation of this work. It already provides a strong and reliable Nextcloud-specific synchronization engine for Obsidian, including file-ID tracking, checksums, sync tokens, safe conflict handling, version access, Login Flow v2, chunked uploads, and mobile support.

A very large thank-you goes to **Daisuke ITO (@siosig)** for creating and maintaining the upstream project.

## Why this fork exists

The goal was not to replace the upstream design or build a second synchronization engine.

The original motivation was much narrower: make synchronization feel faster and more automatic, especially when several desktop and Android devices are used every day.

The desired experience is:

> Open Obsidian, work normally, and mostly forget that synchronization exists.

That led first to low-latency Nextcloud Client Push and foreground Android watch-mode work. While integrating and testing those changes across several devices, a number of smaller edge cases also became visible. Those are kept as isolated fixes rather than being folded invisibly into the integration branch.

The result is the **fast-nextcloud-sync** integration branch: upstream plus a set of independently reviewable feature and fix branches.

## Repository structure

The branch layout is deliberate.

- `main` stays aligned with upstream.
- Every feature is developed on its own `features/*` branch, created directly from `main`.
- Every fix is developed on its own `fixes/*` branch, created directly from `main`.
- Documentation specific to this fork lives on an isolated `docs/*` topic branch.
- Every topic branch has a Draft PR against this fork's `main` documenting motivation, scope, behavior, dependencies, and validation.
- `fast-nextcloud-sync` is integration-only: it is built from upstream plus the topic branches.
- Functional fixes are not supposed to exist only on `fast-nextcloud-sync`. If integration exposes a bug, the change belongs in the relevant topic branch first and is then merged back into the integration branch.
- Temporary validation/freeze branches are disposable and should not be treated as part of the maintained branch set.

This makes it possible to keep the practical all-features build while still preserving changes in a form that can be reviewed, discussed, or proposed upstream individually.

## Development and distribution workflow

The development fork and the installable plugin deliberately have different roles.

The intended workflow is:

1. keep `main` aligned with upstream,
2. develop one feature/fix at a time on an isolated topic branch from `main`,
3. document each topic with a Draft PR,
4. integrate validated topics into `fast-nextcloud-sync`,
5. run build, lint, tests, secret scans and real-device checks there,
6. promote that validated integration state to the standalone plugin repository,
7. apply only the small standalone identity/package/documentation layer,
8. publish BRAT-friendly releases from the standalone repository.

That means this repository is where experimentation and upstream-oriented development happen; the standalone repository is the distribution surface.

## AI-assisted development

A substantial part of the fork-specific code, tests, documentation and review work has been produced with the assistance of AI coding tools.

That is intentional and is disclosed openly.

AI output is not treated as authoritative by itself. Changes are directed and reviewed by the maintainer, kept in isolated topic branches, covered by automated tests where practical, integrated only after validation, and exercised on real desktop/Android clients against Nextcloud.

AI assistance can still introduce incorrect assumptions or subtle bugs. The branch structure, Draft PRs, tests, logs, conservative fallbacks and real-world testing are used to make such problems easier to detect and isolate.

The fork should therefore be viewed as **AI-assisted, human-directed and tested**, not as code claimed to have been written or verified entirely by hand.

## Main additions in this fork

### Nextcloud Client Push

Optional support for Nextcloud `notify_push` provides low-latency remote change notification.

The push transport does not replace the sync engine. Notifications are treated as hints that trigger the existing reconciliation logic.

The integrated behavior includes:

- Client Push endpoint discovery
- WebSocket connection and reconnect/backoff
- vault-root scoping
- coalescing/debouncing of notification bursts
- file-ID based targeted reconciliation where it is safe
- fallback to an authoritative full reconciliation when a notification is structural, unknown, or ambiguous

This is intended to reduce unnecessary polling and make remote edits appear quickly without introducing a second conflict/merge implementation.

### Android foreground watch mode

Android can optionally use the existing watch-mode path while Obsidian is in the foreground.

It is deliberately not presented as reliable background execution: Android can suspend the app. Resume/reconciliation remains the safety net.

The goal is simply that local edits made while using Obsidian propagate quickly, while preserving the same sync and conflict semantics as desktop.

### Compact Android sync status

Android has no normal Obsidian desktop status bar, so the fork adds a small persistent status control that can expose:

- idle / success
- syncing
- conflict
- error
- network-blocked state
- Client Push connectivity hints

It opens the existing sync-status UI rather than adding another status system.

### Enhanced Nextcloud version history

The fork makes more of the metadata and content already retained by Nextcloud Versions available inside Obsidian.

Current functionality includes:

- author metadata when Nextcloud exposes it
- labels, timestamps, sizes, ETags and current-state detection
- compare with current
- compare with previous
- desktop side-by-side diff
- mobile unified diff
- line-history / blame-like provenance based on retained Nextcloud versions
- read-only Version Browser with:
  - previous/next controls
  - timeline slider
  - exact-version dropdown
  - keyboard left/right navigation
  - Markdown Rendered / Source modes
  - lazy loading and in-modal caching
  - restore from the selected version
- restore from History, Compare and Line History

The Line History is intentionally described as **retained-version provenance**, not Git blame. If Nextcloud has pruned intermediate versions, those states cannot be reconstructed.

Current is treated as the final logical state even when a restored personal-file version keeps an old mtime or a Group Folder restore produces a new live mtime.

### Sync and recovery hardening

While testing the faster paths, several small edge cases were isolated into independent fixes, including:

- coordination between full sync and lightweight/watch operations
- preserving remote file-ID indexes across path replacement
- refreshing remote identity even when content is already converged
- preserving a pending local edit across rename
- keeping the plugin's own active debug log out of the watch debounce path
- suppressing harmless automatic "sync already running" feedback while retaining it for explicit user actions
- keeping Markdown eligible for compare diff
- preserving unresolved conflict-marker state after transport convergence
- safer Mirror-from-remote handling of empty directories
- persisting mirror state before reporting success
- live emptiness checks before recursive watch-triggered remote folder deletion
- converging StateDB to the server's real identity after a version restore

Each of these remains documented in its own Draft PR.

## Multi-user and shared-folder use

The fork is primarily used with several Obsidian clients and multiple Nextcloud users.

A useful pattern is:

- each person authenticates with their own Nextcloud account / app password
- personal notes stay in that user's own Nextcloud area
- shared notes are exposed through ordinary Nextcloud shares or Team / Group Folders
- the shared folder is mounted inside the path that the corresponding Obsidian vault synchronizes

Nextcloud permissions remain authoritative. The plugin does not bypass share or Team Folder permissions.

Using separate Nextcloud users also preserves useful server-side authorship where Nextcloud Versions exposes it.

### Team / Group Folder version note

Nextcloud Group Folders use a different version backend from ordinary user storage.

In testing, restoring a normal personal-file revision can make that old revision the live current file with its old timestamp and author metadata. Group Folder restore can instead copy the selected content into a new live current state, while the retained historical revision remains separately visible.

The fork therefore does not invent restore provenance. It displays the metadata Nextcloud actually exposes and treats Current as the final logical state for comparison and Line History.

## Server-side Client Push

Client Push requires Nextcloud's `notify_push` app to be installed and configured correctly by the server administrator.

The normal sync engine still works without it; the feature simply becomes inactive.

Consult the upstream Nextcloud `notify_push` project/documentation for installation and reverse-proxy requirements. In particular, the push endpoint and proxy/trusted-proxy configuration must be reachable from clients.

## Future ideas

The current conflict model still follows the upstream marker-based approach for text conflicts.

One future direction being explored is **conflict files instead of keeping conflict markers in the canonical file**.

A possible design would be:

- keep the server/current canonical file intact
- write the competing content to a clearly named conflict copy containing device/time information
- sync that conflict file like a normal file so every client can see that a conflict exists
- keep a visible conflict indicator until the user resolves/deletes the conflict copy
- use the same model for binary files, where inline markers are impossible
- optionally provide side-by-side resolution UI while keeping the underlying representation simple and portable

The important goal is that unresolved conflict state should be visible across clients, not only in one device's local StateDB.

Other future work may include further Android UI refinement and continued use of Nextcloud-native capabilities where they improve latency or transparency without weakening correctness.

## Relationship with upstream

This fork intentionally remains close to upstream.

The preferred long-term model is:

1. keep `main` aligned with upstream,
2. maintain each fork-specific topic independently,
3. rebase/recreate topics cleanly when the upstream baseline advances,
4. contribute fixes or ideas upstream where they fit the upstream maintainer's design,
5. keep the integrated personal/family build separate when a change is intentionally more opinionated.

The fork should not be read as criticism of the upstream project. It exists precisely because the upstream synchronization engine was already a strong base worth extending.

## Installation and BRAT

This repository is the **development/integration fork**.

Its upstream-derived manifest intentionally still uses the upstream plugin ID (`nextcloud-sync`), because the code here stays close to upstream. Installing this development fork directly alongside the official plugin would therefore conflict.

The standalone distribution repository now exists at:

- repository: [`crispyduck00/fast-nextcloud-sync`](https://github.com/crispyduck00/fast-nextcloud-sync)
- plugin ID: `fast-nextcloud-sync`
- display name: **Fast Nextcloud Sync**

That repository is the installable/BRAT-facing copy of a validated `fast-nextcloud-sync` integration state, with only the small identity/package/documentation layer changed.

The standalone plugin is primarily made for personal/family use and experimentation. It may also be useful to others, but there is **no guarantee of long-term maintenance, support, compatibility, or release cadence**.

Contributions, testing, improvements, and continued maintenance by interested users are welcome. Useful parts may also be proposed or merged upstream, wholly or partially, when they fit the upstream project's design.

If the standalone build proves useful and maintainable, submitting it later as a separate Obsidian Community Plugin can be considered. Until then, BRAT is the preferred distribution/testing path.

## License

The upstream project is licensed under the **MIT License** and this fork preserves that license.

The original copyright and license notice in [LICENSE](LICENSE) remain unchanged and must be retained in copies or substantial portions of the software.

Fork-specific modifications are distributed under the same MIT terms.

Nothing in this fork changes the licensing or authorship of the original project.

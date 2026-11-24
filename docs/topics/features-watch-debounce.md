# features/watch-debounce

## Behavior

Make the per-file quiet period configurable from zero to thirty seconds. The default is two seconds. A live preference change recalculates existing deadlines from each original edit time. Disabling Watch clears queued uploads and unloading clears their timer.

The WatchFileQueue implementation is identical to the one shared by features/new-item-delay. Its optional earliest-upload deadline combines the two settings when the topics are integrated. This branch uses the quiet-period setting independently on upstream's original Watch entry points.

## Upstream base and composition

The single topic commit is based directly on upstream 1.0.18, 21f89023fdaee58068276df3cff876fcc74a1e95. It contains no Android foreground-Watch or Push implementation. The integrated mobile host routes the same queue into MobileWatchLifecycle and the existing resume and network gates. The separate watch-rename-pending-upload fix preserves pending edits across a tracked rename when composing upstream's Watch operations.

## Validation

Production build, source lint and focused queue/settings checks run independently. The composed build additionally checks the actual Android/desktop host wiring and two-account workflows.

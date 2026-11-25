# features/new-item-delay

## Behavior

Delay the first automatic upload of an observed new local file or folder for a configurable zero to sixty seconds. The default is zero. A new folder holds its descendants until the same original deadline. Local renames move that deadline to the final path. Explicit Sync now and applying Mirror release it.

Only postponed remote observations invalidate the remote listing or token baseline. A held local-only creation does not turn an otherwise complete remote view into an error. Plugin bundles keep their existing full-session treatment.

## Upstream base and composition

The single topic commit is based directly on upstream 1.0.18, 21f89023fdaee58068276df3cff876fcc74a1e95. It contains the same LocalCreationGrace and WatchFileQueue implementations as the tested combined candidate. The standalone host uses upstream's fixed two-second edit quiet period. Composing features/watch-debounce binds that queue to the configurable quiet period.

Persistent file/folder rename recovery remains a separate general fix. The composition adapters defer an existing pending MOVE whose destination lies inside a new held parent, retarget it if that parent is renamed, and retry it when the parent deadline expires. The RC correction 4fc8d822 belongs to that composition. These adapters use PendingFolderMoves from the general rename topic and introduce no second MOVE queue. First-transfer response recovery also belongs to that general rename topic. The integrated Android host applies its existing foreground and Wi-Fi gates and resumes held deadlines when visible.

## Validation

Independent tests cover original per-file and parent deadlines, a folder plus note renamed during the delay, explicit manual flush, and actual engine startup/automatic scans before and after the deadline. The composed candidate tests pending tracked moves, first-upload races and Android/desktop add-on event orderings.

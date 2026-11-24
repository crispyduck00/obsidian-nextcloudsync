# fixes/preserve-prefix-merges

## Scope

Preserve complete note text when two independent creations share a prefix or one contains the other. A merge equal to the existing remote bytes retains that remote revision. The existing resolver continues to decide ordinary three-way merges and conflicts.

## Upstream and composition

The topic is based directly on upstream 1.0.18 at `21f89023fdaee58068276df3cff876fcc74a1e95`. It is independent of Client Push, Android Watch and enhanced Version History. Composition with guarded local writes retains the deferred clean-side capture before marker publication.

## Validation

The two existing conflict-applier and three-way merge suites pass 59 assertions. Production TypeScript build, source lint and secret scan pass. The combined candidate additionally covers concurrent creation and merge preservation against an isolated Nextcloud server. Native device acceptance remains separate.

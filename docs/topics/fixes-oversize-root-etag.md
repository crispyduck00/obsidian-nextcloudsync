# fixes/oversize-root-etag

## Problem and behavior

A size-limited download can leave a tracked file's common base older than the server, or leave a remote-only path out of the index. A matching root ETag used to rebuild the listing from that incomplete base. A local edit, a local deletion or a new file at the same path could then be propagated against the wrong server state.

The engine now commits the root ETag together with observed metadata for size-skipped server entries. The cached listing includes those entries. The merge base, file-ID index and file contents retain their normal meaning. Raising the size limit requests one real listing. Later sessions can reuse the root again. An in-flight invalidation or cancellation prevents a scan from certifying its candidate root.

An older state's root cache is rebuilt on upgrade. The tracked files, directories and device identity are reused.

## Upstream base and validation

This topic starts directly from upstream 1.0.18. The regression tests exercise the existing engine and StateDB with a Nextcloud DAV double that provides a stable root ETag. They cover local edits and deletions, a new same-path file, an increased size limit, persistence and invalidation during a scan.

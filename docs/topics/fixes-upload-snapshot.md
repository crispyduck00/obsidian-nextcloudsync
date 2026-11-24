# fixes/upload-snapshot

## Scope

Record the hash, size, modification time and merge-base bytes of the local buffer actually sent by an upload. A later editor save must remain detectable after the first request completes. Keep the existing conditional-write and plain-WebDAV identity paths.

## Upstream and composition

The topic is based directly on upstream 1.0.18 at `21f89023fdaee58068276df3cff876fcc74a1e95`. It works independently of Client Push, Android Watch and enhanced Version History. Composition retains guarded local publication, confirmed creation identities and the shared upload option contract from the corresponding general fixes.

## Validation

The two existing upload-state and transfer suites pass 45 assertions. Production TypeScript build, source lint and secret scan pass. The combined candidate additionally tests edits during delayed uploads, first-upload deletion and changes by a second Nextcloud account. Native device acceptance remains separate.

# First upload into a new folder

The absent-parent guard compares the remote directory listing with the directories tracked before
the local upload batch. A successful first PUT can create and record a parent while that batch is
running. Its later siblings must not be classified as children of a previously tracked, now missing
folder merely because the earlier listing does not contain the new collection.

This was reproduced in the RC18 composition with the directory-creation identity callback. The
first attachment uploaded, while its sibling remained local with a visible missing-parent error.
No local attachment was lost. The unit regression invokes that callback's state change explicitly
so this topic remains independent of the feature that supplies the production callback.

The correction snapshots the missing tracked parents before file workers run. Existing missing
parents remain held. Every upload still checks the current collection identity before writing;
revocation, replacement, permissions and file preconditions keep their existing guards.

Tests: `guardedDeletePropagation.test.ts` covers the deterministic sibling reproduction and the
existing inaccessible/protected-folder cases. `newFolderSiblings.b1.test.ts` checks one-session
uploads, remote bytes, the peer copy and file IDs against a real Nextcloud server, with a new and
an already existing parent.

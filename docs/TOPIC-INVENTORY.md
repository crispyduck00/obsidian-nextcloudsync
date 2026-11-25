# Topic inventory

The maintained selection is 28 independent upstream-based topics: six features, twenty-one fixes and one documentation topic.
All use pristine upstream 1.0.18 (`21f89023fdaee58068276df3cff876fcc74a1e95`); no selected topic contains another selected head.
The exact integrated set is established by Git ancestry and the candidate, not by all visible remote refs.

## Selected functional topics

| Topic | Head | Draft PR |
| --- | --- | --- |
| `features/client-push` | `ad00fe975f7dc8d04156cb6848ed78e1842a8126` | #13 |
| `features/mobile-sync-status` | `a57c82287254d41a5f5d5b0881c76153ac1e5cdc` | #15 |
| `features/mobile-watch` | `8341989497075ce51aaf96076491d986b1587baa` | #14 |
| `features/new-item-delay` | `e17dc68f8d6c5d3ae1acf2489c26e5c300225a83` | #34 |
| `features/version-history` | `dd96592b8a89434e03285c642b0936d3dd5131fe` | #16 |
| `features/watch-debounce` | `8e40fe4d8899bdcf22aabe422dcce0b1eed7e3c8` | #35 |
| `fixes/automatic-sync-collision-feedback` | `6b7469aecd30abdc35a2d28d131ce754a59facfe` | #6 |
| `fixes/compare-markdown-diff` | `8f1b64c6c5d012d9aaa3ff89406acd348e871719` | #7 |
| `fixes/conflict-marker-state` | `c7fc1a5d2beb4c13f51f732d1d5deb74cd340f92` | #8 |
| `fixes/guard-local-download` | `6a15b511b5dcfd6470e8fc70ff104acff5a68b91` | #33 |
| `fixes/guarded-folder-reconciliation` | `dfa9bfba8e138e4e0f7e130d4d09253534290350` | #36 |
| `fixes/local-vault-availability` | `6ad8e13df168d706ca34a85ac2c73d6a420e3692` | #37 |
| `fixes/optional-settings-mockup-test` | `b2d9524ee1ffc0d4d8335631d7db890e6a24816f` | #9 |
| `fixes/oversize-root-etag` | `4908a8551a90741c00208612edb88ee716bf98a9` | #32 |
| `fixes/persistent-file-renames` | `388ac755a000b0772407f073cf988d4850742f18` | #38 |
| `fixes/preserve-prefix-merges` | `764ebc1b5aa889abdf196639046fffb58b0beffb` | #39 |
| `fixes/refresh-remote-file-identity` | `a6b0414807fbefb8a30c8e77e235f2b63dfd5332` | #3 |
| `fixes/remote-file-id-index` | `ae1d2cfea32e66ca41092535f5b9788d312cd9d8` | #30 |
| `fixes/remote-rename-safety` | `1ac7b5912bb05f43c3d3a445d9fe3adc75f63ace` | #43 |
| `fixes/scoped-version-history` | `c51a7f5f657bea5bc1bf8ecbe6a21422a981d76e` | #40 |
| `fixes/sync-activity-coordination` | `d3470ed94972788dbab02ad5bfc8eb352032eee7` | #31 |
| `fixes/upload-snapshot` | `13a6ce8abe665e81935234cbefda6177d5cf598a` | #41 |
| `fixes/version-restore-state-convergence` | `3c0c3f87bea134977015855fc88c30cf41bf8ad6` | #17 |
| `fixes/watch-connection-recovery` | `fb7ad23b8230b92a6de96e49221670749403fb70` | #42 |
| `fixes/watch-folder-delete-safety` | `94f1f16e4a833b70d014d715fdbdacf8112c27aa` | #12 |
| `fixes/watch-own-debug-log` | `7c2e3c099f3483873e5bbb6b13b692980140aefc` | #5 |
| `fixes/watch-rename-pending-upload` | `2cdd3a13390067f9124bd4c6f729439022b3d27a` | #4 |

`docs/fork-overview` owns this inventory, workflow and acceptance documentation (Draft PR #20); its head is recorded by the candidate merge to avoid a self-referential document hash.

## Historical and superseded refs

| Ref | Maintained replacement / reason |
| --- | --- |
| `features/first-upload-delay-rc8` | features/new-item-delay |
| `fixes/creation-renames-rc8` | fixes/persistent-file-renames |
| `fixes/mirror-empty-remote-directories` | Superseded by upstream 1.0.13 |
| `fixes/mirror-state-persistence` | Superseded by upstream 1.0.13 |
| `fixes/observed-folder-delete-recovery` | fixes/guarded-folder-reconciliation |
| `fixes/require-local-vault-before-delete` | fixes/local-vault-availability |
| `fixes/watch-initial-connection-rc8` | fixes/watch-connection-recovery |

These refs are not additional selected product patches. They are retained for provenance; this change deletes no branch and rewrites no published commit.

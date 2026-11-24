# fixes/watch-connection-recovery

## Problem and behavior

A Watch operation can fail while establishing its DAV connection, before its normal per-file error handler runs. Keep that failure inside the Watch operation's error boundary so it is reported without escaping its fire-and-forget host callback.

An edited file remains in the ordinary retry queue when connection setup fails. Subsequent permitted reconciliation can inspect the current file instead of losing the edit request. Existing path locks and busy handling remain the coordination mechanism.

## Upstream base and independence

- Upstream base is 1.0.18, commit `21f89023fdaee58068276df3cff876fcc74a1e95`.
- The isolated topic contains `4764bd3d02f243a3d51442d8641d1da91790d3ae` and `e7f71b1ffd322334f1663b42a8fad98a6d1a9efb`. The first commit is directly on upstream.
- This is a general Watch fix with no Client Push or Android-watch dependency. Full-sync connection recovery and transport reconnection are maintained in their own existing paths.

## Validation and limits

`sync/watch/watchOperations.test.ts` injects rejected connection setup into file sync, deletion and folder operations. It also verifies that a file edit is queued after a transport failure. The doc-only topic check runs that suite and the existing Watch overlap, deletion and Wi-Fi policy suites, followed by TypeScript build and source lint. Server outage and two-device recovery are additionally exercised by the integrated candidate.

The standalone topic verification passed 68 assertions in 4 suites, plus the production build and source lint.

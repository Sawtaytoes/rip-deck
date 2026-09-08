# Only copy-stage kernel errors affect rip outcomes

- **Status:** Accepted
- **Date:** 2026-09-08
- **Type:** Rip outcome / health evidence
- **Supersedes:** —
- **Superseded by:** —

## Decision

Rip Deck retains the complete job-wide `ioerr_cnt` delta in each feature vector, but only increments attributed to a MakeMKV copy stage can affect a rip's read-error count, warning outcome, health verdict or troubled-corpus classification. `Copying …` and `Saving all titles …` are copy stages; startup work such as `Scanning CD-ROM devices` and `Opening Blu-ray disc` is not.

The bay-ledger reader repairs completed outcomes written by earlier builds. It joins a persisted record to its `<jobUuid>.features.json`, then replaces the legacy merged count with the maximum of MakeMKV's saved read-error count and copy-stage kernel errors. A missing or malformed feature vector leaves the record unchanged. The raw vector is never rewritten.

A real MakeMKV `MSG:2003` read error remains a warning on a verified backup. A kernel error during copying remains a warning even when MakeMKV reports none, and the warning names the kernel as its source.

## Context

Three completed UHD cards showed 3, 3 and 4 `read errors`. Their saved evidence showed a different result: MakeMKV recorded zero read errors, content-hash verification passed, and all kernel increments occurred during `Scanning CD-ROM devices` or `Opening Blu-ray disc`. Those intervals completed zero reads and transferred zero sectors. `Copying all files` recorded no kernel increment.

`describeRipOutcome` took `Math.max(makemkvReadErrors, wholeJobKernelErrors)`. That erased the source and timing distinction. It also persisted the false count in `bays.json`, so correcting only future rip completion would leave the three existing cards wrong after the deployment restart.

## Why

An optical-drive probe can fail and retry a command before the payload copy starts. That counter movement is useful hardware evidence, so deleting it would make later diagnosis weaker. It is not evidence that a sector in the completed backup failed to read.

Stage attribution preserves both facts. The feature vector keeps the job total and every per-stage delta. The operator-facing outcome uses only the stage where disc data is copied. Re-reading the vector during ledger adoption also corrects already-saved cards without a ledger-version bump, without changing stored paths, and without mutating historical evidence.

## Evidence

- Owner, 2026-09-08, chat `t3code-7308e9f1`: “We should fix the warnings about errors that aren't errors and remove the extra "4K" on the rip location”.
- Regression coverage replays a vector with three scan increments, one opening increment, zero MakeMKV read errors and zero copy increments. The whole-job total remains four while the adopted `/json` rip reports `success`, zero read errors and no warnings.
- Separate tests retain MakeMKV read errors and kernel increments in `Copying all files` / `Saving all titles …`.

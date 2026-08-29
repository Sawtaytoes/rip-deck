# A failed backup carries no completed-copy warning

Status: Accepted
Date: 2026-08-29
Type: Rip outcome / operator message
Supersedes: The failed-run warning clause of `2026-08-27-a-read-error-on-a-verified-backup-is-a-warning-not-a-failure.md`
Superseded by: —

## Decision

`RipWarning` describes a successful, verified copy with a caveat. It is built
only when `failureReason === null`. A failed rip may retain its read-error count
and offsets as failure evidence, but it carries no sentence that says a backup
finished, verified or exists.

A single real read error also has its own `disc_read_error` health verdict. The
engine must not fall through to `disc_marginal_slow`, whose message states that
the run is reading cleanly. One or two offsets do not justify inventing dirt or
a scratch; the correct instruction is to retry the disc in another drive.

## Context

Four DVD cards said both of these things:

- `Backup failed` / nothing was written at the destination.
- `The backup finished and its structure verified, so there IS a copy`.

The raw MakeMKV logs ended in `MSG:2003`, `MSG:5069 "Backup failed"` and
`MSG:5080 "Backup failed."`; no output file existed. `summariseRip` built
warnings before it decided whether the run succeeded, so the warning template
asserted a successful structural check that never happened. The health engine
then ignored one unclassifiable error location and called a zero-throughput run
"reading cleanly".

## Why

A warning modifies a success. It cannot also explain a failure because its
sentence depends on the verified-copy precondition. Failure evidence belongs in
the failure detail and the verdict evidence, where it does not assert an output
that is absent.

## Evidence

- Slot 4 job `d5234bea-77ef-4a15-b82a-34aaffd0e164`: one read error at byte
  826540032, `Backup failed` twice, zero output, yet the UI asserted a verified
  copy and `Slow but reading cleanly`.
- Slots 1–3 reproduced the same contradiction after the USB reset.
- Regression tests assert empty warnings on failed structural output and on an
  explicit MakeMKV failure, plus a `disc_read_error` verdict for one offset even
  when throughput is zero.

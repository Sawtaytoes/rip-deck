# Job controls cancel safely, and warning cards scan

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Product / Safety
- **Supersedes:** —
- **Superseded by:** —

## Decision

Rip Deck's dashboard sends job controls to its own daemon through
`POST /api/bay-action`. This is a same-origin application API. It is not a new
service-to-service bridge.

`Cancel` aborts only the selected rip, waits until its ripper has stopped, then
opens that bay's tray through the existing guarded tray command. It never opens
a tray while a rip still owns the drive.

`Keep trying`, `Give up`, and `Clear quarantine` now reach the watcher. Keep
trying suppresses the stall watchdog for that live rip. Give up stops that rip
but keeps its partial output. Clear quarantine resets the bay's start counter
and returns it to normal inspection.

`Retry in another drive` is not offered. It described a manual operation:
eject a disc, move it to another physical bay, and start a new rip there. Rip
Deck cannot move physical media, so a button with that label was a false promise.

Warnings use one short sentence per line. The card separates what happened,
what the copy state is, what MakeMKV cannot report, and what the operator should
do next.

## Context

The live page showed enabled Cancel, Keep trying, Give up, Clear quarantine,
and Retry in another drive controls. The web data source returned a local error
for all job actions because the watcher had no public control surface. The
daemon already had an `AbortController` per rip, but only daemon shutdown could
reach it.

The warning for a verified backup with a read error was accurate but presented
as one large paragraph. It combined the error location, the copy result,
MakeMKV's unknown recovery result, and the manual verification step.

## Why

- A Cancel control must reach the selected job. A message that says it cannot
  is not a control.
- Tray movement stays behind the existing ownership check. The cancellation
  must land before the eject command runs.
- A physical-media workflow cannot automate moving a disc between drives.
- Short lines make an integrity warning usable while standing at the tower.

## Evidence

Owner, 2026-08-29:

> "I need to eject this disc now."

> "I also have no clue what 'retry in another drive' does."

> "There's a lot of text here in one large paragraph. This should be separated
> out to be very clear and concise."

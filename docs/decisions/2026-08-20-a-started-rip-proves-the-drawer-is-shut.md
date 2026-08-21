# A started rip proves the drawer is shut, so it corrects the tray memory

- **Status:** Accepted
- **Date:** 2026-08-20
- **Type:** bugfix
- **Supersedes:** -
- **Superseded by:** -

## Decision

`applyRipStarted` records `lastTrayCommand: "close_bay"` alongside the
`starting` -> `ripping` transition. A drive cannot read a disc with its drawer
hanging out, so a bay that has started ripping is shut, and that is knowledge the
tray memory did not otherwise have.

Two report strings changed with it:

- The refusal names the verb of the command that actually ran, so a
  `close_trays` press refused by a mid-rip bay no longer answers *"Refused to
  **open** slot 2."*
- The opened-drawer list is sorted by slot rather than concatenated as
  `opened` then `openedNotRipped`, which had produced *"slots 2, 1, 3, 4, 5, 6,
  7, 8 and 9."*

## Context

`lastTrayCommand` is the only drawer knowledge there is - there is no reading of
the drawer to be had without a `CDROM_DRIVE_STATUS` ioctl - and it is written
**only when rip-deck itself moves a tray**. The operator pushing a drawer shut by
hand is invisible to it, and that is exactly how a disc gets loaded: press Open
trays, put the disc in, push the drawer shut.

So a bay can carry `open_bay` into a rip and out the far side of it. `open_trays`
folds that field to ask *"is every finished bay already open?"*, and against the
stale value the answer is yes: the escalation skips its first step, resolves
`openScope: "all"` and opens every drawer in the rack on the **first** press
instead of the one bay with a disc to collect.

Measured on the live tower, 2026-08-20: one finished disc in the rack, eight
empty bays, and the first press answered *"Opened 9 drives."* The same tower
proved the mechanism the other way round the same night - with that bay's memory
reading `close_bay`, the identical press opened it alone and skipped the other
eight as `skipped_not_finished`.

## Why

The fix goes at the rip, not at the fold, because the rip is where real
information arrives. Widening the fold (say, treating a finished bay as
collectable regardless of remembered drawer position) would have papered over a
memory that is simply wrong, and left it wrong for `close_trays`, which trusts
the same field to decide what it opened.

`starting` -> `ripping` is the narrowest place to put it. It fires once, on
evidence that is physical rather than inferred, and it cannot fire for a bay that
never ripped.

The escalation itself was not changed. It was reading a lie, not reasoning badly.

## Evidence

- Regression test: a bay whose ledger carries `open_bay`, which then rips to
  completion. Before the fix the first `open_trays` press opens the empty bay
  too; after it, only the finished one moves.
- The suite's existing escalation test could not have caught this. Its bay
  reaches `done` with `lastTrayCommand` still `null`, because a disc arriving in
  a previously empty bay re-arms the bay and clears the field - the stale value
  only survives when the drawer was opened before the disc went in.
- `controllableRipper` never reported `onRipStarted`, so every bay in the suite
  sat in `starting` and the `starting` -> `ripping` transition was untested
  through `startWatcher`. It now reports on request; six existing tests pin the
  `starting` phase, so it is opt-in rather than the default.

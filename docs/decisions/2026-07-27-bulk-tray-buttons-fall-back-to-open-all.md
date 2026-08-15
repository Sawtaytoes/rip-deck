# With nothing to be selective about, the bulk tray buttons open all and close all

- **Status:** Accepted
- **Date:** 2026-07-27
- **Type:** Correction
- **Supersedes:** the `close_open` target set in
  [2026-07-27-tray-memory-beats-disc-presence.md](2026-07-27-tray-memory-beats-disc-presence.md)
  and the bulk half of
  [2026-07-26-operator-triggered-eject-over-mqtt.md](2026-07-26-operator-triggered-eject-over-mqtt.md)
- **Superseded by:** —

## Decision

The two bulk tray commands degrade into a plain manual control when there is
nothing selective to do (**G5**):

- **`open_completed`** opens the finished bays when the tower has any, and
  otherwise opens **every present bay that holds a disc**. "Otherwise" is the
  new input `isAnyBayFinished`, answered by the caller.
- **`close_open`** closes **every present bay**, always.

Two things do **not** change:

- ⚠️ **The refusal is still `decideTrayBayAction`'s first branch.** A
  `starting`/`ripping` bay is refused in fallback mode exactly as in selective
  mode. "Open all" never means "all nine".
- **An empty bay is still skipped** by ▲, in both modes.

## Context

The owner, standing at the tower, twice in one evening:

> *"I'm trying to close the drives. If there's no pass-fail like right now, the
> button should open and close all of them."*

> *"I really would like the HA Zigbee RODRET button to also control them. Much
> easier that way. It can open all and close all if no clear/fail."*

## Evidence

Nine bays holding his audio CDs, nothing ripped that session. `open_completed`
opens only a **latched** bay ([`isBulkOpenEligible`](../../packages/daemon/src/rip/trayCommand.ts)),
so every bay answered `skipped_not_finished` and **not one drawer moved**. The
report was accurate and the button was, to the person pressing it,
indistinguishable from broken.

This is the second defect found on this function in one day by pressing the
physical button, and the second the test suite was green through — 1139 tests
for [the `close_open` regression](2026-07-27-tray-memory-beats-disc-presence.md),
1157 for this one. Both were cases the tests asserted rather than measured.

## Why

- **A control that reports "nothing to do" is still a control that did
  nothing.** The selective rule is right after a rip session and useless
  outside one, and the RODRET has exactly two gestures — there is no third
  press that means "no, really".
- **Closing is free.** `CDROMCLOSETRAY` on a closed tray is a no-op. That was
  already the justification for `close_open` acting on a wider set than it can
  prove is open (tray position is unreadable: sysfs reports media, not the
  door). Widening it to every present bay is the same argument taken to its
  end, and it is the only set that always round-trips ▲ then ▼. The
  `lastTrayCommand === "open_bay"` short-circuit from this morning is now
  **redundant rather than wrong**, and is kept as the statement of what was
  measured.
- **The tower-wide question is not the per-bay function's to ask.**
  `decideTrayBayAction` sees one bay. `runTrayCommand` folds `hasFinishedDisc`
  over the probe it already took and passes `isAnyBayFinished` down — folds
  decide and stay pure, and no lookup gets smuggled into an operator
  ([RxJS decision](2026-07-26-rxjs-on-the-async-edges-not-the-folds.md)).
  The input is optional and **defaults to the selective reading**, so a caller
  that never asked the tower gets the narrow behaviour rather than a surprise
  nine-drawer open.
- **`hasFinishedDisc` requires the disc to still be in the bay.** A latched bay
  the operator already emptied is finished with, and pressing ▲ would still
  move nothing — the exact dead button this record exists to remove. So the
  fallback engages precisely when the selective open would have been a no-op.

## Why ▲ still skips an empty bay

Opening an empty tray is harmless but pointless, and three things make it
worse than nothing:

1. The request is *"let me get at the discs"*. An empty drawer has none.
2. It inflates the spoken count — "Opened 9 drives" when there are three discs
   to collect.
3. An open tray and a closed empty one are the same sysfs reading, so the bay
   ▲ opened last press looks empty this press. Opening it again is a tray
   flapping for nothing, which is the shape of the flap-storm rule
   (`AGENTS.md`: **never eject-loop**).

`open_bay` remains the way to open a specific empty bay.

## Note for whoever reads this next

The spoken message drops the *"N of those were never ripped"* sentence in
fallback mode. That line is news after a rip session and noise on an idle
tower, where nothing was ripped and the operator asked for all of them on
purpose. The per-bay `opened_not_ripped` result is still reported and still
counted; only the sentence changes.

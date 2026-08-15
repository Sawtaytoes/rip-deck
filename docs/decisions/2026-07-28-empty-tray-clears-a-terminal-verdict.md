# An empty tray clears a terminal verdict, even across a flapping drive

Status: Accepted
Date: 2026-07-28
Type: correctness / bug fix
Supersedes:
Superseded by:

## Decision

A bay's live state reflects **what is in the drive right now**. A terminal
verdict (`completed`, `failed`, `needs_attention`) belongs to the *rip record*
and the console log — not to the bay tile once the disc is gone. When the tray
is confirmed empty, the bay re-arms to `idle` and shows nothing, "like new,"
until a new disc arrives.

That was already the intent (`decideBayAction` → `rearm` after
`rearmEmptyObservations` confirmed-empty reads). The fix makes it actually hold
when the drive is unstable:

`applyBayDecision` no longer **resets** `emptyObservationCount` to `0` on an
off-bus poll. It **holds** it. The count resets only on a disc we can actually
see — the drive present **with** media. A running rip's tray readings still
belong to the rip, not to this count.

```
off the bus        -> hold the count (we can't see the tray; assume nothing)
present, has media -> 0  (a disc is really there — definitely not empty)
present, empty     -> +1 (a confirmed-empty read)
```

## Context

Found live on 2026-07-27. Slot 5's `05 - Pioneer BDR-212U` sat latched `failed`
("Not enough information to judge this rip yet · cyanrip exited null") on the
dashboard **with no disc in the drive.** The owner had ejected the disc hours
earlier while testing AccurateRip, and the bay never cleared. He was right that
it was a bug, and right that it predated the re-cabling.

The rip failed during the **2026-07-27 12V-into-5V incident**
(`../2026-07-27-12v-into-5v-usb-incident.md`),
when the tower's USB drives were flapping on and off the bus every few seconds.

Re-arm needs two **consecutive** polls where the drive is present *and* reports
an empty tray (`rearmEmptyObservations: 2`). The old accrual was:

```js
const emptyObservationCount =
  observation.isDrivePresent && !observation.hasMedia
    ? bay.emptyObservationCount + 1
    : 0            // <- ANY off-bus poll threw the tally away
```

So while the drive flapped, the count oscillated `1 → 0 → 1 → 0` and never
reached `2`. The tray was empty; the debounce simply kept getting reset by the
flap before it could complete. The verdict latched forever.

The re-cabling that night then spawned a *second*, duplicate bay under the
drive's new USB port path, so the board showed both the frozen `05 failed`
ghost and a live `05 idle`. Two distinct problems stacked; this ADR fixes the
first.

## Why

**The invariant the owner stated, verbatim:** *"If they stay like that, it
doesn't work right. You can keep the failed state in the logs, but there's no
disc in there, so the failed state should be cleared. It should only be in some
sort of success or failed or progress state when there's a disc in there. Once
the drive was ejected, it should be like new (idle) until it sees a new disc."*

**Holding the count is safe against the re-rip hazard that
[`2026-07-26-bay-memory-survives-a-restart.md`](2026-07-26-bay-memory-survives-a-restart.md)
guards.** Re-arm only ever fires on a poll where the drive is present *and*
empty — `decideBayAction`'s `!isDrivePresent` guard returns `hold` first, so an
off-bus poll can never itself trigger a re-arm. A `done` disc that is still
physically in the tray reads `hasMedia` on every present poll and resets the
count to `0`, so it never re-arms and never re-rips. Only a genuinely-empty tray
accumulates. The change relaxes *"two empties in a row"* to *"two confirmed
empties with no disc seen in between"* — nothing weaker.

**The error direction stays safe.** If the drive is off the bus forever after a
single empty read, the count holds at `1` and the bay never re-arms on its own —
exactly the "don't treat a vanished drive as an ejected disc" rule
(`watcher.test.ts`), which still passes unchanged.

## Evidence

- Root cause traced to `applyBayDecision`'s `: 0` branch (`watcher.ts`), with
  the flap reproduced from the daemon log (`9 → 0 → 6 → 5 → 9 → 0 drive(s)
  present`) and the `error -71` USB enumeration failures in `dmesg`.
- The stuck record's shape confirmed from
  `$RIP_DECK_STATE_DIR/bays.json.bak-needs-attention-20260726`: `phase: "done"`
  + an `outcome`.
- Regression test: `watcher.test.ts` →
  *"re-arms across a drive that flaps off the bus between empty reads"* — feeds
  `present-empty → off-bus → present-empty` and asserts `rearm` + `phase: idle`
  + `outcome: null`. Fails on the old `: 0`, passes on the fix. Full suite: 54
  pass.
- Owner quote + chat: 2026-07-28, the Rip Deck power-incident session.

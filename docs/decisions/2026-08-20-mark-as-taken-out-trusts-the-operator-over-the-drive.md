# "Mark as taken out" trusts the operator over the drive's media reading

- **Status:** Accepted
- **Date:** 2026-08-20
- **Type:** Correction
- **Supersedes:** the "a PRESENT drive still holding its disc is left alone"
  clause of
  [2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md](2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)
- **Superseded by:** [2026-08-29-mark-as-taken-out-retires-finished-cards.md](2026-08-29-mark-as-taken-out-retires-finished-cards.md)

## Decision

**`clear_loaded` clears the reminder for every latched bay, whether or not the
drive is on the bus.** A bay whose drive has gone is dropped as before; a bay
whose drive is still present and still reporting its finished disc is marked
`isLoadedDismissed` and drops out of the loaded-discs summary.

Two rules bound it, and both matter more than the clause being reversed:

- **It is display-only.** The bay stays latched, keeps its fingerprint, its
  start counter and its ledger record, and `open_trays` still offers to open
  it. Nothing about a rip decision reads the flag, so a disc that genuinely is
  still in the tray is still held rather than re-ripped. Deleting the bay
  instead — the obvious shortcut — rebuilds a fresh `idle` bay on the next
  poll, and a fresh idle bay with a finished disc in it re-rips that disc.
- **It dies with the disc it was about.** `start`, `rearm`, `quarantine` and
  the outcome latch all clear it, so a dismissal can never silence the reminder
  for the next disc. It rides `BayLedgerRecord` — the disc-shaped record, whose
  lifetime is exactly the disc's — so a deploy landing after the press does not
  bring the reminder back. This is the mirror of `BayTrayRecord`'s argument for
  living *outside* that record: same test, opposite answer.

Separately, and for the same report: **the button renders the daemon's answer
whenever the banner is still on screen.** Being still mounted is proof the
press changed nothing, and the sentence explaining that was previously thrown
away.

## Context

The owner, 2026-08-20, with one Blu-ray latched in slot 2 and the disc already
physically out of the drive:

> *"'Mark as taken out' does nothing. I clicked it a number of times. Heck, the
> disc was already taken out."*

`runClearLoaded` skipped every present bay. The reasoning written down at the
time was:

> *"A PRESENT drive still holding its disc is left alone — clearing must never
> claim a disc anyone can see is gone; for those the honest path stays Open
> trays."*

That reasoning assumed the drive's media reading is evidence. **On this rack it
is not** — these drives keep reporting their disc long after the tray opens,
which is the whole of
[2026-07-27-tray-memory-beats-disc-presence.md](2026-07-27-tray-memory-beats-disc-presence.md)
and is why *"open the tray and close it again"* was retired as an instruction.
Nobody could see the disc was gone; only the human standing at the rack knew,
and this button is the only thing he has to say it with.

The interaction of the two facts is what made the button useless rather than
merely conservative: the reminder's own sentence is *"Press Open trays to get
it out"*, which means the tower is on, which means every disc it names is a
present one. So the present-bay skip was not an edge case — it was every case.
`cleared` came back 0 every time, and the count is all the reminder reads.

## Why

- The reminder is a **chore**, and a chore is done when a human says it is
  done. There is no sensor for "the disc is in my hand", and there will not be
  one: the disc comes out of a tray the drive still claims is full.
- Reversing the clause costs nothing that was actually protecting anything. The
  thing worth protecting is *not re-ripping a disc that is still in there*, and
  that is protected by the latch, which this does not touch.
- Deleting the bay would have been the smaller diff and the wrong one; the
  ledger's own comments say why, in the words of the restart that re-ripped
  three Troy discs.

## Evidence

- Owner, 2026-08-20, quoted above; screenshot of the banner with **Mark as
  taken out** beside it, slot 2, `Ulysses`, after the disc was removed.
- Live `/json` at the time: `loaded_discs.count: 1`,
  `bays[1].disc_size_sectors: 88995328`, `is_present: true` — a present drive
  reporting a disc that was not in it.
- `startWatcher loaded-discs memory > ⚠️ clear_loaded clears a PRESENT bay
  whose drive still claims the disc` fails without the change, and asserts the
  next poll starts no rip.

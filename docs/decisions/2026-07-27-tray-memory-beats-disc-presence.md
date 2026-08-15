# What rip-deck did to the drawer beats a guess about the door

- **Status:** Accepted
- **Date:** 2026-07-27
- **Type:** Correction
- **Supersedes:** the `close_open` half of
  [2026-07-26-operator-triggered-eject-over-mqtt.md](2026-07-26-operator-triggered-eject-over-mqtt.md)
- **Superseded by:** —

## Decision

Where the tray's position matters, **`lastTrayCommand` — the last tray command
rip-deck itself issued for that bay — is authoritative, and `hasMedia` is only
the fallback for a bay rip-deck has no memory of commanding.**

Two call sites, both corrected:

- `decideTrayBayAction`, `close_open`: a bay whose last command was `open_bay`
  is **closed**, whatever the media reading says.
- `nextTrayCommandFor` (web): the remembered command decides the next press; disc
  presence is consulted only when there is no memory, and then always offers
  `open_bay`.

## Context

Stage 7 gave the dashboard a tray control, because the owner asked for one:

> *"MQTT or not, I should be able to eject it, and then pushing eject again
> should close it."*

Tray position is genuinely unreadable — sysfs reports **media**, not the **door**,
and an ioctl Node cannot issue is the only thing that would answer properly
(`eject-and-durable-bay-state.md` §2). Both
call sites therefore leaned on what looked like the one *fact* among the
inferences: **a drive cannot read a disc through an open drawer, so a disc means
the tray is shut.**

The tower disagrees.

## Evidence

Measured against the live rack on 2026-07-27, immediately after deploying
`rip-deck:0.7.0`, with the three Troy discs held in slots 7–9:

```
POST /api/tray {"command":"open_completed"}
→ "Opened 3 drives: slots 7, 8 and 9."   opened_not_ripped: 3

POST /api/tray {"command":"close_open"}
→ slot 7  skipped_has_disc  "there is a disc in this bay, so its tray is already closed"
→ slot 8  skipped_has_disc
→ slot 9  skipped_has_disc
```

All three bays went on reporting `hasMedia: true` **after** being opened. So:

1. **The owner's two bulk gestures did not round-trip.** Short-▲ (`open_completed`)
   opened three trays and short-▼ (`close_open`) refused to close them. Only a
   per-bay `close_bay` would, and the physical button has no such gesture.
2. **The toggle could never send its second press.** With a disc present
   `nextTrayCommandFor` returned `open_bay` unconditionally, so a loaded bay
   offered "open" forever — which is the entire feature the owner asked for.

Both were green in 1139 tests, because every test asserted the assumption rather
than measuring the drive. One test asserted the defect explicitly
(*"opens a bay holding a disc, whatever it last did"*); it has been rewritten
rather than deleted, since it is the clearest statement of what was believed.

After the fix, on the same hardware:

```
open_completed → opened_not_ripped: 3   (slots 7, 8, 9)
close_open     → closed: 9              (slots 1-9, including 7, 8 and 9)
```

Nothing re-ripped: no `.rip-deck-incomplete-*`, no rip container, and all three
Troy folders byte-identical to the pre-deploy listing.

## Why

`hasMedia` was the only signal available when `close_open` was written. It is not
any more: [the bay ledger now remembers its last tray command per bay](2026-07-26-bay-memory-survives-a-restart.md)
and that memory survives a restart. A record of *what rip-deck did* strictly beats
an inference about *what the hardware must therefore be*, and the inference has
now been shown to be wrong on the drives actually in the tower.

The fallback is unchanged and still honest: with no memory, `hasMedia` is all
there is, and closing an already-closed tray is a no-op — so the cost of being
wrong in that direction is nothing.

⚠️ **The safety ordering is untouched.** The refusal that protects a running rip
is still `decideTrayBayAction`'s first branch, and nothing added here can reach
around it. A locked-in test covers a `ripping` bay that rip-deck once opened.

## Note for whoever reads this next

Do not "simplify" this back by trusting disc presence. It reads like the solid
ground in a function full of guesses. It is not — it is a guess about a door,
inferred from a medium, and this hardware does not honour it.

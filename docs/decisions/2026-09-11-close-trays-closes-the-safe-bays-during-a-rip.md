# Close trays closes the safe bays during a rip

- **Status:** Accepted
- **Date:** 2026-09-11
- **Type:** UX / hardware safety
- **Supersedes:** `2026-08-29-bulk-tray-moves-are-serial-and-close-is-blocked-during-a-rip.md` (clause 1 only), and `2026-09-08-close-trays-quietly-skips-during-an-active-rip.md` in full
- **Superseded by:** —

## Decision

1. `close_trays` closes every bay whose `lastTrayCommand` is `open_bay`, whether
   or not another bay is `starting` or `ripping`. There is no tower-wide veto.
2. A bay that is itself `starting` or `ripping` is never sent a tray command by
   a bulk close. It returns `skipped_untouched`, not `refused_ripping`.
3. A targeted `close_bay` against an active bay still returns `refused_ripping`.
4. Bulk tray moves stay serial. At most one `eject` process may have a motor
   command in flight. That rule is now the only motor-load protection, and
   clause 2 of the 2026-08-29 decision keeps its full force.
5. `decideTrayBayAction` no longer takes a tower-wide rip fact. The input is
   removed, not merely unused, so no other bay's phase can veto this drawer.

## Context

The owner reported this four times. The last report, 2026-09-11:

> "Rip Deck, when I click 'open trays', they open. When I click 'close trays',
> if a rip is ongoing, they don't close, it acts as if I'm trying to open them
> again. I need it to close the trays. I've asked this 4 times already."

On 2026-08-29 a bulk close moved several drawers **at once** while three bays
ripped. The shared powered USB hub reset, all nine drives re-enumerated, and
all three MakeMKV jobs ended `Posix error - No such device`. The repair that
day did two separate things:

1. It made every bulk tray move **serial**.
2. It also made a bulk close move **nothing at all** anywhere on the tower
   while any rip ran.

Only the first addresses the fault. The second is what the owner has been
reporting since. Two follow-up changes, 2026-09-08 and earlier, adjusted how
that no-op was **worded** — quiet skip instead of an error, correct spoken verb
— and never restored the behaviour. That is why the report repeated: each fix
answered the symptom he described rather than the thing he asked for.

## Why

- **The asymmetry has no hardware basis.** `open_trays` already drives these
  same motors on this same hub, serially, while other bays rip. That is its
  normal daily use on this rack and it has never reset the bus. A close is the
  identical motor travelling the other way.
- **Serial motion is the guard that fixed the 2026-08-29 fault.** The failure
  was simultaneous motor inrush on one powered tree. One motor at a time removes
  it. The tower-wide block was a second guard laid over the top of the first and
  was never independently justified.
- **The button is pressed in exactly the blocked state.** Drawers open, discs
  collected, one long Blu-ray still running. A control that does nothing in its
  own primary state is indistinguishable from a broken control, which is how the
  owner described it.
- **The ripping bay's own drawer never needed a close anyway.** It is shut —
  that is what ripping means. Clause 2 costs nothing and keeps the one motor
  command that could destroy written bytes off the bus.

## Risk accepted, then measured

This section was written before the behaviour had been exercised on the rack.
It said the residual risk was not zero, because serial closing during a live rip
had not been proven on this hardware the way serial opening had. It was accepted
because the owner asked for the behaviour four times, the hub reset is
attributed to parallel motion, and the failure mode is recoverable.

**It has since been measured, and the hub was untouched.** See the added
evidence below. The stated repair if a reset is ever seen during a *serial*
close is unchanged: a settle delay between moves, never a restored tower-wide
block.

## Evidence

- Owner, 2026-09-11, quoted above. Three earlier reports are recorded in
  `2026-08-29-bulk-tray-moves-are-serial-and-close-is-blocked-during-a-rip.md`
  and `2026-09-08-close-trays-quietly-skips-during-an-active-rip.md`.
- Live tower, 2026-09-11: six bays ripping, slots 1, 2 and 6 idle. The deployed
  build carried both the quiet-skip and spoken-verb repairs, confirmed by
  `docker exec ix-rip-deck-rip-deck-1 grep -rl` against `/app`, and a Close
  press still moved no tray.
- `watcher.test.ts` now asserts the flipped behaviour on the exact live rack
  state: sr0 open, sr1 ripping, one `{ action: "close", devPath: "/dev/sr0" }`
  recorded and no command at all for `/dev/sr1`.
- `trayCommand.test.ts` asserts that a per-bay close decision for an idle opened
  bay is `{ action: "close" }` with no tower-wide input available to it.

### Added 2026-09-11, after deployment: measured on the rack

The owner had no discs loaded, so the during-a-rip path could not be reached by
ripping something. He asked for it to be faked instead. A scratch harness ran
the daemon **from source** with three things real and one fake:

- **Real:** `decideTrayBayAction`, the watcher, `POST /api/tray`, the dashboard,
  and the tray motors. `runTray` was the default one, pointed at the rip-deck
  container's own `eject` through the documented command-vector hatch, so every
  drawer really moved on the rack.
- **Fake:** `probeDrives` returned the nine real drives with a disc in each, and
  `runBayRip` never resolved for slots 4 and 7. Those two bays sat in `ripping`
  for the life of the process, narrating progress so the dashboard rendered them.

Result, with slots 4 and 7 ripping throughout:

| Check | Result |
| --- | --- |
| Targeted `close_bay` on slot 4 | `Refused to close slot 4: still ripping.` |
| `open_trays` | `Opened 7 drives: slots 1, 2, 3, 5, 6, 8 and 9.` |
| Kernel `CDROM_DRIVE_STATUS` after open | 7 drives report `TRAY OPEN`; slots 4 and 7 shut |
| `close_trays` | `Closed 7 drives: slots 1, 2, 3, 5, 6, 8 and 9.` |
| Kernel `CDROM_DRIVE_STATUS` after close | all 9 shut |
| `runTray` calls for the ripping drives | none |

Four complete open-and-close cycles were run this way — **28 close commands to
real motors while two rips were live**. Both rips survived, reaching 40.5
percent. `dmesg` recorded **no USB reset and no disconnect** at any point after
the tower powered on at 21:14:24; the last such events on the log predate the
test entirely.

That is the specific failure this decision removed a guard against, exercised
four times on the hardware that produced it, with no recurrence. The tray state
was read with the `CDROM_DRIVE_STATUS` ioctl rather than inferred from the
daemon's own report, so the two sources are independent.

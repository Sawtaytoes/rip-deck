# A `starting` bay does not refuse the Tower off press, and an identify timeout must resolve

Status: Accepted
Date: 2026-08-26
Type: code / safety
Refines: [The dashboard can switch the tower off, and remembers what it trapped](2026-07-30-the-dashboard-can-switch-the-tower-off.md)
— the "a running rip refuses the whole press" rule stands. What changes is
which phase counts as a running rip.

## Decision

Two changes, and the second is the cause of the first.

**1. `power_off` is refused by a `ripping` bay only. A `starting` bay is
skipped, not refused.** Every other command — `open_trays`, `close_trays`,
`open_bay`, `close_bay`, `rip_bay` — still refuses both phases, unchanged. The
skip has its own result kind, `skipped_starting`, so it is reported rather than
folded in with the bays that had nothing to do.

**2. `identifyDisc`'s per-read timeout resolves the promise itself.** It still
sends `SIGKILL`, and it now also answers with the events collected so far and
`unref()`s the child. Signalling a child is not a bound on a read.

## Context

The owner loaded 8 DVDs on 2026-08-26 and nothing ripped. Five bays sat in
`starting` for 75 minutes. He pressed Tower off and the dashboard refused. His
words: *"It won't let me turn off the tower."*

The tower's USB bus was wedged — the documented signature from
[the aux-power diagnosis](2026-07-24-active-usb-extension-aux-power-explains-the-wedge.md):
a `reset SuperSpeed USB device` storm, `scsi_eh_26/27/28` and three
`udev-worker` threads blocked uninterruptibly, and `I/O error … sector 8` on
three drives.

## Why

**Because the refusal protects written bytes, and `starting` has none.**
`starting` is settle → type → identify. `applyRipStarted` moves the bay to
`ripping` *before* the ripper child is spawned, on the makemkv path and the
cyanrip path both. So a `starting` bay has never had a ripper attached to it and
has never written a byte. The 2026-07-30 decision priced this exactly right —
*"trapping a disc costs a walk downstairs; a rip cut at 80% costs 90 GB and an
hour"* — and a `starting` bay is the first of those, not the second.

**Because `starting` had no upper bound, so the refusal was permanent.**
`identifyDisc` spawns `makemkvcon`, and a `makemkvcon` talking to a drive in
SCSI error recovery sits in uninterruptible sleep. A signal sent to a process in
that state is queued, not delivered. So `SIGKILL` did nothing, the child did not
die, `close` never fired, the promise never settled, and the bay stayed
`starting` for as long as the bus stayed down. Five `makemkvcon` children were
still unreaped 75 minutes later.

The file's own header claimed *"a wedged drive costs at most `maxAttempts x
timeoutMs`"*. That claim was false in the one case the timeout was written for.

**Because one refused bay refuses the whole press.** There is one power lead, so
the press is answered for all nine bays and any refusal stops it. That is
correct. Combined with an unbounded `starting`, it meant the Tower off button —
the only control on this dashboard that clears a wedged bus — was held shut by
the wedge it exists to clear. The owner had to go and pull the plug by hand,
which is the failure the button was built to remove.

**Because a tray move is genuinely different from a power cut.** Tray commands
still refuse `starting`. Opening a drawer under a live `makemkvcon` read is how
the eject/insert flap-storm starts (B3), and unlike mains it fixes nothing when
the bus is already down. The exception is about mains, and only mains.

## Evidence

- Owner, 2026-08-26: *"Rip Deck has 8 DVDs in and isn't ripping."* and *"It
  won't let me turn off the tower."*
- Live on the tower, 2026-08-26 20:07 CDT: 5 bays `starting` since 00:53 UTC,
  `active_count: 0`, no rip container running, no new folder under
  `/media/Disc-Rips`.
- `docker exec ix-rip-deck-rip-deck-1 ps`: five `[makemkvcon] <defunct>` and one
  `eject --cdrom /dev/sr5` blocked for 13 minutes.
- Host `dmesg`: `INFO: task makemkvcon:1411259 blocked for more than 120
  seconds`, the same for `scsi_eh_27` and `(udev-worker)`, and
  `eject:1416538 blocked for more than 241 seconds`.
- Every D-state thread cleared the moment mains was cut, with no host reboot —
  which is the whole argument for keeping that press reachable.
- Regression tests: the identify timeout test takes 4003 ms against the old
  code and 303 ms against the new.

## Consequences to watch

- `buildTowerPowerOffResponse` warns about **loaded** discs, and a `starting`
  bay is not counted as loaded. So a power cut during identify is warned about
  per-bay (`skipped_starting`) but not in the tower-level sentence. Left alone
  deliberately: widening `loadedDiscs` reaches the retained MQTT topic, the HA
  sensor, the dashboard banner and the reminder automation.
- The identify timeout now leaves an unkillable child behind rather than waiting
  for it. That is the point, and `unref()` is why it cannot hold the daemon's
  own shutdown open — but the child is still on the process table until the bus
  returns.

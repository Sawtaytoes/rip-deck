# Bulk tray moves are serial, and Close trays moves nothing during a rip

Status: Accepted
Date: 2026-08-29
Type: Hardware safety / tray commands
Supersedes: The parallel-move and close-during-rip clauses of `2026-07-30-open-trays-escalates-and-close-trays-is-plain.md`
Superseded by: —

## Decision

1. `close_trays` is tower-atomic while a rip is `starting` or `ripping`. Active
   bays are refused as before; every other bay is `skipped_untouched`. No tray
   ioctl is issued anywhere on the shared USB tree.
2. A bulk tray command moves eligible trays serially. At most one `eject`
   process may have a motor command in flight. The per-drive 20-second watchdog
   remains the upper bound for each move.
3. `open_trays` keeps its selective behaviour. It may open finished bays while
   another bay rips, but those opens are serial.

## Context

The owner opened the finished/failed trays while slots 1–3 ripped DVDs, then
pressed Close trays. Rip Deck correctly refused slots 1–3 but closed the other
known-open trays in parallel. Three seconds after the last press, the whole
USB tree disconnected. All three MakeMKV processes ended with `Posix error - No
such device` at different offsets.

The per-bay safety rule therefore protected the directly targeted drive but not
the hardware it shared. Parallel tray motors were a tower-wide operation even
though the code treated them as independent devices.

## Why

The complete USB tree is the failure boundary. Closing an idle drawer can
destroy a rip in another bay when the motor load resets the common powered hub.
Refusing only the active bay is insufficient. Serial motor commands reduce the
load even when no rip is active; blocking bulk close during a rip removes the
irrecoverable case entirely.

Serial execution can make a nine-tray command slower, especially when a drive
reaches its watchdog. That cost is bounded and recoverable. A lost multi-hour
rip is not.

## Evidence

- Owner, chat 2026-08-29: *"Then when I clicked 'Close Trays', all 3 ongoing
  rips failed."*
- Kernel log, 2026-08-29 01:08:15 local: `usb 2-2.3: USB disconnect`, followed
  by every descendant disconnecting, `error -71`, a hub power-cycle attempt and
  complete re-enumeration under new SCSI hosts.
- Robot logs: slots 1–3 failed at 536182784, 360742912 and 412581888 bytes with
  `Posix error - No such device`, then `MSG:5069`/`MSG:5080 Backup failed`.
- Daemon log: each active bay was refused before the disconnect, proving that no
  direct close ioctl reached those three drives.
- Regression tests assert that a bulk close moves zero trays when one bay rips,
  and that the maximum concurrent bulk tray count is one.

# Close trays quietly skips during an active rip

Status: Accepted
Date: 2026-09-08
Type: UX / hardware safety
Supersedes: The active-bay result and operator-reporting clause of `2026-08-29-bulk-tray-moves-are-serial-and-close-is-blocked-during-a-rip.md`
Superseded by: `2026-09-11-close-trays-closes-the-safe-bays-during-a-rip.md` — in full. The tower-wide no-op this record preserved was removed; a bulk Close now closes the safe bays during a rip.

## Decision

`close_trays` remains a tower-wide no-op while any bay is `starting` or
`ripping`. Every bay returns `skipped_untouched`, including the active bays.
The result has no refusal count, no error presentation and no spoken warning.

A targeted `close_bay` command against an active bay still refuses. The
tower-wide guard still issues no tray ioctl while a rip is active.

## Context

The 2026-08-29 safety repair correctly stopped all tray motors during an active
rip. It still classified each active bay as `refused_ripping`. The dashboard
and Home Assistant therefore reported an error when the user pressed the bulk
Close control, even though the expected result was to leave every tray alone.

## Why

The motor guard and the operator report answer different questions. The tower
must not move a tray because its shared USB hardware has already disconnected
under tray-motor load. That expected safety no-op is not a command failure.

A targeted request names an active tray directly and must still explain why it
cannot comply. A bulk Close press only asks Rip Deck to close the safe set. No
safe set exists while the tower is ripping, so silence is the useful response.

## Evidence

Owner, 2026-09-08: *"There's still a bug where it errors when when trying to
close trays while one rip is active"*

The live failure path returned `refused_ripping` for the active bay and
`skipped_untouched` for every sibling. No tray ioctl ran, proving that the
remaining defect was the result classification rather than motor control.

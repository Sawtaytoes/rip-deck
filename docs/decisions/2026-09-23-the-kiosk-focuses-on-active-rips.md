# The kiosk focuses on active rips

- **Status:** Accepted
- **Date:** 2026-09-23
- **Type:** Display UI requirement
- **Supersedes:** [2026-09-10 — a kiosk row is one line, and its background is the progress](2026-09-10-a-kiosk-row-is-one-line-and-its-background-is-the-progress.md) (the fixed nine-row arrangement and always-one-line treatment only)
- **Superseded by:** —

## Decision

The 480×320 kiosk overview shows only bays in states where Rip Deck owns the drive:
settling, identifying, queued, ripping, throttled, stalled and finalising. It does
not reserve rows for the rest of the nine-slot rack. The bare number chip preserves
the physical slot identity without preserving empty rows as position markers.

A non-active bay whose job, disc presence, drive presence or last tray command
changes remains visible for 12 seconds. This supplies short feedback for a tray
move, completion, failure or disc removal without making the inactive rack the
persistent display. The first snapshot does not treat pre-existing state as a new
transition. If no active or transient bay exists, the kiosk says `No rips running`.

The visible rows divide the full viewport height. One to three rows use two text
lines and the largest type; four to six use a roomy treatment; seven to nine retain
the compact one-line treatment. The intent wash, solid number chip, rip-name
headline and row-as-progress treatment stand.

## Context

The kiosk always rendered nine rows, including empty, completed and failed bays.
That fixed rack diagram limited every rip name to 20 px type in a 33 px row, even
when only one or two drives were working. The owner uses the slot number to locate
the physical drive and does not need empty rows to preserve that map.

## Why

- Active work is the kiosk's primary information.
- A numbered row keeps its physical location after inactive rows leave.
- Adaptive rows spend the recovered height on the rip name, state, type, ETA and
  percentage.
- Short transition feedback confirms tray and terminal state changes without
  returning to a permanent nine-row rack diagram.
- The compact treatment still handles the real nine-rip maximum.

## Evidence

Owner, 2026-09-23, current T3 Code chat:

> "Rip Deck Kiosk could focus on only the drives that are currently ripping.
> Sure, when opening and closing drives, showing which are empty for a bit is fine,
> but then hide the others and fill the screen with the ones ripping. It will help
> focus on those. Since we have the slot number, I think that will give more screen
> real estate for text and font size."

The 480×320 browser renders cover the adaptive ends exercised by the fixtures:
[four active rips](../previews/2026-09-23-kiosk-active-rips-four.png) and
[one active rip](../previews/2026-09-23-kiosk-active-rips-one.png).

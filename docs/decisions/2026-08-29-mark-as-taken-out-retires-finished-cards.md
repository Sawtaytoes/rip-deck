# Mark as taken out retires finished cards

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Correction
- **Supersedes:** [2026-08-20-mark-as-taken-out-trusts-the-operator-over-the-drive.md](2026-08-20-mark-as-taken-out-trusts-the-operator-over-the-drive.md)
- **Superseded by:** —

## Decision

When the operator presses **Mark as taken out**, Rip Deck removes the matching
finished cards from the dashboard, even if the optical drive still reports
media. The operator is the authority on whether the disc is still in the tray.

The watcher still keeps the terminal bay state. It does not start another rip
for the same reported disc. The dismissal hides the old job and its alert. It
does not alter the rip result or delete any output.

## Context

The prior decision correctly made the loaded-discs reminder disappear, but it
left every present bay latched and visible as a failed card. On this hardware a
removed disc can remain reported as media after tray movement. The dashboard
then showed four failed cards with no way to clear them.

## Why

- The same explicit action must clear both the reminder and the card that
  names the removed disc.
- Keeping the bay latch still prevents an old media report from re-ripping the
  removed disc.
- A warning card about a disc the operator has removed is stale information.

## Evidence

Owner, 2026-08-29:

> "I pushed the button saying I took out the discs from these drives, and it
> didn't do anything."

> "There's no way to remove these errors even if the drives have no discs."

Live `/json` after the press: `loaded_discs.count` was `0`, while slots 1–4
still each reported `state: "failed"`, `has_disc: true`, and the obsolete Retry
in another drive action.

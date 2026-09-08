# Rip cards sort by slot or finishing soonest

- **Status:** Accepted
- **Date:** 2026-09-08
- **Type:** web / card order
- **Supersedes:** —
- **Superseded by:** —

## Decision

The Deck header has an `order` control with two persisted modes:

1. **slot number** is the default. Every card group sorts numbered slots in
   ascending order. An unknown slot follows the numbered slots.
2. **finishing soonest** puts active rips with a positive, finite measured ETA
   first, in ascending ETA order. Equal ETAs use ascending slot number. Active
   rips without a valid ETA and all nonactive cards follow in ascending slot
   order. Equal and unknown fallback slots retain their input order.

The mode only changes the order inside each existing card group. Quarantined
and held cards still come before active rips. Needs-attention and recent cards
keep their existing sections. The recent section still selects the latest four
cards before it sorts those four for display. The selected column count still
applies to every group.

The control uses Charcuterie's `SegmentedControl`. It is one choice from a
small set that stays visible, so it does not add a raw `select`, the deprecated
`Select`, or a new app-specific control shape. The preference uses the
`rip-deck.rip-sort-mode` local-storage key, beside the persisted column choice.

## Context

The compatibility feed sends jobs newest-first. That order changes as jobs
start and finish, and it does not match the physical slot sequence. The owner
wants either a stable physical order or the next expected completion at the
top. The page already has a persisted column control in the same header.

## Why

- Slot order maps each card to the numbered physical rack without depending on
  event arrival order.
- A finish estimate is meaningful only for an active rip. A stale ETA on a
  terminal record must not outrank work that can still finish.
- Invalid, missing, and zero ETAs cannot make a completion prediction. Slot
  order gives those cards a deterministic fallback.
- Existing groups encode work priority. A sort preference must not move a
  completed or held card into the active-rip group.
- A stable final comparison prevents cards with the same or unknown slot from
  swapping because the sorting implementation handles equal values differently.

## Evidence

Owner request in chat `t3code-7308e9f1` on 2026-09-08:

> “I wanna keep drives in-order. I would like a sort mode toggle that shifts between slot number order ascending or "finishing soonest" mode where the soonest one is at the top.”

Fleet survey on 2026-09-08 found that Rip Deck, Docket, Mail Sifter, and
QueuePilot already use Charcuterie's `SegmentedControl` for compact visible mode
choices. Charcuterie documents it as the shared radio-group shape for one choice
from a handful.

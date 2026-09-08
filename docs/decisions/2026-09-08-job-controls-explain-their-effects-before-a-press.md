# Job controls explain their effects before a press

Status: Accepted
Date: 2026-09-08
Type: Web / operator guidance
Supersedes: —
Superseded by: —

## Decision

Rip Deck shows the effect of each available job control beside the controls:

- **Keep trying** disables the automatic stall timeout for that rip.
- **Give up** stops that rip and keeps its partial output.
- **Cancel** stops that rip, keeps its partial output and opens its tray after
  the ripper exits.
- **Try again** reads the disc name again and then starts the rip. If the
  operator provides a name, **Rip as this** starts the rip with that name.

These explanations are visible text. They do not depend on a hover tooltip,
because the operator commonly uses the dashboard on a phone.

## Context

Pull request 34 connected the controls to the daemon and made their effects
safe. It did not explain those effects in the interface. Give up and Cancel
both stopped a rip but differed in partial-output retention and tray movement;
the labels alone did not expose that distinction. Try again appeared on a
different card with no explanation of what was retried.

## Why

An irreversible stop control must state what it preserves and whether it moves
the tray before the operator presses it. A phone has no reliable hover state,
so a tooltip cannot carry required meaning.

## Evidence

Owner, 2026-09-08: *"I also still have no clue what give up, cancel, and try
again do. Do we have unmerged or open branches? These were supposed to be
solved"*

Repository inspection found no open pull request. The old
`fix/cancel-and-bay-actions` branch was merged as pull request 34. Its decision
record specified the action semantics, but the live card only rendered the
short labels.

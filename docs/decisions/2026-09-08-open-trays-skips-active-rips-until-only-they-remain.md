# Open trays skips active rips until only they remain

Status: Accepted
Date: 2026-09-08
Type: ux / behaviour
Supersedes: `2026-07-30-open-trays-escalates-and-close-trays-is-plain.md` (open scope and active-bay reporting clauses only)
Superseded by: —

## Decision

One **Open trays** press opens every present bay that is not `starting` or
`ripping`, including idle, failed and completed bays. It silently skips active
bays while at least one safe tray remains to open. Once every safe tray is
already known open, another press reports the active bays it cannot open.

A targeted open against an active bay still refuses immediately.

⚠️ **The reference to a tower-atomic Close rule is out of date.** That rule was
removed on 2026-09-11
(`2026-09-11-close-trays-closes-the-safe-bays-during-a-rip.md`). Close now
behaves the same way Open does here: it moves the safe set serially and
silently skips the active bays. Nothing in this record's own Open behaviour
changed.

## Context

The prior escalation opened finished bays first and reported active bays as
refusals on the same press. The command therefore complained about bays it was
never expected to touch.

## Why

The bulk command's requested set is the safe bays. A successful first press
needs no report about deliberately excluded active work. A repeated press with
nothing else to do is evidence that the operator is asking about the remaining
bays, so the refusal becomes useful then.

## Evidence

The owner said in the 2026-09-08 session: *"It's supposed to open only idle or
failed trays, not ripping ones."* He also said: *"I only need to be told that if
I keep trying."*

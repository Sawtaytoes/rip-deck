# A kiosk row is tinted by its state and headlines the rip name

- **Status:** Accepted
- **Date:** 2026-09-08
- **Type:** Display UI requirement
- **Supersedes:** —
- **Superseded by:** —

## Decision

Each of the nine tower-kiosk rows takes its state's intent colour as a wash — the
`soft` appearance (intent surface and border) with a `solid` number chip — and the
rip name is the headline of the row. Under the name sits `status · type · ETA` in
the intent's content colour. The progress bar shrinks to a fixed 104px column at the
right, followed by the percentage. An empty bay is neutral, says "Ready for disc",
and shows a dash instead of `0%`. The detail view opens with the same chip and title
as its heading and a soft status badge at the right.

This keeps the [nine-row arrangement](2026-09-08-rip-deck-tower-kiosk-uses-nine-rows.md)
and the [no-title rule](2026-09-08-rip-deck-tower-kiosk-has-no-app-title.md), and
applies the [number-only label rule](2026-09-08-a-bay-is-labelled-by-its-number-alone-never-the-word-slot.md).

## Context

The first kiosk rendered every row in the same outline treatment with a 200px bar,
the word "Slot", a percentage, and only the state and disc type as text. On the
physical WT32-SC01 Plus it read as one blue block; nothing said which rip was
which, and a failed bay looked like a ripping one from across the room. Three
candidates were served at the true 480×320 size: a coloured left rail on dark rows,
whole-row tinting, and a fixed hue per slot number.

## Why

Whole-row tinting gives the most contrast between states and is the one the owner
chose. The state colours are the Charcuterie intent tokens the dashboard already
uses, so a failed bay is the same red in both views. The rip name answers the
question the owner actually walks up to the tower with; the shorter bar is what
paid for it.

## Evidence

> "I don't like the way the UI looks for the rip-deck kiosk. Very monotone. Can we
> get some color in there and some contrast?"

> "I think we can make the UI show a bit more as well like the rip name. We just
> need to shrink the progress bars a bit"

> "B is the way to go! I agree :)"

Owner, 2026-09-08, T3 Code chat on the kiosk colour pass (agentic worktree
`t3code-5bd9f91d`, branch `t3code/5bd9f91d`).
[Candidates](../previews/2026-09-08-rip-deck-kiosk-colour.html),
[render](../previews/2026-09-08-rip-deck-kiosk-colour.png).

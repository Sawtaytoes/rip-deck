# The disc-type mark is right-aligned against the percentage, and the slot pill is capitalised

Status: Accepted
Date: 2026-08-25
Type: UI / layout
Supersedes: —
Superseded by: —

## Decision

Two changes to a bay card's header row.

1. **The disc-type mark moves out of the title and onto the right, immediately
   left of the percentage.** It is no longer a sibling of the disc name.
2. **The percentage reserves a fixed column wide enough for three digits** —
   `100.0%`, not the `19.0%` a card shows for most of its life. `min-w-[5.5ch]`
   with `text-right`, on the same span that already carried `tabular-nums`.

Together those two give the marks a **shared right edge** on every card, and
give every disc name the **same starting x**.

3. **The slot pill reads `Slot 7`, not `slot 7`.** All three cards that draw
   one — `RipCard`, `HeldBayCard`, `QuarantinedBayCard` — say it the same way.
   It already read `Slot 7` in the progress bar's accessible name
   (`format.ripProgressLabel`), so this removes a disagreement as well.

Prose that says "slot" inside a sentence is **not** touched:
`TrayControls`'s refusal list, `LoadedDiscsBanner`'s disc list, and the
daemon's MQTT announcement all keep the lowercase word, because there it is a
word in a sentence rather than a label on a chip.

## Context

The owner sent a screenshot of the `EveryDiscKind` story in the dark scheme —
five cards, one per disc type — and asked for both changes in one message:

> *"I'd like to make these Rip-Deck icons look better as they're not the same
> length. Why not put them on the right side, left of the percentage and leave
> enough room for the percentage to be 100% (3 digits)?"*
>
> *"Also, can we make the `s` capitalized on `slot 3` text? It would make it
> look better."*

## Why

**The four marks are four different widths, and that width was being paid by
the title.** The Ultra HD Blu-ray wordmark is nearly 3:1; the drawn fallback
disc is 1:1. Measured at the story's own type ramp: 69.45px for 4K, 54.52px for
DVD, 49.56px for CD, 45.5px for Blu-ray, 24px for the generic disc. In front of
the name, that is a 45px spread applied to the start of every disc title, so a
stack of nine bay cards had nine different left edges on the one column the eye
actually reads down.

Moving the mark to the right does not make the marks the same width — nothing
can, they are different logos. It moves the **ragged edge to the side nothing
is trying to line up**. The left edge of the mark column varies; the right edge
does not, and neither does the title's start.

**The three-digit reservation is what makes the right edge hold.** Without it,
a rip crossing from `99.9%` to `100.0%` widens the percentage by one digit and
steps the mark sideways — at the last moment of the rip, on the card the
operator is most likely to be watching. Reserving the wider case up front costs
one character of empty space for the whole rip and buys a mark that never
moves.

`min-w-`, not `w-`, and that distinction is load-bearing. `percentText` is not
always a number: `format.ripVisual` also returns `done`, `read errors`,
`in progress`, and a bare failure status. A fixed width would either clip those
or pad the numeric case out to the width of the longest sentence.

## Evidence

Measured in the browser against the `EveryDiscKind` story, dark scheme, by
overwriting the percentage text and reading the mark's bounding box:

| Percentage text | Column width | Mark's right edge |
| --- | --- | --- |
| `9.9%` | 60.5px | 604.5px |
| `19.0%` | 60.5px | 604.5px |
| `100.0%` | 60.5px | 604.5px |
| `done` | 60.5px | 604.5px |
| `read errors` | 81px | 584px |

The first four are the point: three different numeric lengths and a short word
all leave the mark in the identical place. The fifth is the `min-w-` escape
working as intended — a genuinely longer string widens the column rather than
being clipped.

Checked in **both** colour schemes, as `DiscKindLogo`'s own docblock requires,
and at 420px where the card collapses to its Narrow View. Horizontal overflow
is 0px at both widths. 1330 tests, `yarn lint` and `yarn typecheck` all pass.

## What this does NOT change

`DiscKindLogo` keeps `inline-block` and `align-[-0.35em]`. It is still never a
flex **sibling of the title** — that would put the whole disc name into one
unbreakable flex item, and §2 of `RipCard` needs the name to wrap rather than
truncate on a narrow card. The mark being a flex item of the *controls* row is
fine; it has no text beside it to break.

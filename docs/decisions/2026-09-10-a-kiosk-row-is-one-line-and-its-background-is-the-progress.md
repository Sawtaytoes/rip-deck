# A kiosk row is one line, and its background is the progress

- **Status:** Accepted
- **Date:** 2026-09-10
- **Type:** Display UI requirement
- **Supersedes:** [2026-09-08 — a kiosk row is tinted by its state and headlines the rip name](2026-09-08-a-kiosk-row-is-tinted-by-its-state-and-headlines-the-rip-name.md) (the 104 px bar column and the two-line row only; the tint, the solid chip and the rip-name headline stand)
- **Superseded by:** —

## Decision

Each of the nine kiosk rows is one line: the solid number chip (30 px), then the rip
name at 20 px bold with `status · type · ETA` at 14 px after it on the same baseline,
then the percentage at 20 px on the right. There is no bar column. The Charcuterie
`ProgressBar` stays in the row — it is what a screen reader and the tests read — but
it is laid over the whole row as a translucent wash of the row's intent colour behind
the text, so the row *is* the bar. When the line overflows, the meta gives way before
the name. An empty bay still reads "Empty" in the muted colour with a dash for the
percentage.

## Context

The 2026-09-08 row held two lines of text (14 px and 11 px) beside a 104 px bar and an
18 px percentage, in a row 33 px tall. On the physical 480×320 panel, where 1 px is
0.156 mm, the owner could not read the rows from the workbench and barely up close;
he asked for narrower bars so the text could grow. Three candidates were served at
true size on 2026-09-10: R1 (the same shape with a 56 px bar), R2 (one line per row,
meta inline), R3 (the row background is the bar). The owner chose R2's formatting with
R3's fill. Candidates: [comparison](../previews/2026-09-10-rip-deck-kiosk-rows.html),
[R1](../previews/2026-09-10-rip-deck-kiosk-rows-r1.png),
[R2](../previews/2026-09-10-rip-deck-kiosk-rows-r2.png),
[R3](../previews/2026-09-10-rip-deck-kiosk-rows-r3.png); result:
[nine rows](../previews/kiosk-showcase.png).

## Why

- **One line is the only way to 20 px type in a 33 px row.** Nine rows in 320 px leave
  no room for two readable lines.
- **The bar column was a quarter of the row.** Folding the progress into the row's
  own background gives that width back to the name and keeps the fill readable from
  a distance: a row that is 58% washed says 58% before the number does.
- **The shape is still Charcuterie's.** No app-local progress element was drawn; the
  fleet's `ProgressBar` is positioned by the kiosk's CSS, and its role, name and value
  are unchanged. No other owned app has a row-as-bar shape (fleet survey, 2026-09-10),
  so nothing was moved into the library.

## Evidence

- Owner, 2026-09-10: "We might wanna rethink the Rip-Deck view again too. It has the
  same issue. Maybe we make the progress bars not as wide, and then that gives us more
  space for text to be larger." Then: "R2 formatting with R3's full-bar progress
  indicator."
- T3 Code chat `0adde1d5-e233-4c59-bf0f-4fed81fba6d7`.

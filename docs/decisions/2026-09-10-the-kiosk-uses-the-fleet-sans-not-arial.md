# The kiosk uses the fleet sans, not Arial

- **Status:** Accepted
- **Date:** 2026-09-10
- **Type:** Typography
- **Supersedes:** —
- **Superseded by:** —

## Decision

`.rip-kiosk` sets `font-family: var(--font-sans)` (Outfit, from
`@charcuterie/tokens/fonts.css`, which the app already imports). It does not set
Arial.

## Context

The kiosk landed on 2026-09-08 with `font-family: Arial, sans-serif` and no recorded
reason, while the rest of the app renders in the fleet's Outfit. The owner asked on
2026-09-10 whether the screen views used the Charcuterie fonts. The dashboard did;
the kiosk did not.

## Why

- **One typeface across the fleet**, and the face the 2026-09-10 row candidates were
  judged in.
- **The faces are already loaded.** The app imports the fonts stylesheet; opting the
  kiosk out saved nothing.

## Evidence

- Owner, 2026-09-10: "Btw, are we using Charcuterie fonts on these screen views?"
- T3 Code chat `0adde1d5-e233-4c59-bf0f-4fed81fba6d7`.

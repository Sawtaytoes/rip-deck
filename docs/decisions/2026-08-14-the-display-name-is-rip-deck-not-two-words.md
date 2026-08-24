# The display name is "Rip-Deck", not "Rip Deck"

Status: Accepted
Date: 2026-08-14
Type: naming / branding
Supersedes: the "Prose / display / UI = `Rip Deck` (two words, title-cased)" row
of [2026-07-28-rename-to-rip-deck.md](2026-07-28-rename-to-rip-deck.md)
Superseded by: the workspace record
`agentic/docs/decisions/2026-08-23-display-names-are-spaced-words-the-hyphen-belongs-to-the-slug.md`
— the display name is **Rip Deck**, with no hyphen. This file's rule is dead;
its identifier list still stands.

## Decision

Prose, display, UI and the Home Assistant device `name` / `manufacturer` are
**`Rip-Deck`** — the identifier slug, title-cased, hyphen kept. Everything else
in the 2026-07-28 rename stands unchanged: the repo, image, npm scope
(`@rip-deck/*`), env prefix (`RIP_DECK_*`), CLI binary, MQTT topic base
(`rip-deck/tower/…`), discovery nodeId, state path, TrueNAS app and
subdomain are all still lowercase `rip-deck`, and JS/TS identifiers still use
`RipDeck*` because a hyphen is illegal there.

HA entity ids do not move: HA slugifies `Rip-Deck` and `Rip Deck` alike to
`rip_deck`, so `sensor.rip_deck_*` survives the device-name change.

## Context

This is the fleet-wide rule, not a Rip-Deck-only preference — see the
cross-cutting record in the workspace root,
`docs/decisions/2026-08-14-product-display-names-are-hyphenated-title-case.md`,
which does the same for QueuePilot, Mux-Magic, Gallery-Downloader and
Image-Viewer.

## Why

The two-word form was an agent's choice at rename time, never the owner's, and
it made the display name stop looking like the identifier it names.

## Evidence

Owner, 2026-08-14: *"other ones should be Rip-Deck, Mux-Magic,
Gallery-Downloader, Image-Viewer, etc."*, and on the HA strings specifically:
*"I don't think I ever told you to lowercase the name in HA MQTT. That's on
you."*

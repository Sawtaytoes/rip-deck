# The project is renamed `ripdeck` → `rip-deck` ("Rip Deck")

Status: Accepted
Date: 2026-07-28
Type: naming / branding
Supersedes: the former "identifiers stay lowercase single-token `ripdeck`, the
MQTT base is a published contract" rule that lived in `README.md`
Superseded by (prose/display/HA-name row only):
[2026-08-14-the-display-name-is-rip-deck-not-two-words.md](2026-08-14-the-display-name-is-rip-deck-not-two-words.md)

## Decision

The project's name is **`rip-deck`** for every identifier and **"Rip Deck"**
(two words, title-cased) for every bit of prose, display, and UI. This is a
deliberate, coordinated rename from the former single-token `ripdeck` — applied
on **every** axis:

| Axis | Old | New |
| --- | --- | --- |
| Repo / dir / Forgejo | `ripdeck` | `rip-deck` |
| Docker image + registry repo | `example.com/ripdeck` | `ghcr.io/sawtaytoes/rip-deck` |
| npm workspace scope | `@ripdeck/*` | `@rip-deck/*` |
| Env-var prefix | `RIPDECK_*` | `RIP_DECK_*` |
| CLI binary / npm script | `ripdeck rip/watch` | `rip-deck rip/watch` |
| MQTT topic base | `ripdeck/tower/…` | `rip-deck/tower/…` |
| MQTT discovery nodeId | `ripdeck_tower` | `rip-deck_tower` |
| Inner state path | `/var/lib/ripdeck` | `/var/lib/rip-deck` |
| Incomplete-rip temp dir | `.ripdeck-incomplete-*` | `.rip-deck-incomplete-*` |
| TrueNAS app + config dir | `ripdeck` | `rip-deck` |
| Subdomain | `example.com` | `example.com` |
| MQTT broker user | `ripdeck` | `rip-deck` |
| HA device name / manufacturer | `ripdeck` | `Rip Deck` |
| HA entity id slug | `sensor.ripdeck_*` | `sensor.rip_deck_*` |
| Prose / display / UI | `RipDeck` | `Rip Deck` |

Two forms fall out of language rules, not preference:

- **JS/TS identifiers and the internal `/json` wire key** cannot contain a
  hyphen, so they use camel/Pascal case: `RipDeckDataSource`, `RipDeckState`,
  `RipDeckMqtt`, `useRipDeckState`, `RipDeckJsonDocument`, and the document key
  `ripDeck` (was `ripdeck`).
- **Home Assistant entity ids** use the underscore slug HA derives from the
  device display name — HA lowercases "Rip Deck" to `rip_deck`, so the minted
  ids are `sensor.rip_deck_*`, not hyphenated.

## Context

The former `README.md` declared the single-token lowercase `ripdeck` load-bearing
and called the MQTT topic base a "published contract" that must not change. The
owner deliberately reversed that on 2026-07-28, choosing the deepest rename on
every axis — outward-facing infra **and** the MQTT/HA contract **and** the
code-internal identifiers. The target strings `rip-deck` / `Rip Deck` were
unused everywhere, so there were no collisions; the `*.example.com` wildcard DNS
and NPM wildcard TLS cert already cover the new subdomain (no DNS/cert change).

## Why

The lone-word `ripdeck` read like a Docker image name in the dashboard header
and did not match how the rest of the house is addressed. "Rip Deck" as the
human name with a hyphenated `rip-deck` identifier is both more legible and
consistent with the product-name-subdomain convention.

## Evidence

Owner directive, 2026-07-28: rename `ripdeck` → `rip-deck`, display "Rip Deck",
"the deepest rename on every axis: outward-facing infra **and** the MQTT/HA
contract **and** the code-internal identifiers (npm scopes, env-var prefix, CLI
binary)", executed end-to-end with the image bumped to `1.0.0`.

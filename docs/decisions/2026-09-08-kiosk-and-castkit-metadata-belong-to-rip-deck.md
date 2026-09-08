# The kiosk and its CastKit metadata belong to Rip Deck

- **Status:** Accepted
- **Date:** 2026-09-08
- **Type:** Architecture / Display UX
- **Supersedes:** —
- **Superseded by:** —

## Decision

Rip Deck owns the nine-row kiosk, the disc detail view, all slot commands, and the loading skeleton. It serves a CastKit-compatible JSON manifest listing the URLs, viewport, cache triggers, and touch identity contract. CastKit remains a generic remote renderer and touch transport. Main kiosk chrome omits the application title. Disc details include available poster artwork and Open / Close / Disc removed / Back.

## Context

An ESP32 display can receive bitmaps but cannot run the application browser. A cached skeleton provides immediate visual feedback while Chromium renders the destination view. App-specific templates in the renderer would duplicate the UI and its state rules.

## Why

One application owns each view and operation. A versioned manifest makes the renderer contract reviewable without embedding disc knowledge in CastKit. Targeted removal prevents one slot's control from dismissing every disc in the tower.

## Evidence

> “To be clear, this Kiosk view is in Rip-Deck, and CastKit is only receiving a URL and some instructions about how to cache it right?”

> “We should have a CastKit-compatible JSON metadata file for how to cache and handle things and which URLs to load as part of the images.”

Maintainer, 2026-09-08 WT32 kiosk conversation; workspace session `t3code-fdde648d`.

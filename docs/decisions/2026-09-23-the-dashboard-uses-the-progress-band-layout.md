# The dashboard uses the progress band layout

Status: Accepted
Date: 2026-09-23
Type: Web / layout
Supersedes: The provisional A default in [progress-focused rip cards](2026-09-23-rip-cards-emphasize-progress-and-only-show-relevant-controls.md)
Superseded by: —

## Decision

Use B, the progress band layout, as the default for the non-kiosk dashboard. The large percentage sits inside a filled progress band. Speed, remaining duration, and finish time appear below as separately labeled metrics. Retain the other approved cleanup: issue backgrounds, relevant controls only, tooltip help, and slot-triggered drive details.

The mock environment may still switch between A and B for development. The normal dashboard has no comparison control and always uses B.

The shape belongs to Charcuterie's `ProgressCard`, not a Rip Deck implementation. The library owns the band, typography, metrics, and issue surface. Rip Deck supplies formatted rip data, media, and relevant actions. The component must be released before the app consumes it.

## Context

The owner first selected A, then requested both options in the actual application with fake data. After comparison, the owner selected B.

## Why

The filled band and the large percentage communicate progress together while the contrasting metric blocks keep time and speed easy to scan.

## Evidence

Owner, thread `93858a0e-26d6-44f2-9424-9fdd94dbc85e`, 2026-09-23, after receiving both interactive fake-environment links:

> B

The owner then confirmed the existing library-first requirement:

> Add to Charcuterie first right?

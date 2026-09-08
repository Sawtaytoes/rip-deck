# Mobile rip cards always show live speed

Status: Accepted
Date: 2026-09-08
Type: Web / responsive layout
Supersedes: The narrow live-metrics clause of `2026-08-09-light-mode-chrome-and-narrow-poster.md`
Superseded by: —

## Decision

The measured live-metrics row stays visible at every bay-card width. A narrow
card shows elapsed time, estimated time remaining and current throughput in
MB/s. The stage, destination, state and drive details can remain in the wide
detail region.

## Context

The narrow layout hid the whole live-metrics row with the lower-density card
details. The always-visible completion clock showed when a rip might finish,
but the phone view had no current speed at all.

## Why

Current speed tells the operator whether a disc is reading normally or has
slowed to a near-stall. It is live operating state, not optional drive detail.
The single compact row adds this information without restoring the full wide
card on a phone.

## Evidence

Owner, 2026-09-08, with a phone screenshot of three active cards: *"On my
phone, I have no way of seeing the rip speed"*

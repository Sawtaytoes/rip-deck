# Bulk Open trays moves from the bottom slot up

Status: Accepted
Date: 2026-09-08
Type: ux / hardware interaction
Supersedes: —
Superseded by: —

## Decision

The bulk `open_trays` command actuates numbered slots in descending order, from
slot 9 at the bottom of the tower toward slot 1 at the top. Drives without a
known slot follow all numbered drives in deterministic USB port path order.

This order applies only to the bulk Open command. Targeted tray commands keep
their existing one-drive behaviour. Bulk Close keeps its existing order. Every
bulk motor action remains serial, and the command keeps the existing eligible
bay selection, silent skips and safety refusals.

## Context

The tower slots run from 1 at the top to 9 at the bottom. Opening from the top
down leaves an extended tray above the next drive that the operator needs to
load. The lower tray can then collide with the tray above it or force the
operator to wait for the full command before loading discs.

## Why

Opening from the bottom up leaves clear space above each newly opened tray. The
operator can load each disc as soon as its tray opens without reaching under an
already open tray. Serial execution still limits the shared USB tree to one
tray motor at a time.

A drive with no configured slot has no physical position that Rip Deck can use
for this order. Putting it after the numbered tower and sorting it by stable
drive identity makes the fallback repeatable without guessing its position.

## Evidence

- Owner, chat `t3code-7308e9f1`, 2026-09-08: *“And when it opens all drives for you to put discs in, it does it starting at the top, not the bottom, so if I wanna quickly pop in a disc, I now have an open drive right above me. I'd like it to open them in reverse order. It will help load them up quickly without bumping trays above that one.”*
- Regression tests assert the exact slot order, the unknown-slot fallback and a
  maximum of one tray command in flight.

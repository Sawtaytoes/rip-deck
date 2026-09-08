# A stale bay can be reset without restarting Rip Deck

Status: Accepted
Date: 2026-09-08
Type: recovery / safety
Supersedes: —
Superseded by: —

## Decision

A terminal bay offers **Reset bay**. The action validates that the current
kernel device belongs to the bay's stable USB port id, unbinds and rebinds that
exact USB child, clears the stale bay record, and lets the normal poll inspect
it again. It never resets a parent hub. It refuses a `starting` or `ripping` bay.

The operation retains partial output. It does not restart Rip Deck and does not
stop or reconnect sibling jobs.

## Context

A failed drive kept reporting the prior disc after the tray was empty. Logical
state clearing alone was unsafe because the next poll could see the same stale
kernel media and start another job for it. An exact USB-child rebind cleared the
live condition while eight sibling rips continued.

## Why

The recovery needs to repair both Rip Deck's memory and the drive's kernel
state. The stable USB port id supplies a narrow hardware target that survives
`/dev/srN` renumbering.

## Evidence

The owner said in the 2026-09-08 session: *"I would like some way for me to
fix/clear that disc myself. It keeps trying to scan that STAR_TREK_TMP_... disc,
but there's nothing there."*

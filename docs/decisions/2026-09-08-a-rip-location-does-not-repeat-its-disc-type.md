# A rip location does not repeat its disc type

- **Status:** Accepted
- **Date:** 2026-09-08
- **Type:** UI / rip-card formatting
- **Supersedes:** —
- **Superseded by:** —

## Decision

The rip-card metadata row renders a disc type beside the destination only when the destination leaf does not already contain the canonical ` - {type}` suffix. A path ending ` - 4K` therefore appears once, not as `… - 4K 4K`. The same rule covers Blu-ray and DVD, including `.iso` files and rip-deck collision markers.

The daemon's stored destination path is authoritative and remains unchanged. This is a presentation-only de-duplication. The disc-type logo remains in the card header, and the visible type text remains when no destination exists or when a noncanonical destination does not name the type.

## Context

`buildFolderName` deliberately puts the disc type in every canonical video-backup destination. `RipCard` then rendered `rip.path` and `discTypeText(rip)` as adjacent metadata fields, which repeated `4K` in the location shown on a completed UHD card.

The existing iconography decision accepts an accessible duplicate between the logo title and visible type text because an adopted card can otherwise lose its only type label. That accessibility trade does not require a second visible type immediately after a path that already contains the same text.

## Why

The destination is the useful fact because it tells the operator where the backup landed. Removing or trimming its suffix would corrupt the displayed path and make it disagree with the filesystem. Suppressing only the redundant sibling label keeps the path exact and retains type information for paths that do not carry the naming suffix.

## Evidence

- Owner, 2026-09-08, chat `t3code-7308e9f1`: “We should fix the warnings about errors that aren't errors and remove the extra "4K" on the rip location”.
- Formatting tests cover the exact `…/[BACKUP] … - 4K` shape, a DVD `.iso`, a collision marker, and a destination without the suffix. The tests also assert that the stored path is unchanged.

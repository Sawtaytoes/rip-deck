# Drive identity uses firmware serial and repairs runtime hints

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** Architecture / hardware identity
- **Supersedes:** `/dev/srN`-derived identity
- **Superseded by:** None

## Decision

Rip Deck resolves a physical optical drive through three tiers:

1. `firmwareSerial` is canonical identity. It comes from MakeMKV's `DRV:` data.
2. `usbPortPath` is the fast runtime key. It is read from sysfs without device access.
3. `bridgeSerial` is a tiebreaker only.

`/dev/srN` is never identity. A firmware-serial match that disagrees with the cached USB path repairs the cached path instead of trusting it.

The daemon reads firmware serials during discovery and repair, not on the frequent health-sampling path.

## Context

The USB tower can power-cycle independently of the host. A complete bus re-enumeration can assign different `/dev/srN` names to every drive.

Several USB-to-SATA bridges can report similar stock serials. Third-party optical-drive firmware can also change the reported model string while retaining the physical drive serial.

The USB port path is stable during ordinary operation and follows the tower wiring, but a re-cable can change it.

## Why

The firmware serial follows the physical drive across device-number changes, re-cables, and firmware model changes. The USB path avoids an expensive MakeMKV scan during frequent sampling. Repairing cached paths from canonical identity lets the registry recover after a re-cable without operator edits.

The bridge serial can help resolve ambiguity, but it is not reliable enough to identify a drive alone.

## Evidence

The owner said: “the USB adapters are probably the same. Even with the new firmware, the old serial numbers should've been retained.” Chat dated 2026-07-24, recorded in [Build Rip Deck rather than adopt](2026-07-24-build-rip-deck-rather-than-adopt.md).

The initial Rip Deck repository documentation and `config/drives.json` then implemented the three-tier resolution and documented the `/dev/srN` re-enumeration failure. This record extracts that durable choice from the top-level README under the fleet README-boundary decision.

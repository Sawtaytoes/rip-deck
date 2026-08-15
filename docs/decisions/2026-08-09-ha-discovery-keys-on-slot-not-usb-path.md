# HA bay discovery keys on slot, not USB path

Status: Accepted  
Date: 2026-08-09  
Type: bugfix / mqtt / home-assistant  
Supersedes:  
Superseded by:  
Refines: [2026-07-30-tower-usb3-port-survived-the-cable-was-the-fault.md](2026-07-30-tower-usb3-port-survived-the-cable-was-the-fault.md)

## Decision

Home Assistant MQTT discovery for per-bay sensors keys on **slot**
(`slot_05_status` / unique_id `rip-deck_tower_slot_05_status`), not on the
USB port-path slug.

- **State topics** still use the runtime path slug
  (`rip-deck/tower/drive/2_1_3_4_2`) - that is where the retained bay
  payload is published.
- **Discovery object id / unique_id** use `slot_NN` when the bay has a slot,
  so a re-cable only rewrites `state_topic` on the existing HA entity.
- Unregistered bays (slot null) still fall back to the path slug.
- When the published bay set changes, discovery for removed object ids is
  **cleared** with empty retained configs so HA drops orphans instead of
  keeping path-keyed ghosts.

## Context

On 2026-07-30 the tower's USB root path moved `2-1.1.2` → `2-1.3` (cable
replacement, same mobo port). Discovery had been using the path slug as
`unique_id`, so HA:

1. Kept the original pretty entities
   (`sensor.rip_deck_05_pioneer_bdr_212u_status`) subscribed to the
   **dead** `2_1_1_2_*` topics.
2. Minted a second set on the live `2_1_3_*` path with raw path entity ids.

The tablet-dash **Rip Deck** view and the tray-button automation read the
pretty names. Live check 2026-08-09 with *The People vs. Larry Flynt* ripping
on slot 5: rip-deck `/json` and the live MQTT topic showed `ripping` /
`has_disc: true`, while the pretty HA sensor stayed on the old topic and
read empty / unknown.

## Why

Identity for the human-facing bay is already the **slot** (number on the rack,
`config/drives.json`). The USB path is a runtime key that **will** move again
on re-cable - AGENTS.md already says `/dev/srN` is never identity and the
port path is a cached hint. Discovery `unique_id` is how HA keys an entity
for life; putting a movable path there guarantees a second entity set every
time the hub re-enumerates under a new root.

## Evidence

- Live 2026-08-09: discovery for
  `homeassistant/sensor/rip-deck_tower/2_1_1_2_4_2_status` still pointed
  `state_topic` at the dead path while
  `rip-deck/tower/drive/2_1_3_4_2` carried
  `state: ripping`, `title: THE PEOPLE VS LARRY FLYNT`, `has_disc: true`.
- HA entity registry: pretty names bound to
  `rip-deck_tower_2_1_1_2_*` unique_ids; live path had a parallel
  `2_1_3_*` set (and a third stale `2_2_*` topology).
- After re-point / slot migration:  
  `sensor.rip_deck_05_pioneer_bdr_212u_status` → `ripping`,
  title `THE PEOPLE VS LARRY FLYNT`, `has_disc: true`.

## Migration (one-time, done 2026-08-09)

1. Publish slot-keyed discovery for slots 01-09 with current path state topics.
2. Clear retained path-keyed bay discovery (`2_1_1_*`, `2_1_3_*`, `2_2_*`).
3. Rename HA entity_ids off the `_2` suffix HA assigned during the dual-publish
   window so tablet-dash keeps
   `sensor.rip_deck_NN_<model>_status`.

Redeploying this code after the migration only re-publishes the same
slot-keyed configs; it does not reintroduce path-keyed unique_ids.

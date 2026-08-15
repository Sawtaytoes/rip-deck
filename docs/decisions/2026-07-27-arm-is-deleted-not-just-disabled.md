# ARM is deleted, not just disabled

Status: Accepted
Date: 2026-07-27
Type: operations / project scope
Supersedes: [ARM stays disabled — `rip-deck` is the ripper
now](2026-07-26-arm-stays-disabled.md) — **only** its "the ARM *viewer* keeps
running" clause. Everything else there still stands, and this is its
continuation rather than a reversal.

## Decision

**Automatic Ripping Machine is gone from the house, not merely switched off.**
The owner approved deleting it outright. Removed 2026-07-27:

| What | Identity confirmed before deletion |
| --- | --- |
| TrueNAS app `automatic-ripping-machine` | custom-compose app, `STOPPED`, service `arm`, image `automaticrippingmachine/automatic-ripping-machine:latest`, port `30080:8080` |
| TrueNAS app `automatic-ripping-machine-viewer` | `STOPPED`, held all nine `/dev/sr0`–`/dev/sr8` passthroughs, ran the `arm_mqtt.py` bridge with `MQTT_USER=arm-viewer` |
| NPM proxy host **65** | `example.com` → `10.0.0.10:30080` |
| NPM proxy host **64** | `example.com` → `10.0.0.10:3006` |

Both NPM hosts were **disabled first**, verified to stop resolving, and re-read
by domain name immediately before the `DELETE`; proxy-host ids shift, so the id
was never trusted on its own. Both apps were deleted with a dry run first.

**Kept, deliberately:**

- **`/srv/config/automatic-ripping-machine{,-viewer}/`** —
  TrueNAS does not delete host-path datasets with an app, and these should not be
  deleted by hand either. `db/arm.db` is the historical record of every rip ARM
  ever made, and `config/arm.yaml` plus the seven `patches/*.sh` are the evidence
  behind several decisions in this directory.
- **The `automatic-ripping-machine-viewer` git repo** on Forgejo, which is where
  `arm_mqtt.py` actually lives (`/srv/Repos/automatic-ripping-machine-viewer/`).
  The *running* bridge died with the app it ran inside. Deleting a git repo is a
  different and larger act than deleting a deployment, and `packages/web` was
  harvested from that repo — its history is the provenance.

## Context

ARM was disabled 2026-07-25 at the owner's instruction and confirmed to stay
disabled on 2026-07-26 ([decision](2026-07-26-arm-stays-disabled.md)). By
2026-07-27 both its web hosts had been returning **502** for a day, the Homepage
tiles had already been replaced by one **Rip Deck** tile, and Rip Deck was the
tower's only ripper with a working dashboard, MQTT publishing and a bay ledger.

## Why

- **A 502 is worse than an absence.** Two dead hosts on the reverse proxy and two
  stopped apps in the TrueNAS list read as "broken", not "retired", to whoever
  looks next — including a future agent, which is the reader this repo is written
  for.
- **The viewer was holding all nine optical devices.** Nothing was using them,
  but a stopped app that claims `/dev/sr0`–`/dev/sr8` is a trap waiting for the
  next person who restarts it to see what it does.
- **Nothing referenced it.** Checked before deleting: no Home Assistant entity,
  automation, script or scene mentions ARM; the Homepage config has no remaining
  ARM tile or widget; no other NPM host forwards to `:30080` or `:3006`.

## Evidence

Owner's approval is recorded in
`HANDOFF-stage7-ui-and-naming.md` §9.2:
*"Retire ARM. The app, its `arm_mqtt.py` bridge, and NPM proxy hosts 64 and 65
… Both already return **502**; the Homepage tiles are already replaced by one
**Rip Deck** tile. … Disable before deleting."*

Verified live 2026-07-27, before deletion: both hosts `HTTP 502`; both apps
`STOPPED`; after disabling, both hosts stopped resolving while
`example.com` and `example.com` stayed `200`. After deletion,
`app.query` returns nothing for either name, no `arm*` container remains on
Tower, and Rip Deck still answers `200`.

## Consequences to watch

- **The `arm-viewer` Mosquitto login is now unused.** It lives in the Home
  Assistant Mosquitto add-on's `logins` and nothing publishes with it any more.
  Removing it is the owner's call; it is not dangerous to leave.
- **ARM's MakeMKV key directory is no longer the one in use.** Rip Deck has had
  its own copy since [2026-07-25](2026-07-25-rip-deck-ships-its-own-makemkv.md);
  the ARM copy stays on disk as a fallback.
- **`docs/HANDOFF.md` and this repo's earlier docs still describe running beside
  ARM.** That is history and reads correctly as history; do not reason from it as
  a live constraint.

# Rip Deck is a TrueNAS custom (docker-compose) app, not a hand-run container

Status: Accepted
Date: 2026-07-28
Type: deployment
Supersedes:
Superseded by:

## Decision

Rip Deck runs as a **TrueNAS custom app** (`custom_app: true`), defined by
[`../../deploy/docker-compose.yaml`](../../deploy/docker-compose.yaml) and created
with `midclt call app.create`. The image lives on
`ghcr.io/sawtaytoes/rip-deck:<tag>`. It is **not** the TrueNAS `custom-app`
chart and **not** a hand-run `docker run`.

## Context

It had been started by a bare `docker run` on Tower — no compose file, no repo
record. The full spec (`device_cgroup_rules`, `/dev`, the docker socket, three
dataset mounts, the MQTT/OMDB env, port 3007) lived only in `docker inspect`, so
a redeploy meant reverse-engineering it from a running container.

The TrueNAS `custom-app` chart — how every other self-hosted app here is deployed
(plex-channels, castkit…) and where their icons live — was **not** an option:
its structured form has no field for `device_cgroup_rules`, and Rip Deck needs
them because the optical drives appear and disappear as the tower is powered
independently of the service. A raw docker-compose custom app is the only path
that carries cgroup rules.

## Why

- **The compose is the source of truth**, in the repo, secrets referenced not
  committed (`RIP_DECK_MQTT_PASSWORD`, `RIP_DECK_OMDB_API_KEY` are `__FROM_ROOT_ENV__`
  placeholders, substituted at deploy from the workspace root `.env`).
- **TrueNAS-managed** means the app appears in the Apps UI, restarts with the
  system, and is visible where the owner actually looks — not an invisible
  hand-run container a future agent has to rediscover.
- **`device_cgroup_rules: ["b 11:* rmw", "c 21:* rmw"]`** — block(11) = sr
  optical, char(21) = SCSI generic — on a wildcard minor because `/dev/srN`
  reshuffles on every USB re-enumeration. Verified applied on the running
  container.

## The icon

TrueNAS shows an app icon from `metadata.icon` (a data-URI SVG). `app.create`
for a custom app has **no icon field**, so the icon
([`../../deploy/icon.svg`](../../deploy/icon.svg) — a purple disc + eject mark) is
written into `/mnt/.ix-apps/app_configs/rip-deck/metadata.yaml` after create, the
same place plex-channels' hand-authored icon lives. The middleware serves
metadata from an in-memory cache and only reloads it from disk on a
**`middlewared` restart**, so a staged icon appears on the next restart/reboot
rather than immediately.

## Evidence

- App created via `app.create` (job 4034 SUCCESS); `app.query` → `state: RUNNING`,
  `custom_app: true`; container `ix-rip-deck-rip-deck-1` on the registry image.
- Health after cutover: `[mqtt] connected`, `GET /` → 200, `/json` served,
  cgroup rules present on the container.
- Image pushed: `example.com/v2/rip-deck/tags/list` → `["0.7.3"]`.
- Owner directive + chat: 2026-07-28 — *"it should be a TrueNAS docker-compose
  app and have an app icon"* / *"docker-compose … necessary here because we need
  cgroups"*.

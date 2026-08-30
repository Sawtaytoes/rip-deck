# Setup and configuration

Rip Deck needs direct access to Linux optical-drive device nodes and the real `/sys/block` tree. Run it on the host that owns the drives.

## Requirements

- A Linux Docker host.
- One or more optical drives visible as `/dev/sr*` and `/dev/sg*`.
- A writable destination for disc images and audio files.
- Persistent directories for MakeMKV configuration and Rip Deck state.
- The Docker socket when per-rip container isolation is enabled.

## Prepare the deployment

Copy [`deploy/docker-compose.yaml`](../deploy/docker-compose.yaml) and edit the host paths for your system.

The example expects these persistent locations:

| Container path | Purpose |
| --- | --- |
| `/media/Disc-Rips` | Completed and incomplete rip output. |
| `/config` | MakeMKV settings, keys, and data. |
| `/var/lib/rip-deck` | Bay memory, history, job logs, verdicts, and poster cache. |
| `/app/config/drives.json` | Operator-maintained slot and drive identity map. |

Create the host directories and copy [`config/drives.json`](../config/drives.json) to a persistent host path. The checked-in file contains examples only.

## Build or pull the image

The deployment example uses `ghcr.io/sawtaytoes/rip-deck:latest`. The package can be private because the image contains proprietary MakeMKV binaries. Authenticate to GHCR before pulling it.

To build locally instead:

```sh
docker build -t rip-deck:latest .
```

Change both the service image and `RIP_DECK_RIP_ISOLATION_IMAGE` in the Compose file to `rip-deck:latest` when you use a local build.

## Device access

Use wildcard device cgroup rules and bind `/dev` into the container:

```yaml
device_cgroup_rules:
  - "b 11:* rmw"
  - "c 21:* rmw"
volumes:
  - /dev:/dev
```

Do not use a fixed `devices:` list. `/dev/srN` values can change after USB re-enumeration, and Docker refuses to start when a listed device is absent.

Bind `/run/udev` read-only so the daemon can receive disc metadata. Bind `/var/run/docker.sock` when the daemon launches one device-scoped container per rip.

## Map drives to slots

Start with the tower connected and run the read-only probe:

```sh
docker compose -f deploy/docker-compose.yaml run --rm rip-deck rip-deck probe
```

Use the reported firmware serial for each physical drive. Update your persistent `drives.json` with the slot, display name, firmware serial, and known drive properties. Do not use `/dev/srN` as identity and do not hand-edit cached USB paths to force a mapping.

The daemon reads `config/drives.json` by default. Set `RIP_DECK_DRIVES_CONFIG` only when you mount the file elsewhere.

See [Drive and tower hardware](hardware.md) and the [drive identity decision](decisions/2026-08-30-drive-identity-uses-firmware-serial-and-repairs-runtime-hints.md).

## Configure storage and isolation

| Variable | Container default | Purpose |
| --- | --- | --- |
| `RIP_DECK_DEST` | `/media/Disc-Rips` | Destination visible to the daemon. |
| `RIP_DECK_STATE_DIR` | `/var/lib/rip-deck` | Persistent state and job evidence. |
| `RIP_DECK_DRIVES_CONFIG` | `config/drives.json` | Drive registry path. |
| `RIP_DECK_RIP_ISOLATION_IMAGE` | unset | Image used for a device-scoped rip container. |
| `RIP_DECK_RIP_ISOLATION_ARGS` | unset | Volume arguments passed to each rip container. |
| `RIP_DECK_MAX_CONCURRENT_RIPS` | configured default | Optional concurrency limit. The normal watcher supports all configured drives. |
| `RIP_DECK_API_PORT` | `3007` | Dashboard and API port. |

The isolation image must see the same destination and MakeMKV configuration paths as the daemon.

## Configure MQTT and posters

MQTT is optional. When enabled, set:

- `RIP_DECK_MQTT_URL`
- `RIP_DECK_MQTT_USERNAME`
- `RIP_DECK_MQTT_PASSWORD`
- optional CA, discovery-prefix, base-topic, and node-ID settings

Keep credentials outside git. An unset MQTT URL is a supported configuration.

Set `RIP_DECK_OMDB_API_KEY` to enable poster lookup. An unset key disables posters without disabling ripping. Poster responses persist in the state directory.

## UHD keys

A new UHD disc can fail until MakeMKV's hashed-key bundle includes it. If an external `keydb.cfg` already contains the disc key, place it at `/config/data/keydb.cfg`. Rip Deck does not distribute that third-party file.

## Start and verify

```sh
docker compose -f deploy/docker-compose.yaml up -d
docker compose -f deploy/docker-compose.yaml exec rip-deck rip-deck probe
curl -fsS http://localhost:3007/json
```

Verify that every physical drive resolves to the intended slot. Insert one test disc and confirm that the dashboard shows the correct bay before you allow a full automatic rip.

## Updates

> **Warning:** Stopping, restarting, or redeploying the daemon cancels every active rip. Each rip has its own container, but the daemon owns and terminates that child process.

Check `/json` with a parser that fails when the request fails and when any bay is starting or ripping. Do not use `grep -c`, because it prints zero both for an empty match and for several failed pipeline cases.

See [A redeploy cancels every running rip](decisions/2026-08-27-a-redeploy-cancels-every-running-rip.md) for the required fail-closed check and recovery behavior.

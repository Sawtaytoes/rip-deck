# Rip Deck

Rip Deck is a concurrent optical-disc ripper for a multi-drive USB Blu-ray, DVD, and CD tower. One daemon watches every bay, starts a rip for each inserted disc, evaluates disc health, and serves a live dashboard.

**[Set up Rip Deck with Docker →](docs/setup.md)**

## What it provides

- Concurrent automatic ripping across all configured drives.
- Stable drive identity across USB re-enumeration.
- A dashboard for bay state, progress, warnings, history, and operator controls.
- Separate `pass`, `warning`, and `fail` outcomes.
- Health signals from kernel counters and measured throughput.
- Optional MQTT discovery, commands, and announcements.
- Blu-ray and DVD backups through MakeMKV, plus CD ripping through cyanrip.

## Quick start

Copy and adapt [`deploy/docker-compose.yaml`](deploy/docker-compose.yaml). Configure persistent paths, mount your own drive map, and supply secrets before you start it.

```sh
docker compose -f deploy/docker-compose.yaml up -d
docker compose -f deploy/docker-compose.yaml exec rip-deck rip-deck probe
```

Open `http://localhost:3007`. The [setup guide](docs/setup.md) explains device access, drive discovery, storage, and verification.

## Documentation

- [Setup and configuration](docs/setup.md)
- [Operator guide](docs/operator-guide.md)
- [Rip history](docs/history.md)
- [Architecture](docs/architecture.md)
- [Drive and tower hardware](docs/hardware.md)
- [Local development](docs/development.md)
- [Architecture decisions](docs/decisions/README.md)

## Repository layout

| Package | Purpose |
| --- | --- |
| `packages/contracts` | Shared drive, rip, health, and API types. |
| `packages/daemon` | Drive discovery, ripping, health analysis, MQTT, and HTTP. |
| `packages/web` | React dashboard served by the daemon. |

## License

[MIT](LICENSE). The image also contains MakeMKV under [GuinpinSoft's terms](https://www.makemkv.com/); the MIT license applies only to this repository's source.

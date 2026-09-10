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

## A documentation-only change skips CI

CI turns its own gates off when a change touches only `.md` files (or `LICENSE`).
Nothing in the suite reads markdown, so running it proved nothing and only delayed
the merge. A documentation-only merge also skips the image build, because the
rebuilt image would be byte-identical.

Two rules follow, and both matter if you edit `.github/workflows/ci.yml`:

1. **Never convert this to `paths-ignore:` on the trigger.** The `check` job is a
   required status check. A job that `if:` skips still reports that context, and
   GitHub counts a `skipped` conclusion as success. A workflow that never starts
   reports nothing at all, so the required check stays pending and the pull request
   waits forever on a status that will never arrive.
2. **`.mdx` is not documentation**, and neither is `.changeset/*.md`. The detector
   matches `.md$` for that reason. Do not loosen it to `.md*`.

## Kiosk mode

The [tower kiosk](docs/kiosk.md) exposes a dedicated 480×320 view at `/kiosk`.
CastKit loads the app-owned manifest at `/kiosk/castkit.json` and sends the rendered
page to a remote browser display.

For photographs and demonstrations, `/kiosk?fake=showcase` shows a read-only nine-bay
fixture. It includes one empty bay, active rips, a stalled rip, successful rips, a
successful rip with warnings, and a failed rip. UHD, Blu-ray, DVD, and CD media all
appear in the same view. Every fixture response identifies itself as fake, and the
kiosk disables all controls.

![Rip Deck kiosk showcase with nine mixed-state bays](docs/previews/kiosk-showcase.png)

Point a CastKit remote-display worker at `/kiosk/castkit-showcase.json` to put this
fixture on its physical display. Restore `/kiosk/castkit.json` and restart the worker
when the demonstration is complete.

# Architecture

Rip Deck separates the long-running watcher, per-rip execution, shared contracts, and browser dashboard.

## Components

| Component | Responsibility |
| --- | --- |
| `packages/contracts` | Shared drive, rip, health, MQTT, and API types. |
| `packages/daemon` | Drive discovery, watcher state, rip processes, health analysis, MQTT, and HTTP. |
| `packages/web` | React dashboard served on the daemon origin. |
| `config/drives.json` | Operator-maintained physical slot map. The repository copy contains examples. |

## Watcher and rip processes

The daemon polls drive facts, maintains bay memory, and starts work for new discs. Each active rip runs in a device-scoped container so it receives only the required optical device.

The daemon still owns each child process. Its shutdown path cancels active rips. Container isolation limits device access; it does not make a rip survive a daemon restart.

`rip-deck rip --slot N` addresses one slot by design. The watcher can run several of those jobs concurrently, up to the configured limit.

## Drive identity

Linux device names such as `/dev/sr3` are temporary locations. The registry keys a physical drive on its firmware serial, uses the USB port path as its fast runtime key, and treats the bridge serial only as a tiebreaker.

See [Drive identity uses firmware serial and repairs runtime hints](decisions/2026-08-30-drive-identity-uses-firmware-serial-and-repairs-runtime-hints.md).

## Health engine

The health engine does not depend on MakeMKV's exit code. It samples kernel and sysfs evidence such as `ioerr_cnt`, block statistics, kernel messages, and throughput against the drive baseline.

This boundary allows Rip Deck to report mid-rip stalls and to keep the same health analysis for different rip tools. The rip result and health verdict remain separate evidence until the outcome summary combines them.

## Output shapes

MakeMKV produces a directory for Blu-ray and UHD backup. It produces one decrypted ISO file for DVD backup. CD work uses cyanrip.

Rip Deck writes into an incomplete destination and finalizes the name only after verification. Duplicate destinations receive a marker instead of overwriting an existing copy.

## Persistent state

The state directory contains:

- `bays.json` for the current per-bay memory.
- `history.jsonl` for append-only terminal history.
- `<uuid>.robot.log` for MakeMKV robot output.
- `<uuid>.features.json` and `<uuid>.verdict.json` for health evidence.
- `posters.json` for cached OMDb responses.

The poster store returns synchronously from memory. An optional asynchronous lookup fills memory and writes the versioned disk cache through an atomic rename. An unset OMDb key selects a null store and does not affect ripping.

## HTTP and MQTT

The daemon serves the dashboard and JSON API on one origin. The web application uses React Router for dashboard and history paths.

MQTT is optional. When configured, the daemon publishes Home Assistant discovery and state, consumes operator commands, and sends announcements. The MQTT base is a public integration contract and defaults under `rip-deck/<host>/…`.

The [decision index](decisions/README.md) records the detailed state, safety, and outcome rules.

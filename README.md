# Rip Deck

A concurrent optical-disc ripper for a multi-drive USB Blu-ray/DVD/CD tower.
One long-running daemon watches every bay, rips each inserted disc — up to all
of them at once — and serves a live dashboard on the same origin as its JSON
feed. It ships its own `makemkvcon` and `cyanrip`, identifies drives by a stable
key that survives USB re-enumeration, and computes a per-rip health verdict from
kernel counters rather than from the ripper's own exit code.

Built to replace [Automatic Ripping Machine](https://github.com/automatic-ripping-machine/automatic-ripping-machine)
on a nine-drive tower. The decision records under [`docs/decisions/`](docs/decisions/)
are the design history — why each non-obvious choice was made, in ADR form.

> **Naming.** The product is **Rip Deck**; every identifier is the hyphenated
> lowercase `rip-deck` — the binary (`rip-deck watch`), the image, the npm
> scope (`@rip-deck/daemon`), and the MQTT topic base (`rip-deck/<host>/…`).
> The MQTT base is a published contract.

## Why it exists

ARM works, but several of its worst behaviours are architectural and
long-standing:

- it reports **success on rips that had read errors**, silently
  ([#1298](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/1298)).
  Rip Deck badges that rip a **warning** and names the count and the offsets —
  a backup that verified is a backup, and hiding the bad sectors is the bug
  ([decision](docs/decisions/2026-08-27-a-read-error-on-a-verified-backup-is-a-warning-not-a-failure.md))
- **abort doesn't cancel** ([#1014](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/1014))
- **DB-locked with multiple drives** ([#500](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/500) — filed by another 9-drive user)
- **no MQTT** ([#1613](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/1613))

Every off-the-shelf alternative was audited against a written requirements
catalogue before any code was written. The evidence table is in
[`docs/decisions/2026-07-24-build-rip-deck-rather-than-adopt.md`](docs/decisions/2026-07-24-build-rip-deck-rather-than-adopt.md).

## A finished rip has three outcomes, not two

`pass`, `warning`, `fail`. The middle one exists because a real rip needed it:
a CSS-protected DVD that reached `Backup done`, left a mountable 8 GB ISO, and
hit one bad sector on the way. `fail` would say there is no backup, which is
false; `pass` would say nothing is wrong, which is also false. A warning names
the count and the offsets, and it says plainly that MakeMKV's robot output
does **not** report whether it recovered from the error — because it does not,
and implying otherwise would be worse than saying nothing.

## The health engine is separable from the ripper

Its inputs come from the kernel, not from MakeMKV:
`/sys/block/srN/device/ioerr_cnt`, `/sys/block/srN/stat`, `/dev/kmsg`, and
throughput against a per-drive baseline. So the health verdict is
ripper-agnostic by construction — it keeps working unchanged regardless of what
performs the rip, and it can report *mid-rip* trouble ("bay 7 is stalling")
instead of only a verdict computed after the rip has already failed.

## Layout

| Package | Role |
| --- | --- |
| `packages/contracts` | Shared types: MakeMKV events, drive identity, verdicts, jobs. The daemon and the UI both compile against these. |
| `packages/daemon` | Node side: sysfs sampling, robot-mode parser, drive registry, health engine, MQTT bridge, HTTP API. |
| `packages/web` | React dashboard (ported from [`automatic-ripping-machine-viewer`](https://github.com/Sawtaytoes/automatic-ripping-machine)). Served by the daemon on the same origin as the `/json` it reads. |
| `config/drives.json` | Slot map, keyed on drive firmware serial. `config/drives.json` here ships **example** drives — replace with your own. |

## Commands

`probe` and `parse` are **read-only**. `rip` writes.

```sh
yarn rip-deck probe                # drive identity table (slot / port path / serial)
yarn rip-deck probe --no-makemkv   # sysfs only; no device access at all
yarn rip-deck parse < capture.log  # replay robot-mode output through the parser

yarn rip-deck rip --slot 9 --dry-run   # everything except the spawn
yarn rip-deck rip --slot 9             # rip the disc in slot 9

yarn test        # vitest
yarn typecheck
yarn lint
```

> **`yarn test` needs a Playwright browser, and an agent container's is the wrong one.**
> `packages/web` runs vitest in browser mode through `@vitest/browser-playwright`. An agent
> container ships browsers for its **own** globally-installed Playwright at a root-owned
> `/opt/pw-browsers` and points `PLAYWRIGHT_BROWSERS_PATH` there; this repo pins its own,
> which wants a different chromium revision, and that directory is not writable. The run
> dies before the first test, naming a build number that is not there.
>
> Install this repo's build somewhere writable and point the run at it — do not change the
> repo to match the container, and do not conclude the UI cannot be tested:
>
> ```sh
> PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers yarn playwright install chromium-headless-shell
> PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers yarn test
> ```
>
> `yarn install-playwright-browser` is for CI: it passes `--with-deps`, which needs root to
> apt-install system libraries. `--dry-run` on the install prints the exact revision without
> downloading.

`rip` is deliberately bound to **one** slot; a comma-separated list is refused.
That is not a cap on concurrency — `rip-deck watch` rips every inserted disc, up
to all nine at once
([decision](docs/decisions/2026-07-26-auto-rip-every-inserted-disc-concurrently.md)).

## Running it in Docker

`makemkvcon`, `cyanrip`, and `node` all live in Rip Deck's own image
([decision](docs/decisions/2026-07-25-rip-deck-ships-its-own-makemkv.md)), so
the daemon and the ripper share one filesystem view.

```sh
docker build -t rip-deck:latest .

docker run -d --name rip-deck \
  --device-cgroup-rule 'b 11:* rmw' \
  --device-cgroup-rule 'c 21:* rmw' \
  -v /dev:/dev \
  -v /media/Disc-Rips:/media/Disc-Rips \
  -v /srv/rip-deck/makemkv:/config \
  -v /srv/rip-deck/state:/var/lib/rip-deck \
  rip-deck:latest

docker exec rip-deck rip-deck probe
```

Device **cgroup rules plus a `/dev` bind**, never a fixed `devices:` list — a
tower powered independently of the host means Docker would refuse to start a
container that names a missing device node. A ready-to-adapt Compose file is in
[`deploy/docker-compose.yaml`](deploy/docker-compose.yaml). `probe` and `rip`
must run where `/sys/block/sr*` is real.

> ⚠️ **Identify a drive by its firmware SERIAL, never by its model string.**
> Slots 2–4 are LG drives running OmniDrive firmware that reports them as
> `BW-16D1HT`, an ASUS model, so a model-keyed count credits the wrong drive.
> `config/drives.json` keys on `firmwareSerial` for this reason. Those three LG
> drives read Blu-ray at 23–35 MB/s and **cannot read a DVD at all** — a
> two-block read at sector 2048 times out after 30 s and the kernel resets the
> device
> ([findings](docs/2026-08-27-the-lg-drives-read-blu-ray-and-cannot-read-dvd.md)).

> ⚠️ **A redeploy cancels every running rip.** A rip runs in its own
> `rip-deck-rip-<uuid>` container, which makes a redeploy look safe. It is not:
> the daemon owns that child and kills it on `SIGTERM`, so restarting, stopping
> or redeploying the app destroys every disc in flight. Check first, with a
> command that fails CLOSED: `curl -sf <host>/json` piped into a parser that
> exits non-zero on any `"status": "ripping"`. Never `grep -c` — it prints `0`
> both when nothing is ripping and when the request FAILS, and those are
> opposite facts. The full command is in the
> [decision](docs/decisions/2026-08-27-a-redeploy-cancels-every-running-rip.md).

> **UHD discs.** A brand-new 4K UHD disc can fail to rip until MakeMKV's hashed-key
> bundle catches up (12–48 h), or until an AACS `keydb.cfg` that already knows the
> disc is placed at `/config/data/keydb.cfg`. That file is third-party data, is
> not shipped in this repo or image, and is not required for BD/DVD/CD.

## History — every rip, not just the last one per bay

`bays.json` in the state directory holds **one record per bay and
overwrites it**. It is bay memory — *"this disc is already done, do not re-rip
it"* — so a rip becomes unfindable the moment the next disc lands in that tray.

`$RIP_DECK_STATE_DIR/history.jsonl` is the permanent record beside it: one JSON
line per finished rip, appended at the outcome latch and never edited. That
instant is the only one where the disc's NAME, its type, its destination and the
outcome all exist together — the name reaches rip-deck from udev, and no job file
records it.

```sh
curl -s 'http://host:3007/api/history?limit=25'
curl -s 'http://host:3007/api/history?from=2026-08-25&to=2026-08-26&outcome=failed'
curl -s 'http://host:3007/api/history?q=mummy'
```

`from` / `to` take a `YYYY-MM-DD` (resolved in the DAEMON's time zone) or epoch
milliseconds. The dashboard sends milliseconds, so the browser's zone governs
what a picked day means. The dashboard's own view is at `/history`.

Bytes, duration, read errors and the health verdict are **not** in the log. They
are already written per job as `<uuid>.features.json` and `<uuid>.verdict.json`,
and the endpoint joins them back in — for the page it is about to return only.
`?limit=` caps at 200 for that reason: it bounds file opens, not bytes.

Nothing is pruned. Rips that finished before this shipped are rebuilt from their
feature vectors at start-up, keyed on job id so a live row always wins. ⚠️ A
rebuilt row has **no disc name and none can be recovered** — the reasons, all
three measured, are in
[`ripHistoryBackfill.ts`](packages/daemon/src/rip/ripHistoryBackfill.ts) and the
[decision](docs/decisions/2026-08-27-rip-history-is-an-append-only-log-beside-the-job-files.md).

## Drive identity — the thing every other project gets wrong

`/dev/srN` is **not** an identity. It reshuffles on every USB re-enumeration,
which happens whenever the tower is power-cycled independently of the host — the
normal way it is used. Three tiers, strongest first:

1. **`firmwareSerial`** — canonical. The drive's own serial, from MakeMKV's
   `DRV:` line. Unique per physical unit and retained across a firmware reflash,
   which matters because a drive running third-party firmware can *report the
   wrong model string*; the serial still identifies it. Reading it costs a
   `makemkvcon` call, so it is occasional, never on the sampling path.
2. **`usbPortPath`** — the runtime key. Free from sysfs, no device access, stable
   unless the tower is re-cabled. Maps monotonically onto physical slot order.
3. **`bridgeSerial`** — tiebreaker only. Some USB-SATA bridges report a stock
   serial that differs only in trailing hex, so it is not reliable alone.

Resolution falls through the tiers, and a firmware-serial match that disagrees
with the cached port path *repairs* the map rather than trusting the path.

## Poster lookups cache somebody else's answers

`packages/daemon/src/metadata/posterStore.ts` keeps OMDb results in a memory `Map` written
through to a versioned `posters.json` (`posterCache.ts`, atomic temp-file + `rename`). The
daemon restarts with its container and the tower keeps its discs, so without the file every
restart re-asks OMDb about the same nine labels.

`@charcuterie/server/http` (0.4.0) offers `createHttpCache` + `createThrottle` for exactly
this shape, and the library's own throttle documentation names **this repo's five-minute
cooldown when OMDb is unreachable** as the case `cooldownMs` exists for. The library owns the
policy and never the store, so `posters.json` would stay as it is behind a `{ read, write }`
adapter.

> ⚠️ **`PosterStore.get` is synchronous by contract** — *"a synchronous memory read, null
> until an answer lands"* — and `createHttpCache` is async. `buildJob` calls `get` on a hot
> path and `createNullPosterStore` returns `get: () => null`. An adoption sits behind the
> async request path and leaves `get` alone; putting the library under `get` breaks a typed
> union and a test, and would make a rip wait on somebody else's server.

Nothing has been adopted yet. The measured numbers from the one app that has, and the traps
it hit, are in `agentic/docs/runbooks/charcuterie-server-http-cache-adoption.md`.

## Hardware notes that bite

- A long active USB extension into a multi-port hub shows up in sysfs as a
  three-tier cascade — that is the hub's internal 4-port chips, not three hubs.
- **Keep an active extension's aux power plugged in.** Run passively, its
  repeater can be undervolted and the whole bank drops — a silent single point
  of failure.
- `ioerr_cnt` is formatted **hex** (`0x5c`) while every neighbouring counter is
  decimal. Parsing it base-10 makes the error counter look flat forever.
- MakeMKV pads its drive list to **16 slots**; the unused ones come back with
  empty strings and `visible === 256`.

## License

[MIT](LICENSE) © 2026 Kevin Ghadyani.

The Docker image builds on top of [`jlesage/makemkv`](https://github.com/jlesage/docker-makemkv)
and bundles MakeMKV, which is proprietary software under
[GuinpinSoft's terms](https://www.makemkv.com/) — the MIT license covers this
repository's own source, not the third-party binaries a build pulls in.

# A single-read identify latched a flapping bus as "could not read a name"

Status: Accepted
Date: 2026-07-28
Type: correctness / bug fix
Supersedes:
Superseded by:

## Decision

`identifyDisc` **retries** a read that no drive answered, up to
`IDENTIFY_TUNING.maxAttempts` (3) with a `1500 ms` settle pause between, before
it reports "could not read a name". And the dashboard now carries a bus-wide
**USB-flap banner** (`TowerView.usb_alert`) that tells the owner to change the
cable when drives are seen connecting and disconnecting.

Both are gated so they never over-fire:

- **Retry only the transient.** `didDeviceRespond(events)` decides. A drive that
  answered with a blank label (a genuinely nameless disc) and a `spawnFailure`
  (makemkvcon missing) are **final** — a retry cannot change either. Only "no
  drive answered at all" is retried.
- **The banner is its own field, not a per-bay alert.** A flap is what *holds*
  bays, and the per-bay `alerts` list is filtered to troubles touching a
  non-held bay — so folding the flap in would let its own symptom hide it. It
  also fires on an idle tower (no rip, no bay verdict) sitting on a bad cable.

## Context

Slot 7 (Pioneer BDR-211M, a Soylent Green 4K UHD) sat `held — not ripped`,
"could not read a name off this disc". The disc was fine: a second identify
seconds later read `SOYLENT GREEN` cleanly. Raw `makemkvcon` reads against the
drive alternated between a clean read (LibreDrive, titles enumerated) and
`Unknown device '/dev/sr2'` / `Failed to open disc` / `can't find any usable
optical drives` — and `dmesg` showed the tower's whole USB bank re-enumerating
in bursts: `usb 2-2: reset SuperSpeed`, `usb 2-2.2: device not accepting address
33, error -71`, a cascade of disconnect/reconnect. During the same window the
disc was physically moved to slot 8 and slot 7 *stayed* held — the daemon lost
the drive off the bus and kept its last-known state, so one disc showed as two
held bays.

The bus was flapping because the owner was running two passive USB extension
cables joined together (a temporary setup; a proper cable was 2 days out). This
is the tower's known single point of failure — see
the 12V incident and `config/drives.json`'s
own header: *"run passively the repeater is undervolted and the whole bank
drops."* `error -71` is that undervoltage.

## Why

`identifyDisc` made exactly **one** `makemkvcon info` call and turned a single
empty read into a permanent `needs_attention` latch. On a marginal bus one read
is a coin toss, so a perfectly good disc latched a hold a human then had to
clear by hand. A single-shot identify is fragile on *any* bus — a healthy tower
still throws the occasional first-read miss — and catastrophic on this one.

The banner exists because the failure was invisible: nine phantom "could not
read a name" holds never once said "your USB connection is dropping." The signal
was already in hand — the watcher reads drive **presence** every poll — so a
flap is detectable with no new device access: a drive whose presence keeps
flipping present↔absent is a drive on a bus that keeps dropping. A power cycle
(F3, normal) is two edges spread apart and stays under `flapMinEvents`; a
flapping bus runs straight past it.

## Evidence

- Live, 2026-07-28: `rip-deck rip --slot 7 --dry-run` twice in seconds — attempt
  1 "could not read a name", attempt 2 `Name: [BACKUP] SOYLENT GREEN - UHD - 4K`.
- `makemkvcon -r --noscan --cache=1 info dev:/dev/sr2` x5: 4 failed to open the
  device, 1 read the disc cleanly (and reported the drive at `/dev/sr1` — the
  node reshuffled mid-test).
- `dmesg`: `error -71 device not accepting address`, whole `2-2.*` tree
  re-enumerating; `udevadm` showed `sr0..sr3` all Pioneers with shuffled bridge
  serials.
- Owner confirmed the doubled passive cable and that it was **not** the setup
  during original testing ("CONFIRMED!"). chat: mnt-TrueNAS-Apps-Repos-agentic,
  2026-07-28.

## Notes

Not yet verified on the live tower — the owner ditched the tower for the night
and the replacement cable arrives ~2026-07-30. Detection, retry and banner are
covered by unit tests (`usbStability.test.ts`, `identifyDisc.test.ts`,
`towerView.test.ts`, `UsbAlertBanner.test.tsx`) and a `?fake=usb-flap` fixture
previews the banner without hardware. Confirm end-to-end once the cable is in.

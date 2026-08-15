# A disc present when the tower powers on is adopted, not re-ripped

Status: Accepted
Date: 2026-07-31
Type: code / safety
Refines: [The loaded-discs reminder is rebuilt from the on-disk ledger, not held in MQTT](2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)

## Decision

A disc that becomes readable on a bay whose tray has **not been confirmed
genuinely empty since the drive appeared** is routed back through
`adoptBayAtStartup` — held, or recognised from the ledger — never treated as a
fresh insert and auto-ripped. A rip starts only from a bay whose tray settled
empty first (`hasSettledEmpty`), which is proof the disc was inserted *after*
the drive was on the bus, not loaded before it.

Concretely, in `watcher.ts`:

- **`BayState.hasSettledEmpty`** — false on a fresh/adopted bay, reset to false
  the moment a drive drops off the bus (a power cycle re-opens the question), and
  set true only after `WATCHER_TUNING.settleEmptyObservations` (3) consecutive
  empty readings. A rip start and a re-arm both set it true.
- **The re-adopt gate in `tickNow`** — a known **idle** bay that now has media but
  is `!hasSettledEmpty` re-runs `adoptBayAtStartup`. That yields a held
  `needs_attention` (no memory), a recognised `done` (matching ledger record), or
  — only when the owner's own rule says so (`hasPriorState`, no record) — an armed
  bay that rips. A finished disc is held; a genuinely new disc still rips.

## Context

The [tower-off decision](2026-07-30-the-dashboard-can-switch-the-tower-off.md)
and the [ledger-rebuild decision](2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)
made rip-deck remember what was loaded across a restart. But powering the tower
back **on** with a finished disc still loaded re-ripped it anyway — measured live
on an already-backed-up **Soylent Green UHD** (the rip failed `empty_output` in
seconds, so no data was lost, but it should never have started).

The cause was timing, and it defeated every existing guard: on a cold power-on
the USB bus enumerates a drive a moment **before** its disc is readable, so the
drive's first sighting reports an **empty** tray. `adoptBayAtStartup` runs on that
first sighting, adopts an empty (idle) bay, and a poll later the disc becomes
readable — now indistinguishable, to the old poll loop, from a disc a human just
inserted. So it ripped. The ledger record (which would have said "finished") was
never consulted, because the disc arrived through the fresh-insert path, not the
adoption path.

Owner, after watching it happen and then fixing the hardware behind it:

> *"Yes, build those carefully with tests while I'm asleep. Next time I get a disc
> (Desk Set BD), we can test."*

## Why

- **A disc present at the drive's appearance is ambiguous; a disc that appears
  after a confirmed-empty tray is not.** Only a sustained empty reading
  distinguishes a genuinely empty drive from one still spinning up. `hasSettledEmpty`
  encodes exactly that, and the re-adopt gate sends the ambiguous case back
  through the logic that already fails closed.
- **It preserves both owner decisions.** A finished disc (ledger record) is held;
  a disc present at the very first sighting of a fresh daemon still rips
  ("load the tower, then start rip-deck"); a genuinely new disc loaded before a
  power-on still rips. Only the finished-disc-across-a-power-on case changed, and
  only to stop re-ripping it.
- **The failure direction is safe.** If the guard holds a disc that should have
  ripped, the operator presses Rip. If it were wrong the other way, it re-rips
  90 GB. `settleEmptyObservations` is 3, not 2, for that reason.

## Evidence

- `packages/daemon/src/rip/watcher.test.ts` — `startWatcher cold power-on`: holds
  a disc that appears after the empty first-sight (no rip, `needs_attention`);
  recognises a finished disc from its ledger record; rips a genuinely new disc;
  still rips a disc present at first sight; still rips a real insert after the tray
  settles. Reproduced the bug first as a failing test, then fixed it.
- 1020 daemon tests green; no regressions in the existing bay-memory / rip-start
  suites.
- Live: an already-backed-up Soylent Green UHD re-ripped on power-on under 1.2.3;
  this ships in 1.2.4.

## Note on the sibling bug

The stuck-`failed` slot 9 card the owner also hit was investigated: the re-arm
logic (`emptyObservationCount` → `rearm`) is correct and verified by test for a
confirmed-empty tray, so the watcher had already re-armed to idle
(`loaded_discs.count` was 0); the dashboard card lagged. A daemon restart cleared
it. Not fixed here — it loses no data and its exact display-sync cause is still
open.

# The bulk tray control is two buttons: an escalating "Open trays" and a plain "Close trays"

Status: Accepted
Date: 2026-07-30
Type: ux / behaviour
Supersedes: `docs/decisions/2026-07-27-bulk-tray-buttons-fall-back-to-open-all.md`
Superseded by: `2026-08-29-bulk-tray-moves-are-serial-and-close-is-blocked-during-a-rip.md` (parallel execution and close-during-rip clauses only)

## Decision

The single toggling "⏏ Open all complete" button is replaced by **two separate,
non-toggling buttons**: **Open trays** and **Close trays**. The old button opened
on the first press and *closed* on the next, from one control — confusing, and
the "complete" label no longer fits.

### Open trays — tower-aware and escalating

Evaluated against live state each press; **never touches a `starting`/`ripping`
bay** (that refusal is unchanged and stays first):

1. **Tower off** → publish a power-on command (see below) and do nothing else
   this press. "Off" = no drives present (`is_tower_present` false).
2. **Tower on, first press** → open every **finished** bay: a completed
   successful rip **or** a failed / needs-attention disc — i.e. every disc that
   is done and ready to be removed.
3. **Tower on, nothing finished** → open every **non-ripping** bay.
4. **Tower on, finished bays already open** → open the rest (every remaining
   non-ripping bay, including idle/empty).

Steps 2 and 4 are the "press again to open more" escalation, and it is **stateless
— inferred from tray memory, not a click counter**. The daemon already records
each bay's `lastTrayCommand`; "the finished bays are already open" is a fact it
can read, so a second press naturally escalates without the UI counting anything.
This is the same tray-memory authority established in
`2026-07-27-tray-memory-beats-disc-presence.md`.

### Close trays — plain

Close every bay that is currently **open**, read from the same tray memory. No
escalation, no toggle, no conditions beyond "is it open."

### Tower power-on is a new MQTT → HA capability

Rip Deck today only publishes *activity* that an HA automation uses to power the
tower **off** (`docs/tower-auto-power-off.md`); it has never powered it **on**.
"Open trays while off powers the tower on" adds that, and it goes **over MQTT per
the house rule**, never a REST/shell bridge: Rip Deck publishes a power-on
command on its `cmd/*` topic space, and a small HA automation turns that into
`switch.turn_on` on `switch.optical_ripper_power_control_power`. The button does
not touch the switch directly.

## Context

The owner, on the live dashboard, 2026-07-30:

- *"the 'open all drives' and 'close all drives' code is super laggy and doesn't
  work correctly."* (The daemon already fans out tray moves with `Promise.all`,
  so the fan-out is concurrent; the lag was a busy drive blocking one `eject` for
  its 20 s timeout — see the invisible-rip note below — not a one-by-one loop.)
- *"that 'open all' in the UI is a toggle and will close any open drives if drives
  are open."* — the toggle is the confusing part.
- The escalation spec, verbatim: tower off → turn on; tower on → open failed, else
  open non-ripping; pressed a second time → open all. Close = close all opened
  bays. Clarified in the same session that "finished" (completed **and** failed)
  is the first group to open, not failures alone.
- Terminology: **"Open trays" / "Close trays"** ("trays," not "drives" —
  matching the physical thing that moves).

The lag investigation also surfaced that there is **no Home Assistant automation**
behind the bulk trays at all (an HA config search for `rip-deck/tower/cmd/drive`
found nothing) — so the earlier guess that "that automation is in `mode: restart`"
had no automation to be about. The bulk trays are the dashboard's own command
straight to the daemon.

## Why

- **Two buttons, no toggle** — a control whose action depends on invisible prior
  state ("did I open something already?") is the defect the owner named. Open
  always opens; Close always closes.
- **Finished-first escalation** — the discs you reach for are the ones that are
  done. Opening every finished bay on the first press, then everything on the
  next, matches "grab the results, then clear the rack."
- **Stateless from tray memory** — the daemon is the authority on tray position
  (`2026-07-27-tray-memory-beats-disc-presence.md`), so the escalation and Close
  read from it rather than the UI counting presses, which survives a page reload
  and two dashboards open at once.
- **Power-on over MQTT** — the house rule is services integrate over MQTT
  (Mosquitto `cmd/*`/`resp/*`), not new REST/shell bridges. A dashboard button
  poking the HA switch directly would be exactly such a bridge.

## Evidence

- Owner quotes above, 2026-07-30 session.
- `AskUserQuestion`, 2026-07-30: finished-first ("completed + failed, then all"),
  power-on **yes** (MQTT → HA), labels **"Open trays" / "Close trays."**
- Fan-out is already concurrent: `packages/daemon/src/rip/watcher.ts` ~L2527
  `await Promise.all(candidates.map(...))`, each an `eject` child with a 20 s
  watchdog (`packages/daemon/src/rip/tray.ts`).

## Not built yet

This records the settled design. Implementation spans the daemon (tray decision
logic + a power-on publish + tower-off branch), the dashboard (two buttons, new
labels, stateless escalation), and a new HA automation (`home-assistant`), and
ships on the next image deploy alongside the
[`wasDiscRead` identify fix](2026-07-30-identify-retries-until-the-disc-is-read-not-until-a-drive-answers.md).

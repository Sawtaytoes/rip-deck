# The tower's auto power-off triggers on idleness, never on closed trays

Status: Accepted
Date: 2026-07-26
Type: safety / integration contract
Amends: the standing "turn it off when you finish" rule in
`HANDOFF.md` §0, which is a human remembering
Reasoning corrected by:
[`2026-07-26-operator-triggered-eject-over-mqtt.md`](2026-07-26-operator-triggered-eject-over-mqtt.md)
— the sentence *"`rip-deck` never ejects"* below is too wide. The **decision** is
unchanged and still correct: tray position still separates nothing, and the last
bullet under "Consequences to watch" already anticipated this exactly.

## Decision

`rip-deck` publishes a retained `<base>/activity` topic carrying an active-rip
count and a last-activity timestamp, and the Home Assistant automation that
powers the tower off triggers on **that** — no rips and no drive-set change for
a configurable window.

**The owner's second condition, "or all drives closed now", is NOT
implemented**, and should not be added later.

The rule fails closed. Missing, stale or `unavailable` rip-deck state is a
refusal, never a power-off. A consequence of that, accepted deliberately:
**with `rip-deck watch` not running, the tower never auto-powers-off.**

## Context

The owner asked for the power-off to be automated and tunable:

> *"If no rips or drive changes in X time, or all drives closed now, then shut
> off tower."*

The first half is a good rule and is built. The second half cannot be built,
for a reason that comes straight out of this project's own hard constraints.

## Why

**`rip-deck` never ejects, so a closed tray is the resting state.** B3 is not a
missing feature — the eject/insert flap-storm is the documented root cause that
killed valid rips in other bays, so every give-up path in `settle.ts`,
`discType.ts` and `watcher.ts` leaves the disc exactly where it is. "All trays
closed" is therefore true during a rip, after a rip, during a failure, and when
a drive is empty. It separates none of those from each other; it is a constant
wearing the costume of a condition.

**It was measurably true and dangerous at the moment it was proposed.** On the
live tower, 2026-07-26: all nine trays closed, three discs actively ripping (one
Blu-ray at 84%, two UHDs at ~16%). Wired as stated, the automation's second
branch would have been true at that instant and would have cut mains power to
three rips in progress, two of them an hour from completion. Two 90 GB UHD
backups and a Blu-ray, lost to a condition that was supposed to be a
convenience.

**"Idle" has to mean work, and work has to be positively reported.** A rip in
progress moves no bay state for an hour, so change-detection alone would have
made the same mistake from the other direction. `active_rip_count > 0` refreshes
the idle clock on every sweep, and `starting` counts as active as well as
`ripping` so the settle/identify window is not a hole.

**Unknown is not idle.** This mirrors what the rest of `rip-deck` already does
with ambiguity: an unidentified disc stays in the drive, a drive that is not on
the bus tells us nothing about its disc, and exit code 0 is not success. The
same reasoning applied to mains power says an absent signal must never be read
as permission to cut it. The LWT on `<base>/availability` is what makes that
mechanical rather than aspirational.

## Evidence

Owner, 2026-07-26: *"If no rips or drive changes in X time, or all drives closed
now, then shut off tower."*

Live tower state at the time of writing, reported by the session lead:
nine trays closed, three rips in flight (BD 84%, two UHD ~16%, roughly 75
minutes remaining).

`AGENTS.md` hard constraint: *"Fail closed on ambiguity. An unidentified disc
stays in the drive and is marked needs-attention. **Never eject-loop** — that is
the root cause of the flap-storm that killed valid rips on other drives."*

## Consequences to watch

- **A stopped daemon means a tower that stays on.** If the owner stops
  `rip-deck watch` and expects the tower to power itself off, it will not. That
  is the trade this decision makes, and it is the right way round: the failure
  mode is a wasted 30 W, not three destroyed rips.
- **The window is tunable from the UI, not from YAML** —
  `input_number.optical_ripper_idle_timeout_minutes`. If the owner finds himself
  editing the automation to change the timing, the helper is wrong, not the
  rule.
- If a future rip-deck ever does eject (it should not), this decision does not
  suddenly make the tray rule safe. Tray state would still say nothing about
  whether a rip is running.

Design detail: `../tower-auto-power-off.md`.
The Home Assistant side is `home-assistant/optical-ripper-auto-power-off.md` in
the `agentic` repo.

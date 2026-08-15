# The dashboard can switch the tower off, and remembers what it trapped

Status: Accepted
Date: 2026-07-30
Type: code / UX
Refined by: [The loaded-discs reminder is rebuilt from the on-disk ledger, not held in MQTT](2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md) — the loaded-discs half below (answered from the bay/sighting tables, retained-MQTT as the cross-restart memory) is superseded by rebuilding the reminder from the on-disk ledger; the retained topic becomes a downstream mirror. The `power_off` half stands.

## Decision

Two related things, because they are the same fact seen twice.

**1. A `power_off` command, and a Tower off button beside Open/Close trays.**
It publishes `off` on the existing `cmd/power` topic, which a Home Assistant
automation relays to `switch.turn_off`. rip-deck never touches the switch
directly — same route the dashboard's Open-on-a-dark-tower press already used to
ask for `on`.

- **⚠️ A running rip refuses the whole press.** Every bay goes through
  `decideTrayBayAction` exactly as it would for ⏏, and one bay mid-rip is enough,
  because there is one power lead. A bus that will not answer also refuses — the
  one input that could say no is missing, so the press is refused rather than
  guessed.
- **Loaded-but-idle discs are WARNED about and the tower goes off anyway.** The
  owner was asked and chose this over a two-step confirm and over
  refuse-until-empty.
- **There is no Tower on button.** A dark tower is powered on by pressing Open
  trays, which is the press someone walking up to a dead rack was going to make
  anyway.

**2. A retained `loaded` topic, a `Discs loaded` sensor, a dashboard banner, and
a reminder automation** — "there are still discs in the tower", answered from
memory rather than from a probe.

## Context

Two owner messages on 2026-07-30, one after the other:

> *"I'd like to see a way to turn off the tower from the Rip Deck Web UI."*

> *"The UI can note that something was in a tray when you power it off. It
> doesn't today. But I was outta the house when it finished ripping, so
> normally, it'd go off after 30 min or so. I manually turned it off. It'd be
> good to know in the UI or through a Home Assistant automation as a reminder to
> take out the disc. Kinda like taking out the trash or there's a leak. It's
> something I need to do eventually but wasn't at home to do it."*

The second is the harder one and it is not a UI request. It is a request for a
fact that **survives the tower going dark**, and everything rip-deck publishes
until now describes what is happening *now*: a rip, a verdict, a flapping bus,
all of which go quiet the moment the power drops. The auto-power-off automation
means this is the tower's normal resting state, not an edge case — so the one
thing worth knowing about a dark tower had no way to be known.

## Why

**Because power-off belongs on the command surface that already owns the
refusal.** Cutting mains is the most destructive thing reachable from this
dashboard, and the machinery that stops a press destroying a rip already exists
and is tested — `decideTrayBayAction`'s first branch, asked of every bay. Putting
the button anywhere else would mean either duplicating that refusal or skipping
it. A second command path to the hardware is also how a drive gets two writers,
which is the argument `rip_bay` already made
([decision](2026-07-30-a-held-bay-is-ripped-from-the-dashboard.md)).

**Because trapping a disc and killing a rip are not the same size of mistake.**
A trapped disc costs a walk downstairs and a power-on; a rip cut at 80% costs
90 GB and an hour, and it is unrecoverable. So one is warned about and the other
is refused, and they are not traded off against each other. The owner's own call
on the first: he knows what is in his tower, and a control that argues with him
about a reversible, self-inflicted inconvenience is the held-card defect again.

**Because the reminder cannot be read off the hardware.** A powered-off tower has
no drives on the bus, so `hasFinishedDisc` — whose first term is
`observation.isDrivePresent` — answers false for every bay. The answer comes from
the **bay table**, which `tickNow` keeps rather than drops when a drive leaves
("a dropped bay comes back as a fresh idle one, and a fresh idle bay with a
finished disc still in it re-rips that disc"), and the **sighting table**, which
keeps a vanished bay's slot and label.

**Because retention is the honest fix for the one case memory cannot cover.** A
daemon restarted while the tower is dark builds no bays at all. Rather than
inventing bays from the ledger for drives that are not there — phantom bays the
rest of the system would then reason about — the payload is **retained**, so the
broker holds the last thing rip-deck actually knew. `shouldPublishLoadedDiscs` is
the matching rule on the write side and it is the whole reason the topic can be
trusted: **a summary that is both empty and blind is not published**, because an
empty answer from a daemon that can see nothing is an absence of evidence, not an
all-clear. Same shape as `activity`'s rule — *unknown is not idle* — and here
*unknown is not empty*. Verified live: 1.2.1 started against a dark tower and
published nothing to `loaded`.

**Because a chore is not an alert.** The banner is slate, not amber or red.
`UsbAlertBanner` is red because a bad cable is a fault; `HeldBayCard` is amber
because rip-deck declined to act. This is neither — the rip worked, the drive is
fine, and the only thing outstanding is a walk to the rack. A chore rendered as a
warning is how a person learns to ignore warnings. The Home Assistant side is a
**phone push, never TTS**, for the same reason and one more: the whole point is
that it reaches him when he is *not* at the dashboard.

## Evidence

Owner, 2026-07-30, quoted in full above.

⚠️ **The Home Assistant hazard this had to fix first.** The `cmd/power` trigger
matched the **topic alone** and called `switch.turn_on` unconditionally, because
`on` was the only word rip-deck had ever published. Publishing `off` against that
automation would have turned the tower **on**. Both triggers are now
payload-filtered natively (`payload: "on"` / `payload: "off"`), and the HA side
was updated **before** the daemon that publishes `off` was deployed.

Live on `rip-deck:1.2.1`:

- `homeassistant/sensor/rip-deck_tower/discs_loaded/config` discovered;
  `sensor.rip_deck_discs_loaded` exists, `unknown` while the tower is
  dark and rip-deck knows nothing.
- `rip-deck/tower/loaded` correctly has **no retained payload** after a
  restart against a powered-off tower.
- `automation.control_optical_ripper_tower` and
  `automation.optical_ripper_discs_reminder` both loaded and `on`.

1260 tests green. The load-bearing ones:

- `watcher.test.ts` — the refusal cuts nothing and speaks the RODRET's own
  sentence; a bus that will not answer refuses too; the trapped-disc warning is
  in the report and the tower still goes off; and `getLoadedDiscs` still answers
  **after every drive has left the bus**, which is the reminder's whole reason
  for existing.
- `loadedDiscs.test.ts` — a blind empty summary is not publishable; a *seen*
  empty one is; the reminder never speaks a drive model.
- `TrayControls.test.tsx` — the refusal is rendered rather than swallowed, and
  the trapped-disc warning is not dropped.

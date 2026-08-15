# The tower's mobo USB3 port survived — the cable was the fault, and a good 10 m active cable on the PSU 5 V rail fixes the wedge

Status: Accepted
Date: 2026-07-30
Type: hardware / diagnosis
Supersedes: the "still open" question in `docs/2026-07-27-12v-into-5v-usb-incident.md`
Refines: `docs/decisions/2026-07-24-active-usb-extension-aux-power-explains-the-wedge.md`

## Decision

The suspect motherboard USB3 port on Tower — the "bottom-right rear USB3
port" left open in the 12 V incident — is **good**. The tower is back on **that
same original port** running SuperSpeed, and the whole USB failure history is now
attributed to **cabling, not the port**:

- The port was never the fault. Both the pre-incident wedge and the post-incident
  USB-2.1-only flapping were the cables — the first an active extension run
  undervolted, the second the extension the 12 V spike killed.
- The fix in place is a **new 10 m active USB extension** with a **power-indicator
  light** (so the silent-undervolt failure mode is now visible at a glance), and
  it enumerates the full bank clean at SuperSpeed.
- Supplementary power to the extension now comes from **the PSU's 5 V rail**, not
  a separate AC → USB 5 V 2 A adapter. Same 5 V into the same injection point, one
  fewer wall wart and one fewer thing to unplug by mistake.

Consequently:

- **Do not re-litigate the port.** Do not move the tower to a different port or
  buy a second xHCI card to "work around" it. The 2026-07-24 "no powered hub, no
  controller spread" guidance stands, for the same reason.
- **The standing aux-power check is now a light, not a guess.** The extension's
  power LED is the at-a-glance version of "keep the aux power plugged in." If the
  wedge signature ever returns, look at that light first.
- **The tower's USB port path changed** from `2-1.1.2` to **`2-1.3`** (a
  different physical root-hub port). `config/drives.json` `towerRootPortPath` is
  updated to match; re-run `rip-deck probe` after any future re-cable and update
  it again. Identity is still the firmware serial, so slot mapping was unaffected.

## Context

Two cable failures, one port, read as three things over six days:

1. **2026-07-24** — the wedge (SuperSpeed resets, whole-bank re-enumeration,
   `scsi_eh` D-state). Diagnosed as an active extension run passively /
   undervolted; aux power connected and it stopped recurring
   ([decision](2026-07-24-active-usb-extension-aux-power-explains-the-wedge.md)).
2. **2026-07-27** — 12 V fed into the 5 V injection point cooked that extension's
   SuperSpeed pairs; the bank then enumerated USB-2.1-only and flapped. The port
   was *suspected* but "not proven guilty," because the dead cable alone
   explained every symptom
   (incident).
3. **2026-07-30** — a new 10 m active cable on the same port brings the whole
   bank back at SuperSpeed. That is the clean test the incident doc asked for,
   and it clears the port.

The through-line: every USB fault this tower has thrown was a cable — undervolted,
then over-volted-to-death — never the motherboard port. The 2026-07-24 decision's
core claim (the extension's power is the thing that bites) holds; this refines its
"keep the aux power plugged in" into "and now there's a light that shows it," and
records that the feed is the PSU 5 V rail.

## Why

A dead/undervolted cable and a good one are trivially distinguishable at the link
layer, and the good one wins cleanly: `lsusb -t` on bus 02 shows the root hub at
10000M with the whole tower attached at 5000M (SuperSpeed), nine mass-storage
devices present, no USB-2.1 fallback and no flap. A dead controller or port would
not enumerate SuperSpeed at all; a dead cable enumerates USB-2.1-only or not at
all. We see neither failure mode — so the port is good.

## Evidence

- Owner, 2026-07-30: "that port I originally used for USB3 is still working on the
  NAS mobo! It was the cable that went bad only and the other cables simply
  weren't good. But this new one works fine! It also has a light showing me if
  it's powered, and it's 10m! External power is coming from the PSU as 5V now, not
  a separate AC → USB 5V 2A."
- Live `lsusb -t` (bus 02), 2026-07-30: root_hub 10000M → hub 5000M → hub 5000M →
  nine Mass Storage devices at 5000M, plus the internal 4-port cascade. No
  USB-2.1 fallback.
- Live rip-deck `/json`, 2026-07-30: nine drives present, all resolved to slot,
  drive IDs under `2-1.3` (was `2-1.1.2`).

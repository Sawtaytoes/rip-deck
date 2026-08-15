# The rip tower's USB wedge is explained by an active extension cable run passively

Status: Accepted
Date: 2026-07-24
Type: hardware / diagnosis
Supersedes: the diagnosis in `arm-tower-2026-07-24-findings.md` §8

## Decision

Treat the whole USB failure cascade on the rip tower — SuperSpeed link resets,
whole-bank re-enumeration, and the `scsi_eh` D-state host wedge — as **one
sufficient cause: the tower's 10–15 m USB extension is an ACTIVE cable that had
been running passively, i.e. with its repeater undervolted.**

Consequently:

- **Keep the extension cable's aux power plugged in.** This is now a standing
  check with a silent, catastrophic failure mode, not a one-off fix.
- **Do not buy a powered hub or a second xHCI card yet.** Both were proposed
  against a diagnosis that no longer holds.
- **Let the health sidecar settle it empirically.** Its hub-correlation detector
  (≥2 drives in one USB subtree collapsing within 60 s) is exactly the
  instrument that proves whether wedges recur.

## Context

`arm-tower-2026-07-24-findings.md` §8 concluded the concurrency collapse was a
kernel SCSI-EH head-of-line block and recommended spreading drives across
multiple physical xHCI controllers plus a powered hub at the tower. That
document was written the same night with two variables still in motion, and it
described the aux-power fix as only "partial".

The owner's lived experience since is the better evidence: **since the aux power
was connected, the wedge has not recurred.**

The rack's actual topology was also clarified by the owner: it is one long
active USB extension into **one physical 10-port hub**, into the ASMedia
USB-SATA adapters. What sysfs presents as a three-tier cascade of 4-port hubs
(`2-1.1.2` → `.4` → `.4.4`) is that single hub's **internal chip layout**, not
three separate hubs.

## Why

An undervolted repeater is a complete causal chain for everything observed:

1. It drops the SuperSpeed link under sustained load →
2. the `reset SuperSpeed USB device` storm in §4 →
3. a drive goes NOT READY / drops the link →
4. the kernel's per-host `scsi_eh` enters recovery and blocks uninterruptibly →
5. that freezes the whole SCSI host's command queue → §8's head-of-line block.

Nothing in that chain needs a bandwidth explanation, and bandwidth was never a
plausible one: 9 × ~17 MB/s ≈ 153 MB/s is far under SuperSpeed's real ~400 MB/s
ceiling, and all nine drives sit on one xHCI controller at `0000:06:00.3`.

The topology correction also matters for how faults must be *reported*. Because
one cable and one hub sit above every drive, the dominant failure mode hits all
nine at once. A detector that only correlated within sysfs subtrees would
describe a whole-tower cable fault as three unrelated chip faults. So the health
engine correlates up the full hub chain and, when the explaining node is the
tower root, names the aux power explicitly.

## Evidence

- Owner, 2026-07-24: the extension is an **active** cable that had been run
  **passively**; since its aux power was connected the problem has not recurred.
- Owner, 2026-07-24: "It's a long 10m-15m USB cable into a single 10-port USB
  hub into those SATA to USB adapters."
- Observed live 2026-07-24 while the tower was down:
  `usb 2-1.1.2.4-port2: cannot reset (err = -71)` → `attempt power cycle` →
  whole-subtree USB disconnect — the same signature, with the bank powered off.
- Verified after power-on: all 9 drives enumerate, one xHCI controller, three
  internal hub tiers of 3 drives each.
- Superseded recommendation: `arm-tower-2026-07-24-findings.md` §8 items 1 and 2
  (controller spread, powered hub). Item 3 (fast per-rip stall-death) and item 4
  (`--noscan` + `dev:` scoping) stand and are implemented in `rip-deck`.

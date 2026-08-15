# `makemkvcon backup` takes a disc index, and scans the whole bus to resolve it

Status: Accepted
Date: 2026-07-25
Type: constraint / discovered on hardware
Amends: the E2/E3 isolation claim, which `--noscan` alone does not deliver on a
rip path
Amended by: [Each rip runs in its own container that can see one
`/dev/srN`](2026-07-26-each-rip-runs-in-its-own-device-scoped-container.md) —
builds the per-rip device isolation this record called for and left unbuilt

## Decision

Accept, for now, that **a rip cannot be device-scoped the way `info` can**, and
compensate rather than pretend otherwise:

- `buildRipArgs` emits `disc:<index>`, not `dev:/dev/srN`.
- The index is resolved by `enumerateDrives()` **immediately before** the spawn.
- `ripJob` **verifies** that index against MakeMKV's own DRV table — which
  `backup` re-emits before reading a byte — and aborts with `wrong_drive` on a
  mismatch, while nothing has been written.
- `--noscan` **stays** on the rip argv even though `backup` ignores it, because
  it is correct and effective on the `info` paths and costs nothing here.

**The intended real fix is per-rip device isolation**: run each rip in a
container that can see only its own `/dev/srN`. Then MakeMKV's scan finds
exactly one drive, the index is always `disc:0`, and a wedged sibling is not
merely deprioritised but structurally invisible. Not built yet — it is the
natural Stage 6 shape now that `rip-deck` owns its own image
([decision](2026-07-25-rip-deck-ships-its-own-makemkv.md)).

## Context

Measured on Tower, 2026-07-25, during the first rip attempt against a real
disc. Two facts, neither documented by MakeMKV:

1. **`backup` rejects a device source.** `backup --decrypt dev:/dev/sr0` exits
   **10** with `Backup source must start with "disc:"` on stderr. `info`
   accepts `dev:`. `mkv` accepts `dev:`. The usage text lists the four source
   forms once, globally, and does not mention that `backup` takes exactly one
   of them.

2. **`backup disc:N` scans the whole bus despite `--noscan`.** It emits
   `PRGT:5018 "Scanning CD-ROM devices"`, runs PRGV 0 -> max, and prints the
   full 16-row DRV table before starting. This is unavoidable: a `disc:` source
   is *defined* in terms of that enumeration.

The disc index is also a **third numbering**, agreeing with neither the physical
slot nor the kernel's `srN`:

| Slot | Device | Disc index |
| --- | --- | --- |
| 9 | `/dev/sr0` | `disc:5` |
| 1 | `/dev/sr8` | `disc:0` |

## Why

- **The requirement catalogue is now partly aspirational on rip paths, and
  saying so is better than quietly shipping the gap.** E3 names `--noscan` as
  the direct fix for the 17-minute "Scanning CD-ROM devices" hang at 0% CPU.
  That fix holds for `info` and does not hold for `backup`. A wedged sibling can
  therefore still delay the *start* of an unrelated rip. It cannot corrupt one:
  the scan completes before any read of our disc begins.
- **The verification is not optional.** The index is enumeration-derived, so a
  drive appearing or disappearing between our enumeration and the rip shifts
  every index after it. A stale index does not produce an error — it produces a
  successful rip of a **different bay's disc into a folder named after this
  one**, which no later inspection can untangle. MakeMKV hands us the mapping it
  is actually using, for free, before it writes anything; not checking it would
  be negligent.
- **Per-rip device isolation is the only way to get real isolation back**, since
  the scan cannot be suppressed by any flag. Making the sibling drives invisible
  is strictly stronger than asking MakeMKV not to look at them.

## Evidence

```
$ makemkvcon -r --noscan ... backup --decrypt dev:/dev/sr0 <out>
Backup source must start with "disc:"
exit=10

$ makemkvcon -r --noscan ... backup --decrypt disc:5 <out>
PRGT:5018,0,"Scanning CD-ROM devices"
PRGV:0,0,65536 ... PRGV:65536,65536,65536
DRV:5,0,999,0,"BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00009","","/dev/sr0"
```

Covered by `discIndex.test.ts`, whose fixture is this rig's real DRV output.

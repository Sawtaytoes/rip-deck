# A disc's name comes from udev's volume label, before `makemkvcon` is asked

Status: Accepted
Date: 2026-08-26
Type: code / correctness
Refines: [A `starting` bay does not refuse the Tower off press, and an identify timeout must resolve](2026-08-26-a-starting-bay-does-not-refuse-the-tower-off-press.md)
— that decision bounded a wedged identify. This one stops most identifies from
running at all.

## Decision

A disc's name comes from three sources, in this order:

1. **The operator** (`--name`, or the dashboard's name box). He is looking at
   the sleeve.
2. **The disc's own volume label**, read from udev's database — `ID_FS_LABEL` in
   `/run/udev/data/b<major>:<minor>`. Costs **no device I/O**.
3. **`makemkvcon info`**, unchanged, for the discs udev could not read.

The precedence is a pure function, `chooseDiscNameSource` in `identifyDisc.ts`,
because `identifyDisc` itself cannot be reached from a test — it sits behind
`waitForSettledMedia` and `detectDiscType`, both of which read `/sys/block/srN`.

`decideDiscType` carries the label out on its `rip` decision as `volumeLabel`.
It already read the udev record to route the disc; the name was in the same
file. **No second read is added by this change.**

When the label is used, the bay says so:
`named "…" from the disc's own volume label — no drive read needed`.

## Context

The owner loaded 8 DVDs on 2026-08-26. Every one of them came back nameless and
asked him to type a title. His words: *"What's going on. Do I have to type a
name?"*

Their labels were sitting in `/run/udev/data` the whole time —
`TEENAGE_MUTANT_NINJA_TURTLES`, `Teenage_Mutant_Ninja_Turtles_V7_Disc_1`, and so
on. `blkid` printed them instantly on a wedged bus.

## Why

Two facts about `makemkvcon info`, both measured on this rig:

1. **`--noscan` does not stop the scan.** A scoped `info dev:/dev/srN` still
   reports `PRGT:5018 "Scanning CD-ROM devices"` and walks the whole USB bus. So
   ONE wedged drive delays the identify of every healthy bay. `backup` was
   already known to ignore `--noscan`
   ([2026-07-25](2026-07-25-backup-takes-a-disc-index-and-scans-the-bus.md));
   `info` does too, and the comment in `identifyDisc.ts` claiming otherwise was
   wrong.
2. **It outran its 120 s timeout.** With four of nine drives wedged, every
   identify in the rack timed out.

udev's record is a plain file. Reading it cannot hang, cannot fail to spawn, and
cannot inherit a wedged drive's SCSI timeout — the same argument
`parseUdevDatabaseRecord` already makes for reading the record at all.

Raising the timeout was the obvious alternative and it is the wrong fix: it
makes the operator wait longer for an answer we already have, and it does
nothing about one bad drive taxing eight good ones.

## Evidence

Read off the live tower, 2026-08-26, with the bus in the state that produced the
eight nameless discs:

```
sr0  type=udf  label=[Teenage_Mutant_Ninja_Turtles_V7_Disc_2]
sr1  type=udf  label=[Teenage_Mutant_Ninja_Turtles_V7_Disc_1]
sr3  type=udf  label=[Teenage_Mutant_Ninja_Turtle_V6]
sr4  type=udf  label=[TEENAGE_MUTANT_NINJA_TURTLES]
sr8  type=udf  label=[TEENAGE_MUTANT_NINJA_TURTLES]
```

⚠️ **`ID_FS_LABEL`, never `ID_FS_VOLUME_ID`.** The latter is the ISO9660 field
and is capped at 32 characters. On these very discs it truncates
`Teenage_Mutant_Ninja_Turtles_V7_Disc_2` to
`Teenage_Mutant_Ninja_Turtles_V` — losing the one part that separates Disc 2
from Disc 1. `ID_FS_LABEL` comes from UDF and carries the whole string. Not
`ID_FS_LABEL_ENC` either: that is the escaped form, for building device paths.

## Consequences to watch

- **A wrong label is now used without a drive read.** It was already used —
  `makemkvcon` returns the same string — so this changes where it came from, not
  what it says. `--name` still overrides.
- **A blank label is not a name.** An empty or whitespace-only value from either
  source falls through, because accepting one would build a folder called
  `" (2026) - DVD"` and bury the disc.
- **An audio CD has no filesystem and so no label.** Harmless: an album names
  itself from AccurateRip/CDDB and never from a volume label.
- **This depends on the `/run/udev` mount.** Without it `readUdevRecord` returns
  null, `decideDiscType` falls to the capacity-only path, `volumeLabel` is null
  and every disc goes to `makemkvcon` — which is exactly the old behaviour, so
  the degradation is safe but silent.

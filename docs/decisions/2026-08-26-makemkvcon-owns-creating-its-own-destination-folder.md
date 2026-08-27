# `makemkvcon backup` owns creating its destination folder — we only name it

Status: Accepted
Date: 2026-08-26
Type: code / correctness

## Decision

`prepareDestination` **names** `.rip-deck-incomplete-<uuid>` and does not create
it. `makemkvcon backup` creates it. `finaliseDestination` renames it afterwards,
exactly as before.

Two consequences fall out of that, and both are part of this decision:

1. `prepareDestination` is **synchronous**. It does no I/O now, and saying so in
   the signature is more honest than an `async` that never awaits.
2. A failed rip reports `incompletePath` **only when the directory exists**.
   MakeMKV owns the creation, so a rip that died before the backup began leaves
   nothing behind, and `Partial output KEPT at …` for a path that is not there
   sends a reader to look for a directory that never existed.

⚠️ **This is the makemkv path only.** cyanrip is the exact opposite: it is
spawned with the incomplete directory as its `cwd`, so that one MUST exist
before the spawn, and `ripAudioCd` creates its own. Do not "consolidate" the two
— they disagree on purpose, and the comment on `prepareDestination` says so.

## Context

The owner loaded 8 Teenage Mutant Ninja Turtles DVDs on 2026-08-26. After the
`starting`-bay wedge was fixed and disc names were supplied by hand, four rips
started — and all four failed with `empty_output`, which names no cause.

The robot log did name it:

```
MSG:5072 "Backing up disc into folder file:///media/Disc-Rips/.rip-deck-incomplete-71f30886-…"
MSG:5068,516,1,"Folder /media/Disc-Rips/.rip-deck-incomplete-71f30886-… already contains a backup, please choose another folder"
MSG:5069 "Backup failed"
```

`makemkvcon` then exited **0**. So the only signal that reached the operator was
a rip that produced no files.

`destination.ts:201` had created that folder a moment earlier, with
`mkdir(incompletePath, { recursive: true })`.

## Why

"Already contains a backup" is a misleading message: the directory was empty.
MakeMKV means "this path is taken". It refuses to write into a destination that
exists, even an empty one it would happily have created itself.

We had no reason to create it. Nothing between `prepareDestination` and the
spawn reads the directory, and everything after the spawn runs only when the
backup succeeded — at which point MakeMKV has created it.

## Evidence

A/B on the live tower, 2026-08-26. Same disc, same drive (slot 9, Pioneer
BDR-211M), one isolated container per case, identical `makemkvcon` argv. The
only difference was whether the destination was there first:

| Destination | Result |
| --- | --- |
| pre-created, empty | `MSG:5068` → `MSG:5069 Backup failed`, exit 0, nothing written |
| absent | `MSG:5072`, then `PRGV` climbing — the backup runs |

Guarded by `destination.test.ts` → *"⚠️ does NOT create the incomplete
directory"*.

## Consequences to watch

- **Why did Blu-ray rips never hit this?** They did not, and this decision does
  not explain why — two BD/UHD rips completed on 2026-08-25 through the same
  pre-creating code. The likeliest reading is that MakeMKV's "already contains a
  backup" check is per-format, and only the DVD path treats a bare existing
  directory as taken. Not proven. It does not change the fix: not creating the
  directory is correct for both.
- `verifyBackupStructure` and `finaliseDestination` still assume the directory
  exists. They are reached only on `exitCode === 0`, so that assumption holds —
  but it is now MakeMKV's guarantee rather than ours.

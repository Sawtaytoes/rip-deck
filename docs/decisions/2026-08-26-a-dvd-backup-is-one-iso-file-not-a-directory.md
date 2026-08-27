# A DVD backup is one ISO file, not a directory

Status: Accepted
Date: 2026-08-26
Type: code / correctness
Refines: [`makemkvcon backup` owns creating its destination folder — we only name it](2026-08-26-makemkvcon-owns-creating-its-own-destination-folder.md)
— that decision stopped pre-creating the destination, which was right. It left
one question open ("why did Blu-ray never hit this?") and guessed at the answer.
This is the answer, measured.

## Decision

`makemkvcon backup` produces **two different shapes**, and nothing it prints says
which:

| Disc | What lands at the destination path |
| --- | --- |
| Blu-ray / UHD | a **directory**, holding `BDMV`, `CERTIFICATE` and the rest |
| DVD | a single decrypted **ISO image file**, no extension, no directory |

Three consequences, and all three are this decision:

1. **`verifyBackupStructure` accepts either.** A regular file is verified by the
   ISO9660 signature `CD001` at byte 32769 — MakeMKV writes no extension, so
   there is nothing else to key on, and "it is a big file" would bless a
   truncated one. Both shapes then meet the same size floor.
2. **A file-shaped rip is published with `.iso`.** The suffix is decided from
   what is on disk at finalise time, never inferred from the disc type upstream.
   A collision marker goes **before** the extension:
   `… - DVD (rip-deck-duplicate-01234567).iso`.
3. **`applyOutputOwnership` returns early on a file.** It used to `readdir` its
   own argument, which throws `ENOTDIR` on a file — and that throw reached
   `failureOfChown`, so every DVD would have reported landing with the wrong
   owner while the `chown` above it had in fact succeeded.

## Context

The DVD path was fixed twice on 2026-08-26 — the musl `mmgplsrv` loader, then
the pre-created destination — and the rips finally ran. Slot 6 reached
`MSG:5070 "Backup done"`.

rip-deck reported `empty_output`.

The output was there:

```
$ ls -la .rip-deck-incomplete-68fa9004-…
-rwx------ 1 root root 8203894784 Aug 26 23:08 .rip-deck-incomplete-68fa9004-…

$ file .rip-deck-incomplete-68fa9004-…
UDF filesystem data (version 1.5) 'TEENAGE_MUTANT_NINJA_TURTLE_V6'

$ mount -o loop,ro .rip-deck-incomplete-68fa9004-… /mnt/x && ls /mnt/x
AUDIO_TS  VIDEO_TS
```

A perfect 8.2 GB decrypted DVD image. `verifyBackupStructure` looked for a
`VIDEO_TS` **directory** inside a path that was not a directory at all, found
none, and called the rip empty.

## Why

Because the shape is a property of the DISC, not of the command, and rip-deck was
written against the only shape it had ever seen. Two real Blu-rays went through
`backup` before any DVD did, and the code — and its comments, and its tests —
encoded "a backup is a directory" as though it were a fact about MakeMKV.

⚠️ **This also explains `MSG:5068`, and the earlier record's guess was wrong.**
That record supposed MakeMKV's "already contains a backup" check was per-format.
It is not. For a DVD, MakeMKV wants to **create a file** at the destination path,
and a directory sitting there is simply in the way. The message is misleading —
the directory was empty — and it is why Blu-ray never hit it while every DVD did.
Not pre-creating remains the correct fix; the reason is now known rather than
supposed.

## Evidence

Live tower, 2026-08-26, five DVDs ripping at once through the deployed build:

- slot 6 → `MSG:5070 "Backup done"`, 8,203,894,784-byte file, `UDF filesystem
  data`, loop-mounts with an intact `VIDEO_TS`, reported `empty_output`
- the other four incomplete paths, mid-rip, were regular files of 3.1–8.2 GB —
  not directories

Guarded by `verifyBackup.test.ts` → *"a DVD backup, which is an ISO file"* (four
cases, including a signature-less file of the right size), and by
`destination.test.ts` → *"finalising a DVD, which is one ISO file"*.

## Consequences to watch

- **The library now contains both shapes.** `[BACKUP] X - Blu-ray` is a folder
  and `[BACKUP] X - DVD.iso` is a file, side by side. Anything that walks
  `/media/Disc-Rips` expecting directories — a future scanner, a future
  title-extraction stage — has to handle both.
- **`[BACKUP]` still applies to an ISO.** The image is a whole disc with titles
  still to be pulled out, which is exactly what the prefix marks.
- **An audio CD is a third shape** (a cyanrip directory of FLACs) and is
  untouched here; it never goes through `backup`.
- **The ISO9660 check reads one 5-byte window.** It is a shape check, not an
  integrity check — truncation is still caught by the size floor and the
  read-error count, exactly as it is for a directory.

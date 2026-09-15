# A data disc is imaged with ddrescue, and the image is judged by its mapfile — never by an ISO 9660 signature

Status: Accepted
Date: 2026-09-15
Type: Rip pipeline / disc-type fork
Supersedes: the deferral of requirement A4
Superseded by: —

## Decision

1. **A data CD-ROM is ripped, not refused.** The `media.family === "cd"` branch
   with zero audio tracks returns `{ ripper: "ddrescue" }` instead of
   `needs_attention` with reason `data_disc_deferred`. That reason is deleted;
   nothing else produced it.
2. **The tool is GNU ddrescue, never `dd`.** `dd conv=noerror,sync` replaces an
   unreadable sector with zeroes and exits 0, which is the silent-success class
   this whole repository exists to catch.
3. **The mapfile is mandatory and is the evidence.** `ddrescue` is always given
   a third positional argument. An image whose mapfile is missing, unreadable
   or holds no blocks is **refused** — it is not published on the strength of
   its length.
4. **⚠️ ISO 9660 is REPORTED, never REQUIRED.** An image with no `CD001`
   signature verifies exactly like one that has it. When the signature *is*
   present, the primary volume descriptor's own length is cross-checked and a
   shortfall is a **warning**.
5. **The exit code does not decide the outcome.** `verifyDiscImage` does. A
   non-zero exit on a complete image is a warning; a zero exit proves nothing.
6. **Three flags are banned**, each with a test asserting its absence: `-p`
   (preallocate), `-S` (sparse) and `-n` (no-scrape). Two more are simply not
   passed: `-d`/`-D` (direct I/O) and `-f` (overwrite a device).
7. **A data rip publishes a DIRECTORY**, `[DATA] <title>/`, holding
   `<title>.iso` and `<title>.iso.map`.
8. **A data disc with no name is held, not invented.** The name sources are the
   operator and udev's volume label. There is no third, because `makemkvcon`
   cannot read a data disc at all.
9. **Mixed-mode discs are unchanged and the gap is stated.** A disc carrying
   both audio tracks and a data session still goes to cyanrip whole, and the
   bay note now says the data half is not imaged.

## Context

Requirement A4 — data disc to ISO — was deferred when the disc-type fork was
built, because the two rippers in the image could not read a data disc and
writing a third had no disc behind it. The branch therefore ended at
`needs_attention` with the message *"Ripping data discs to ISO is not built yet
(A4), so there is no ripper for this."*

The requirement came back with a concrete disc in front of it: a stack of E-MU
sampler library CDs whose contents are needed as sound banks. Those discs are
the case that shaped every rule above.

## Why

**Why ddrescue rather than `dd`.** A sampler library disc is thirty years old.
The failure that matters is not a disc that will not read at all — that one is
obvious — it is a disc where forty sectors are gone. `dd conv=noerror,sync`
produces a full-length image with zeroes in those forty sectors and exits 0.
Nothing downstream can tell that image from a perfect one. ddrescue records
every unread sector in its mapfile, so "did I get all of it" has an exact
answer, and a later run can resume from that same file.

**Why the mapfile is mandatory.** Without it the outcome collapses back to the
exit code, which is the assumption this repository was built because of. An
image published with no mapfile carries an unanswerable question.

**Why ISO 9660 must never be required.** This is the rule most likely to be
"tidied up" later, because `verifyBackup.ts` sits next door doing the opposite
— it treats a file with no `CD001` at byte 32769 as proof that whatever ran did
not produce a disc image. That is correct for a DVD and wrong here. A large
family of data CD-ROMs carry no ISO 9660 filesystem at all: E-MU, Akai and
Ensoniq each wrote instrument banks in the sampler's own on-disc format,
because the sampler had no operating system to mount a filesystem with. Those
are precisely the discs somebody still needs imaged, and requiring the
signature would fail every one of them — with a message that reads as "the
drive could not read this disc" and sends a person to clean a disc that was
read perfectly.

**Why `-p` is banned specifically.** The outcome is decided partly by the
image's length. A preallocated file is full-length from its first second, so a
rip that died after 4 MB would verify as a complete disc. The same fact is why
progress is measured from the file's length and why the progress bar stops
climbing before the rip ends.

**Why `.iso` even with no ISO 9660 filesystem.** It is wrong as a description
and right as an extension: every loop-mounter, emulator and Windows expects it
on a raw optical image, and an image with no extension cannot be opened by
double-clicking. `.bin` — the purist's alternative — is worse than imprecise.
It means 2352-byte raw sectors with a `.cue` beside them, and this is 2048-byte
user data with no cue sheet. The `[DATA]` folder prefix and the mapfile carry
the truth the extension cannot.

**Why a nameless data disc is held.** B3 forbids inventing a name, and this
path has no `identifyDisc` fallback. It is not a rare branch either: a disc
with no ISO 9660 filesystem has no volume label for udev to read, so a sampler
disc always wants a name typed on its card.

**Why the mixed-mode gap is named rather than closed.** Ripping one disc with
two tools in sequence is a larger change than this one. Leaving it silent is
how a person discovers months later that a disc's data half was never imaged.

## Evidence

- **The binary, not the documentation.** Every flag was read out of
  `ddrescue --help` from the package this image installs — GNU ddrescue 1.29-1,
  Debian trixie, run 2026-09-15.
- **⚠️ The package is `gddrescue` and the binary is `ddrescue`.** `apt-cache
  policy` on trixie lists no package called `ddrescue` at all, so
  `apt-get install ddrescue` fails the image build outright.
- **Provenance (workspace J6).** GNU ddrescue is by Antonio Diaz Diaz (Spain),
  part of the GNU project, GPLv2+; its own `--version` prints
  `Copyright (C) 2025 Antonio Diaz Diaz`. It has no dependencies beyond libc
  and libstdc++, so there is no chain to audit past it.
- **Both mapfile fixtures in `ddrescueCommand.test.ts` are real output**,
  captured 2026-09-15 by running the invocation `buildDdrescueArgs` produces,
  unaltered, against a 5,000,000-byte input: one complete run (exit 0, image
  size equal to the input) and one interrupted after three seconds.
- **The interrupted fixture holds a trap shut.** Its status line is
  `0x00060000     ?               1` — the second field is a real status
  character and the third is a pass number. A parser keying on the second
  column would count that line as a 5 MB block of nothing and report a rip that
  recovered 393,216 bytes as having recovered none. The parser keys on the
  third field for that reason.
- Suite after the change: 1735 tests, 101 files, all passing.
- ⚠️ **Nothing on this path has met a real disc yet**, exactly as the cyanrip
  path stood when it was written. The first real data CD should be expected to
  correct some of it.

## The owner's words

> "Does Rip Deck handle data CDs? I need those for the Raspberry Pi MIDI
> Controller project."

Asked and answered on 2026-09-15: it did not, and now it does.

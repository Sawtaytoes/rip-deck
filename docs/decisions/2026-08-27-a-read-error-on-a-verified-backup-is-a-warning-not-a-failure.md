# A read error on a verified backup is a WARNING, not a failure — and the CSS handshake probe is not a read error at all

Status: Accepted
Date: 2026-08-27
Type: Rip outcome / verdict model
Supersedes: —
Superseded by: `2026-08-29-a-failed-backup-carries-no-completed-copy-warning.md` (failed-run warning clause only)

## Decision

A finished rip has **three** outcomes, not two.

1. **A pre-backup CSS probe error is not a read error.** `MSG:2003` carrying
   `READ OF SCRAMBLED SECTOR WITHOUT AUTHENTICATION`, raised **before**
   `MSG:5072` ("Backing up disc into folder …"), is dropped. It is counted
   separately as `cssProbeErrorCount` and never reaches the verdict.
   **Both** halves of the test must hold — the position and the sense. See
   "Why the discriminator is both" below.
2. **A genuine read error on a backup that verified is a warning.** Exit 0,
   plus a verified disc structure or ISO of plausible size, plus no
   `MSG:5069`/`MSG:5080`, is a **success** — with a `RipWarning` attached that
   names the count and the offsets. `isRipSuccessful` no longer opens
   `if (readErrorCount !== 0) return false`.
3. **The warning states what MakeMKV does NOT say.** Robot mode carries no
   retry, recovery, re-read or zero-fill message, so the sentence says so in
   plain words instead of implying either answer.
4. **The three states reach the UI as their own colour.** `BayOutcomeKind`
   gains `completed_with_warnings`; the job state stays `completed`; the rail
   chip reads `warning` in amber on the calm raised surface — distinct from
   the finished green, from the failed red, and from a HELD bay's filled
   amber.
5. **`MSG:5069` / `MSG:5080` "Backup failed" are now read.** With the
   read-error gate gone, this is the message half of the failure test, and
   `isRipSuccessful`'s `hasFailureMessage` input had no producer at all until
   now.
6. **A failed structural check reports the reason it already wrote.**
   `verifyBackupStructure` computes a plain-language sentence and `ripJob`
   was throwing it away.

## Context

Slot 1 of the live tower, 2026-08-27. The MakeMKV capture ends:

```
MSG:5070,128,0,"Backup done","Backup done"
MSG:5081,260,0,"Backup done.","Backup done."
```

The ISO is on the dataset at 8,070,922,240 bytes. Rip Deck recorded `fail`,
reason `read_errors`, and the daemon printed:

```
[slot 1 · 01 - ASUS BW-16D1HT] held on startup — read_errors (makemkvcon
exited 0 — the silent-success case ARM reports as a completed rip)
```

The entire evidence for that verdict was **one** `MSG:2003`, at offset
1 MB, 28 lines into a 51,811-line capture and **before** the backup had
started:

```
MSG:2003,0,3,"Error 'Scsi error - ILLEGAL REQUEST:READ OF SCRAMBLED SECTOR
WITHOUT AUTHENTICATION' occurred while reading 'BD-RE ASUS BW-16D1HT 3.02
EXAMPLE00001' at offset '1048576'", …

(The drive's firmware serial is redacted here and in the fixture, the same
way the Blu-ray capture beside it already is.)
```

That is MakeMKV probing a CSS-protected DVD before `mmgplsrv` supplies the
title key. The probe is *supposed* to fail — the drive is answering "this
sector is scrambled, you are not authenticated yet", which is how MakeMKV
learns the disc is protected. Every CSS DVD produces one.

The owner, on what should happen when the error is real:

> *"This should be a warning. It didn't fail because it made the ISO, but the
> ISO is problematic, so I'd like to know that."*

And on what he wants to know beyond the count:

> *"I'd like to know if there are read errors, but I'd also wanna know if
> MakeMKV was able to work around it or fix it. It has that capability
> sometimes."*

## Why

### Two states could not describe this rip

`fail` says "there is no backup". That was false: the ISO mounts and plays.
`pass` says "nothing to see here". That is also false when a sector genuinely
would not read. The rip needed a third word, and the absence of one is why a
perfect DVD wore a red badge.

This is **not** a retreat to ARM's #1298. ARM reports a rip with read errors
as a plain success and says nothing further; that is the bug this project was
built to fix. The rule survives with one word changed: *never report a rip
that had read errors **without saying so**.* Rip Deck names the count and the
offsets, on the card, on the chip, in its own colour, and in the retained MQTT
payload.

### Why the discriminator is both position and text

Position alone — "before `MSG:5072`" — is the robust half. A read error that
arrives before the copy has started cannot be a defect in the copy. It is also
locale-proof, which text matching is not: MakeMKV renders the message *and*
the `format` field in the selected language.

Text alone is the specific half. It names the one SCSI sense this artefact
carries, so a genuinely unreadable disc that fails during MakeMKV's structure
read is not waved through.

Requiring both is conservative in the direction that matters. A
scrambled-sector error **mid-disc** still counts (the position test fails it),
and a pre-backup error with **any other sense** still counts (the text test
fails it). Only the exact known-benign combination is dropped, and it is
recorded rather than silently discarded — "we saw one and ignored it" and
"there were none" are different facts.

### ⚠️ Robot mode cannot tell you whether MakeMKV recovered

This was researched before the warning text was written, and the answer is no.

The message catalogue compiled into the `libmakemkv.so.1` this repo's image
ships (MakeMKV 1.18.4) was read end to end for any retry, recovery, re-read or
zero-fill message. **There is none.** `MSG:2003` is emitted once per failed
read, and nothing afterwards refers back to it. The only aggregate is
`"Encountered %1 errors of type '%2' - see %3"`, which counts them again
rather than resolving them.

So the warning **states the gap**:

> *"MakeMKV does not report whether it re-read those sectors successfully or
> wrote them off, and robot mode has no message that would say — so Rip Deck
> cannot tell you which. Play the disc through before you throw the original
> away."*

Inferring "recovered" from "the backup finished anyway" would be the
confidently-wrong reading the whole verdict model exists to prevent: a backup
finishes whether MakeMKV re-read the sector or wrote zeros over it.

There **is** one real integrity signal, and it is separate. `MSG:5085` means
MakeMKV loaded the disc's own content hash table and is verifying the copy
against it. When that happened and no hash failure followed, the warning says
so — that is MakeMKV's own check passing, not an inference of ours. It is
**Blu-ray only**: a DVD carries no hash table, so on a DVD the honest answer
stays "cannot tell".

Its failure counterpart is matched by **text**, not by code, and that is not a
lapse of the code-over-string rule — it is the only handle that exists. No rip
in this repo's corpus has ever failed a hash check, so no capture carries the
code. The strings are read out of the shipped binary:

```
"Backup done but %1 files failed hash check"
"Backup done but %1 files failed hash check."
"Hash check failed for file %1 at offset %2, file is corrupt."
"Too many hash check errors in file %1."
```

The pair-of-forms shape ("…" and "….") is 5070/5081 and 5069/5080 again, so
these are two more codes MakeMKV has not shown us yet. **Replace the text
match with the codes the first time a capture carries one.**

### Why `MSG:5069` / `MSG:5080` had to be wired at the same time

`isRipSuccessful` has declared a `hasFailureMessage` input since it was
written, and **nothing ever set it.** Four TMNT DVDs emitted the pair on
2026-08-26 and exited 0; the only thing that failed them was the structural
check. With the read-error gate removed, the message is the second half of the
failure test and could not be left unread.

### Why `empty_output` alone is not an acceptable failure reason

`verifyBackupStructure` already writes a plain-language sentence for every way
it can say no — "nothing was written at the destination at all", "the output
is a file with no ISO9660 signature in it", "only 3.9 GB landed for a 7.5 GB
disc". `ripJob` computed it and threw it away, so all three arrived at the
owner as the single word `empty_output`. They want three different actions,
and the bare word cost a full investigation on 2026-08-27 before anybody could
say which had happened. The sentence now travels with the failure.

## Evidence

- Slot 1's capture, 2026-08-27: one `MSG:2003` at offset 1048576, before
  `MSG:5072`; `MSG:5070` + `MSG:5081` at the end; 8,070,922,240-byte ISO on
  the dataset; recorded outcome `fail` / `read_errors`. A trimmed copy is the
  fixture `packages/daemon/src/makemkv/__fixtures__/real-dvd-backup-css-probe.robot.log`
  and `rip/cssProbeCapture.test.ts` replays it.
- The owner's two quotes above.
- `MSG:5069` and `MSG:5080` counts across this repo's whole capture corpus:
  five of each, all on runs that exited 0.
- MakeMKV 1.18.4's own message catalogue, read out of
  `/opt/makemkv/lib/libmakemkv.so.1` in this repo's image: no retry or
  recovery message; the four hash-check strings quoted above.
- One `MSG:2003` in the entire corpus before this change — the CSS probe.
  Nothing in this repo had ever seen a genuine read error, which is why the
  hard gate survived so long.

## What this does NOT change

- A rip that produced **no verified output** is still a failure, read errors
  or not.
- A non-zero exit is still a failure.
- `mkv` mode still needs a non-zero title count.
- A **failed** bay's chip stays red and its read-error count stays red — the
  2026-08-26 chip decision is untouched. The amber applies to a rip that
  produced a backup.

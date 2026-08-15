# Identify retries until the disc is READ, not until a drive answers

Status: Accepted
Date: 2026-07-30
Type: code / reliability
Refines: `docs/decisions/2026-07-28-single-shot-identify-latched-a-flapping-bus.md`

## Decision

`identifyDisc`'s retry gate changes from **`didDeviceRespond`** ("did a drive
answer this `info` call") to **`wasDiscRead`** ("did makemkvcon actually open and
read the disc"). A read is now FINAL — returned as-is, not retried — only when it
found a name, hit a spawn fault, or **emitted a `CINFO` block** (proof the disc
was opened). A read that lists the drive but produces no `CINFO` is treated as a
transient and retried, up to `IDENTIFY_TUNING.maxAttempts` (3, 1.5 s apart).

Everything else the 2026-07-28 decision established stands: the retry bound, the
per-attempt timeout, spawn-fault and genuinely-blank-label staying one-shot, and
running only on the dispatch pipeline so a long identify freezes no other bay.

## Context

The 2026-07-28 retry closed the "no drive answered at all" transient — a
re-enumerating bus returning an empty event stream. Its discriminator,
`didDeviceRespond`, read a **populated DRV line** as "a drive answered → a blank
disc → don't retry." That is wrong for one real case, hit live on 2026-07-30:

A **UHD disc in slot 9 ("SOYLENT GREEN - UHD")** was inserted while the bus was
still enumerating (`6 → 9 drives` in the same window). MakeMKV lists a drive the
instant it enumerates, but a UHD disc must clear LibreDrive + BD+ decrypt and
load its content-hash table before any `CINFO` appears — and on the tower's long
USB run that trailed the DRV line by seconds. So the first identify saw the DRV
line, no `CINFO`, no name → `didDeviceRespond` called it a genuinely blank label,
returned one-shot, and the disc **latched `needs_attention` "could not read a
name"** and sat unread. A scoped `makemkvcon info` seconds later returned
`CINFO:2,0,"SOYLENT GREEN - UHD"` cleanly, and the disc ripped fine by hand.

The bug is the same *shape* as the one 2026-07-28 fixed — a transient mistaken for
a terminal state — but its discriminator caught only the empty-stream variant,
not the drive-listed-but-disc-not-open variant.

## Why

The signal that actually separates "this disc has no name" from "this disc was
not open when we looked" is **whether the disc was read at all**, and a DRV line
does not carry that: it proves a *drive* is present, not that its *disc* was
opened. `CINFO` does — MakeMKV emits the disc-info block (type, name, language, …)
only after opening the disc. So:

- **CINFO present, name blank** → the disc was read and is genuinely nameless.
  Deterministic; `--name` is the fix, not a retry. FINAL.
- **No CINFO** → the disc was never opened this instant (empty stream *or* a disc
  still decrypting behind its DRV line). Transient. RETRY.

This folds both transients into one retryable class, which is correct, and
preserves fail-closed: a disc that never yields a `CINFO` after `maxAttempts`
still lands `needs_attention` — just a few seconds later instead of never. No
false success is possible, because the name still comes only from a real
`CINFO:2` / DRV disc-name field via `extractDiscName`.

## Evidence

- Live, 2026-07-30: slot 9 `needs_attention` "could not read a name off this
  disc"; `active_count: 0` with one disc inserted read as "the tower isn't
  ripping." Scoped `makemkvcon -r --cache=1 info dev:/dev/sr0 --noscan` returned
  `MSG:1011 Using LibreDrive mode`, full title enumeration, and
  `CINFO:2,0,"SOYLENT GREEN - UHD"`. Ripped to completion via
  `rip-deck rip --slot 9 --name "SOYLENT GREEN - UHD"`.
- `packages/daemon/src/rip/identifyDisc.ts`: `wasDiscRead` replaces
  `didDeviceRespond` in `isFinalIdentification`; `identifyDisc.test.ts` adds the
  UHD regression ("re-reads a drive that answered before its disc had opened")
  and repoints the blank-label case onto a `CINFO` block. Full suite 1195 green,
  typecheck/biome/eslint clean.

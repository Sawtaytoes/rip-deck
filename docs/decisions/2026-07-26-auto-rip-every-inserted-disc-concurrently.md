# Auto-rip every inserted disc, concurrently, routed by disc type

Status: Accepted
Date: 2026-07-26
Type: product scope / concurrency
Supersedes: the "**`rip-deck` is still bound to one slot in code, and that
stays**" clause of
[ARM stays disabled — `rip-deck` is the ripper now](2026-07-26-arm-stays-disabled.md)

## Decision

**Insert a disc, get a rip. Insert nine, get nine.** `rip-deck` detects media
insertion and starts a rip per disc, up to all nine bays at once, with no manual
`rip-deck rip --slot N`.

The rip is **routed by disc type**:

| Disc type | Tool | Mode |
| --- | --- | --- |
| Audio CD | **cyanrip** | FLAC, AccurateRip v1+v2 (plan A3) |
| DVD / BD / UHD BD | **makemkvcon** | `backup --decrypt` — never a transcode (A2) |

This restores what ARM used to do and drops the one-slot refusal in
`packages/daemon/src/cli.ts`, whose stated justification ("Stage 3 is bound to a
single slot so ARM keeps the other eight") had already been made obsolete by
ARM's retirement.

**Per-rip device isolation is a prerequisite, not a nicety.** See Why.

## Context

The superseded decision closed with a predicted consequence: *"Discs arriving in
the mail now have no automatic path… If the owner puts a disc in a bay expecting
it to rip, nothing happens. This is the most likely way this decision bites."*
It bit, and the owner has now settled it directly.

Asked whether to close the auto-rip gap, the owner chose to build it and added
the concurrency requirement unprompted, along with the tool routing — which
turned out to match `docs/plan.md` A3 (**cyanrip, not abcde**) already on file.

## Why

- **The one-slot limit had outlived its stated reason twice over.** It was
  originally about protecting ARM's eight drives; ARM is retired. It was then
  re-justified as caution about unproven concurrency — a real concern, but the
  owner is the one who carries that risk and has weighed it.
- **The child-per-drive architecture was designed for exactly this.** Nine
  independent child processes is the model the codebase already has; one wedged
  drive cannot freeze its siblings' monitoring because device I/O never runs in
  the parent. The owner's reasoning — *"since we're loading them all as separate
  child processes, we should be super safe"* — is the architecture's own premise.
- **But process isolation is not bus isolation, and this is the caveat that
  matters.** `makemkvcon backup` **ignores `--noscan`** and re-enumerates the
  whole USB bus before every rip, because a `disc:` source is *defined* in terms
  of that enumeration
  ([decision](2026-07-25-backup-takes-a-disc-index-and-scans-the-bus.md)). Nine
  concurrent rips therefore mean nine full bus scans, and a wedged sibling can
  still delay the *start* of an unrelated rip. Crash isolation is safe today;
  **start-up isolation is not.**
- **Per-rip device isolation closes that gap**, and is the reason it is a
  prerequisite rather than a follow-up: give each rip a container that sees only
  its own `/dev/srN`, and the forced scan finds exactly one drive, the disc index
  is always `disc:0`, and a wedged sibling becomes structurally invisible instead
  of merely deprioritised.

## What does NOT change

- **Fail closed on ambiguity.** An unidentified disc stays in the drive and is
  marked needs-attention. Auto-rip does not license inventing a name.
- **Never eject-loop.** Auto-rip must not become an insert/eject flap-storm —
  that is the root cause that killed valid rips in other bays.
- **Never report success on a rip that had read errors** (D1), and **never
  transcode** (A2). Nine rips do not dilute either rule.
- **Failed rips keep their partial output** (D4).
- **Zero drives present is a valid normal state** (F3) — the tower is powered
  independently, so an empty bus is not a fault to alarm on.

## Evidence

Owner, 2026-07-26, asked whether to close the auto-rip gap: **"Yes - build
auto-rip. But also, I want it to rip as many discs as I insert. If I insert 9
discs, start 9 rips of the correct type. CD uses cyanrip, and DVD/BD/UHD BD uses
MakeMKV Backup mode. Right? Nothing different from before. And since we're
loading them all as separate child processes, we should be super safe."**

The tool routing was verified against `docs/plan.md` A3 rather than taken on
recall alone: cyanrip was already the chosen audio-CD tool, explicitly *"not
abcde"*.

## Consequences to watch

- **Fault injection is still owed and is now more load-bearing, not less.** No
  cable has ever been pulled from under a running `rip-deck` rip, and the
  cancel/orphan path (E5) has never been exercised — both rips ran to completion.
  Nine concurrent rips is the configuration where a wedged drive costs the most.
- **Nine concurrent rips is nine `--cache=128` allocations** on a host that is
  also a NAS (E4). Bounded, but no longer a rounding error.
- **Every `HEALTH_THRESHOLDS` value is still invented**, and nine simultaneous
  jobs is the fastest way to accumulate the ~30 real jobs needed to tune them —
  provided the sampler loop is actually feeding the health engine, which it does
  not do yet.
- **cyanrip has never run on this rig.** The audio-CD path has zero real rips
  behind it, where the MakeMKV path has two.

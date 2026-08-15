# ARM stays disabled — `rip-deck` is the ripper now

Status: Accepted, partially superseded
Date: 2026-07-26
Type: operations / project scope
Superseded by: [Auto-rip every inserted disc, concurrently, routed by disc
type](2026-07-26-auto-rip-every-inserted-disc-concurrently.md) — **only** the
one-slot clause below; and [ARM is deleted, not just
disabled](2026-07-27-arm-is-deleted-not-just-disabled.md) — **only** the "the
ARM *viewer* keeps running" clause. Everything else here still stands.
Amends: the "ARM must keep ripping" hard constraint in `AGENTS.md` and
`docs/plan.md`'s sequencing, which retired ARM only after a 9-drive
fault-injection run

## Decision

**The `automatic-ripping-machine` app stays off.** It is not re-enabled while
`rip-deck` matures, and `rip-deck` is now the tower's ripper.

What this does and does not change:

- **The "ARM must keep ripping" rule is retired.** It was the reason Stages 0–2
  were read-only by construction and the reason Stage 3 was bound to a single
  slot. That constraint no longer applies.
- **`rip-deck` is still bound to one slot in code, and that stays** until the
  Stage 6 work is done. The multi-slot refusal is no longer about protecting
  ARM's eight drives — it is about not running nine concurrent rips through a
  loop that has completed exactly two, has never had a cable pulled from under
  it, and whose isolation guarantee is weaker than originally written
  ([decision](2026-07-25-backup-takes-a-disc-index-and-scans-the-bus.md)).
- **The ARM *viewer* keeps running.** It is a separate app and is still the only
  UI that exists; `packages/web` is empty.
- Fault injection and the 9-drive bake-off are still owed. They are no longer a
  gate on ARM's retirement — they are a gate on trusting `rip-deck` with the
  whole tower unattended.

## Context

The owner disabled the app on 2026-07-25 to stop it auto-ripping while
`rip-deck`'s first real rip was tested, saying *"We don't even need the container
running at all. I'd like to see how ours does."*

That removed a fact the project had been built around, so it was put back to the
owner explicitly rather than assumed: nine drives were suddenly free, but no
9-drive `rip-deck` run had ever happened. Asked whether ARM should be left
disabled, the owner answered **"Yes."**

`rip-deck` had by then ripped a real Blu-ray twice, unattended, from its own
container: `Ivanhoe (1952)`, 24m29s, ~21 MB/s, exit 0, zero read errors — and
the two independent rips were verified **byte-identical**, all 78 files,
34,535,584,646 bytes each.

## Why

- **The original constraint was about risk to a working service.** With the
  service deliberately off at the owner's instruction, keeping the rule would be
  cargo-culting its wording rather than honouring its intent.
- **The byte-identical repeat is the strongest evidence available** that the rip
  loop is deterministic and correct on a healthy disc. It is not evidence about
  unhealthy discs, wedged drives, or concurrency — hence the slot limit staying.
- **Retiring ARM as the ripper and trusting `rip-deck` with nine drives are two
  different decisions.** Conflating them is how a project skips its own
  verification protocol.

## Evidence

Owner, 2026-07-26, asked directly whether ARM should be left disabled: **"Yes."**

Earlier the same session: *"I turned on the optical ripper tower and disabled
automatic-ripping-machine to stop it from auto-ripping. We don't even need the
container running at all."*

## Consequences to watch

- **Discs arriving in the mail now have no automatic path.** `rip-deck rip` is
  manual, one slot at a time, and there is no udev rule. If the owner puts a
  disc in a bay expecting it to rip, nothing happens. This is the most likely
  way this decision bites.
  - **This happened, and is now resolved.** Later the same day the owner asked
    for auto-rip with full nine-drive concurrency:
    [decision](2026-07-26-auto-rip-every-inserted-disc-concurrently.md).
- Nothing reaps `.rip-deck-incomplete-*` directories yet.
- ARM's MakeMKV key is no longer the one in use — `rip-deck` has its own copy
  ([decision](2026-07-25-rip-deck-ships-its-own-makemkv.md)).

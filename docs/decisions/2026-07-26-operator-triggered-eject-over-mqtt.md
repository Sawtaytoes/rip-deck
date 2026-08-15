# An operator may eject; rip-deck still never eject-loops

Status: Accepted
Date: 2026-07-26
Type: capability / safety boundary
Corrects: the claim *"rip-deck never ejects"* as it appears in
[`2026-07-26-tower-power-off-triggers-on-idle-not-on-closed-trays.md`](2026-07-26-tower-power-off-triggers-on-idle-not-on-closed-trays.md)
(that decision's own conclusion is unchanged and still correct)

## Decision

`rip-deck` exposes tray commands on the MQTT command topics that
`../mqtt.md` already reserved:

| Topic | Payload | Meaning |
| --- | --- | --- |
| `<base>/cmd/drive` | `open_completed` | Open every bay that is latched terminal and not ripping |
| `<base>/cmd/drive` | `close_open` | Close every present bay with no disc in it |
| `<base>/cmd/drive` | `{"command":"open_bay","slot":7}` | Open one named bay |
| `<base>/cmd/drive` | `{"command":"close_bay","slot":7}` | Close one named bay |
| `<base>/resp/drive` | per-bay report + one spoken sentence | What happened, always |

**No decision inside `rip-deck` moves a tray.** Not the poll loop, not an
outcome, not a give-up path. The only caller of `rip/tray.ts` is the MQTT
command surface, i.e. a human pressing something.

**A bay in `starting` or `ripping` is REFUSED**, loudly — counted, named in the
spoken message, and written to the daemon log — never quietly skipped. This
holds for the single-bay commands too.

## Context

This repo stated flatly, in three documents and one UI, that **rip-deck never
ejects**. `packages/web` dropped the ARM viewer's eject/close control during the
port on that basis, and it was relayed to the owner as settled fact.

The recorded rule is narrower. From
[`2026-07-26-auto-rip-every-inserted-disc-concurrently.md`](2026-07-26-auto-rip-every-inserted-disc-concurrently.md),
§"What does NOT change":

> **Never eject-loop.** Auto-rip must not become an insert/eject flap-storm —
> that is the root cause that killed valid rips in other bays.

That is a ban on rip-deck ejecting **as part of the rip cycle**. It is not a
statement that rip-deck may never expose an eject action, and the owner never
asked for one:

> *"I don't know what the heck you're talking about. It's like you're making up
> stuff for Rip Deck that never existed. We were making something to replace ARM.
> I was wanting it to auto-eject after ripping."* — owner, 2026-07-26

He has since dropped auto-eject-after-ripping, and asked instead for a Zigbee
button: hold up opens every completed drive, hold down closes every open drive,
two presses with a human removing discs in between.

## Why

**An operator command is not a loop.** The flap-storm the rule bans is a
feedback cycle: eject makes the bay read empty, empty re-arms it, the disc goes
back in, the rip starts again. Here nothing re-inserts. Two separate presses
with a human in between cannot oscillate, and the owner said so first: *"Eject
as one press, re-insert as another. After I've removed the discs, it won't
re-rip."*

**A disc locked in a drive with no way out is a worse failure than a tray that
opens.** Without this, the only way to get a `needs_attention` disc out of a bay
is physically, or by restarting the daemon. That is not a defensible resting
state for a nine-bay rack.

**The mid-rip refusal is the whole safety argument, and it is structural.** It is
the first branch of `decideTrayBayAction`, before any command-specific rule, so
there is no command — bulk or targeted — that can reach a drive a rip owns. It is
tested for every command kind against both `starting` and `ripping`.

**`eject`, not an ioctl.** `CDROMEJECT` (0x5309) and `CDROMCLOSETRAY` (0x5319)
are the real mechanism, and Node cannot issue either: there is no `ioctl` in
core, so "directly" means a native addon. Even if it could, an ioctl in the
watcher's own process is the synchronous device call `AGENTS.md` forbids — a
drive wedged in SCSI error recovery blocks it for up to 600 s and freezes all
nine bays plus the API. A spawned child is off the event loop, killable, and
takes its watchdog for free. **The `Dockerfile` change that installs `eject` is a
deployment artefact: until the image is rebuilt, every tray command reports
"this rip-deck image has no `eject` binary".**

## Open, and left open deliberately

- **Whether `open_completed` should include unripped discs.** It currently opens
  every latched bay — `completed`, `failed`, `needs_attention`, `quarantined` —
  and reports the unripped ones as `opened_not_ripped` in their own count and in
  the spoken sentence. The owner said "every completed rip drive" and has not
  been asked about the rest. `isBulkOpenEligible` is the one function to change.
- **Short presses on the RODRET are unassigned.** Tower on/off is the obvious
  home and the owner has not said so. Nothing is wired.

## Evidence

Owner, 2026-07-26, on the button: hold ▲ = *"open every completed rip drive"*,
hold ▼ = *"close every open drive"*, auto-reinsert = *"No."*
(`../HANDOFF-eject-and-open-questions.md` §1b, which records these as settled.)

`AGENTS.md` hard constraint, quoted in full because the narrow half is the part
that binds: *"Fail closed on ambiguity. An unidentified disc stays in the drive
and is marked needs-attention. **Never eject-loop** — that is the root cause of
the flap-storm that killed valid rips on other drives."*

Design detail: `../eject-and-durable-bay-state.md`.

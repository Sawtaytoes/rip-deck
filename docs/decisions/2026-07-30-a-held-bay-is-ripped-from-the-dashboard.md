# A held bay is ripped from the dashboard, not from a shell

Status: Accepted
Date: 2026-07-30
Type: code / UX

## Decision

A held bay's card carries **a name box and one button**, backed by a new
`rip_bay` command on the existing operator surface (`cmd/drive` +
`POST /api/tray`). The button's label says which of two things it is about to do:

- **box empty → "Try again"** — re-read the disc's own name and rip.
- **anything typed → "Rip as this"** — rip under that name, skipping identify.

`rip_bay` overrules the three guards that hold a bay — the terminal latch, the
disc fingerprint and the start counter. It does **not** overrule the refusal: a
`starting`/`ripping` bay is refused by `decideTrayBayAction`'s first branch,
exactly as it is for ⏏, and the governor's `tryAcquire` still has the last word.
A press that cannot get a slot is **refused out loud**, never queued.

Two smaller corrections ride along, both of them wrong text that had been printed
for a while:

- The identify hold no longer says *"rip it by hand with `rip-deck rip --slot N
  --name "…"`"*. It says **"Type its name on this card and press Rip."**
- `UNKNOWN_AT_STARTUP_DETAIL` no longer says *"open the tray and close it again,
  and it will be ripped."* **That never worked on this hardware** (see below).

## Context

The owner, looking at slot 9 on the live dashboard 2026-07-30:

> *"It's waiting on me, but what am I supposed to do? Is there an input to fix
> the name? I don't have a way to do anything actionable other than eject.
> Horrible user experience."*

Three things were true at once, and each made the others worse:

1. **The card's instruction was a CLI command the dashboard cannot run.** It
   printed `rip-deck rip --slot N --name "…"` — with backticks — to an operator
   holding a tablet.
2. **Its only control does not un-hold on this rig.** ⏏ opens the tray, but the
   Tower drives **keep reporting the disc**
   ([decision](2026-07-27-tray-memory-beats-disc-presence.md)), so the bay never
   reads empty, `rearmEmptyObservations` never fires, and nothing re-arms.
   Verified live 2026-07-30: open slot 9, wait 20 s, `disc_size_sectors`
   unchanged, still `needs_attention`. The one working un-hold was **physically
   pulling the disc out**.
3. **The disc was usually rippable anyway.** The one that produced this
   complaint had a perfectly readable label — `CINFO:2 "SOYLENT GREEN - UHD"`.
   Its hold was a transient identify race, since fixed
   ([decision](2026-07-30-identify-retries-until-the-disc-is-read-not-until-a-drive-answers.md)).
   So the operator was told to hand-type a name the drive can read on its own.

The tempting non-fix — *"just run `rip-deck rip --slot 9` for him"* — is worse
than doing nothing, and this was tried and reverted in the session before this
one. That CLI path is out-of-band from `watch`: it moves bytes but publishes
**nothing** — no dashboard tile, no MQTT, no verdict — and while it runs the
daemon believes the bay is merely `held`, so a bulk Open would try to eject a
ripping drive.

## Why

**Because the guards that hold a bay are guards on the POLL LOOP, and a person
pressing Rip is not the poll loop.** The latch, the fingerprint and the start
counter all exist to stop rip-deck re-ripping a disc *nobody asked about* — a
duplicate 90 GB backup costs hours. A human pressing a button on a card that
says "held" *is* the ask. Refusing him on those grounds is how a safety rule
becomes a capability ban, which is a mistake this project has now made four times
(`docs/HANDOFF-stage7-ui-and-naming.md` §2).

**Because an operator-supplied name is not an invented name.** Requirement B3
forbids *rip-deck* inventing a name when it could not read one, because an
invented name buries the one fact that makes the disc findable again. It has
never forbidden a human supplying one — that is precisely what `rip-deck rip
--name` has always done. This is the same act through a text box instead of a
shell. With no name the daemon still identifies, and a disc it cannot name is
still held.

**Because it rides the existing command surface rather than opening a second
one.** `rip_bay` is not a tray command, and it lives beside them anyway: it needs
every rule that file already enforces, and a second command path to a drive is
how a drive gets two writers. One parser, one refusal, one report shape, and
`POST /api/tray` and `cmd/drive` both got it for free.

**One box and one button, not two buttons.** "Rip with this name" beside "Try
again" would leave the operator choosing between two controls that look alike —
on the card whose entire defect was not knowing what to do. The box's contents
already say which he means, so the label follows the box.

**It closes the tray first when rip-deck opened it.** `lastTrayCommand` is the
only tray knowledge there is, and a held bay has usually been opened by someone
trying to un-hold it. On this rig an open tray still reports its disc, so nothing
upstream can tell — and `makemkvcon` reading an open tray fails in a way that
looks like a bad disc. The three-layer settle at the top of `runBayRip` covers
the spin-up.

## Evidence

Owner, 2026-07-30 (`docs/held-disc-ux-and-spoken-message-gaps.md`):

> *"It's waiting on me, but what am I supposed to do? Is there an input to fix
> the name? I don't have a way to do anything actionable other than eject.
> Horrible user experience."*

Measured on the live tower, 2026-07-30: slot 9 opened, 20 s later
`disc_size_sectors` unchanged and the bay still `needs_attention` — the tray
cycle un-holds nothing here.

1232 tests green (21 new). The load-bearing ones:

- `trayCommand.test.ts` — `rip_bay` is added to the *"⚠️ REFUSES a bay that is
  ripping, every command kind"* loop, which is the assertion this whole surface
  is judged on. Plus: a blank or whitespace `name` parses as **no name**, never a
  disc called `""`; a name is trimmed; a rip with no bay named is refused; the
  bare word is not a command.
- `watcher.test.ts` — the refusal again end-to-end (one rip, not two); the name
  reaches the ripper so identify is skipped; Try-again passes `null`; an open
  tray is closed first and a tray that will not close **fails without taking a
  lease**; the governor refuses a press when every slot is busy and leaves the
  bay unclaimed; an empty bay says there is nothing to rip.
- `HeldBayCard.test.tsx` — the button posts `rip_bay`; whitespace never travels
  as a name; the box prefills from the disc's own label; a started rip is not
  rendered as trouble.
- Exercised in the browser against `?fake=held-at-startup`: type a name, press,
  and the card answers `ripping as "Soylent Green - UHD"`.

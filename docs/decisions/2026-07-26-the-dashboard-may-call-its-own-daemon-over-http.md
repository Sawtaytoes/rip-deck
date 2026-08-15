# Rip Deck's own dashboard may call Rip Deck's own daemon over HTTP

- **Status:** Accepted
- **Date:** 2026-07-26
- **Type:** correction / architecture
- **Supersedes:** the blanket reading of "no REST" in `api/router.ts` and `packages/web/README.md`
- **Superseded by:** —

## Decision
The Rip Deck web dashboard **may call the Rip Deck daemon's own HTTP API to move a
tray**, including a write endpoint. `httpDataSource.runBayAction` must stop
refusing locally and must not tell the owner to publish MQTT by hand.

The workspace rule *"services talk to each other over MQTT — not new REST/shell
bridges"* **still stands** and is unchanged. It governs **service-to-service**
integration: no bespoke HTTP bridge so Home Assistant, or any other service, can
poke Rip Deck. `cmd/drive` / `resp/drive` remain the integration surface and the
physical button keeps using them.

A first-party UI talking to its own backend, on the same origin and the same
port that already serves `/json`, **is not two services**. No new bridge exists
and nothing else in the house gains a dependency.

The refusal logic stays in the daemon: `decideTrayBayAction` refuses a
`starting`/`ripping` bay as its first branch, and the HTTP path must go
*through* it, never around it.

## Context
Stage 6 shipped a working dashboard with a per-bay "Open tray" button. Pressing
it produced a red error box reading *"open tray failed: No REST endpoint for
this, by design — tray commands go over MQTT. Publish
`{"command":"open_bay","drive_id":"2-1.1.2.3"}` to `<base>/cmd/drive`…"*

The unit that wrote it was following the rule as previously written down, and
was explicitly told the refusal was correct. The rule was the problem, not the
unit.

## Why
The owner, verbatim, 2026-07-26:

> *"What's that? I can't open the drive from the UI? MQTT or not, I should be
> able to eject it, and then pushing eject again should close it. I know it's
> not designed to be like that, but I need a manual method to control this
> remotely."*

"I need a manual method to control this remotely" is the requirement. A
dashboard that renders a control and then explains why the control cannot work
is worse than no control.

**This is the third time on this project a narrow rule has been widened into a
capability ban and shipped.** The pattern is identical each time:

1. *"rip-deck never ejects"* — the recorded rule was only *never eject-**loop***
   (no auto-eject in the rip cycle). Widened across three documents and one UI;
   the owner had never agreed to it and in fact wanted the opposite.
2. *"`unknown` verdict"* — means *nothing measured this rip*. Read as *this rip
   is suspect*, so three successful 225 GB backups rendered as a red alert with
   a "Retry in another drive" button.
3. **This one.** *"Services talk over MQTT"* — a rule about integration between
   services, read as a ban on the application's own UI reaching its own API.

The lesson is written in `HANDOFF-eject-and-open-questions.md` §1 and is worth
repeating here because it has now failed three times: **when a rule is cited,
read the rule.** Check what it actually constrains before extending it to a case
it does not mention.

## Evidence
Owner, chat 2026-07-26 (Stage 6 review), quoted above, with a screenshot of the
refusal box on the live `example.com` dashboard.

The mechanism already exists in-process and needs no new machinery:
`watcher.runTrayCommand` is on the watcher handle and is what the MQTT path
already calls. The HTTP handler calls the same function.

⚠️ One real constraint survives, and it is not this rule: `api/router.ts`'s
header promises *"every handler is a synchronous read of an in-memory
snapshot"*, because a drive wedged in D-state must never freeze the API. A tray
command is asynchronous and touches a device. It is allowed to be — it spawns a
child with a 20 s watchdog — but it must stay **off the snapshot path**, and the
header comment must be updated to say which handlers are which rather than
claiming all of them are reads.

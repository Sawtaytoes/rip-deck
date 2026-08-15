# The spoken message and the written message are separate fields

Status: Accepted
Date: 2026-07-30
Type: contract / UX

## Decision

Every payload Home Assistant may **speak** carries its own `spoken_message`
field, written for a listener, alongside the existing `message` written for a
reader. Home Assistant speaks `spoken_message` and falls back to the old text.

Two payloads gained it, both additive:

- **`resp/drive`** (`TrayCommandResponsePayload`) — `buildTraySpokenMessage`.
- **`rip/event`** / **`rip/last`** (`RipEventPayload`) — `buildRipSpokenMessage`,
  plus a `slot` field, because the spoken line needs the operator's own bay
  numbering.

**rip-deck owns the words.** The automations no longer compose a sentence out of
rip-deck's structured fields; they read one string. Their old templates stay as
the `| default(...)` fallback so a rollback to an older image still speaks.

Three rules the spoken text keeps and the written text does not:

- **Never the device's own words.** A failed bay's `detail` is whatever `eject`
  printed; a rejection's `reason` quotes the payload in backticks and names JSON
  fields. Both are for whoever fixes the sender.
- **Never the counts or the slot list.** `"Opened 3 drives: slots 1, 2 and 3"` is
  a table read aloud. The trays are visible from where the listener is standing.
- **Never a drive model.** `"09 - Pioneer BDR-211M"` is spoken as *"zero nine
  dash Pioneer B D R two one one M"*. The **slot** is the identifier written on
  the front of the tower.

## Context

The owner, on the live system 2026-07-30:

> *"The HA announcement is announcing the full error message with weird
> computer-style text."*

The previous session recorded this as *"the HA tray-problem announcement speaks
the raw `resp/drive` `message` verbatim, including CLI syntax and backticks — …
`rip-deck rip --slot N --name "…"`"*
(gaps doc gap 2). That diagnosis
was **half right, and its named example was wrong**, which is why this decision
records what was actually measured.

Traced against the live broker and Home Assistant on 2026-07-30:

- `automation.job_status_announcement` **does not read `message` at all.** Every
  string it speaks is its own template. So the identify prose — the CLI hint with
  the backticks — is on the dashboard card and in `bays[].detail`, and **never
  reached TTS**.
- `automation.control_optical_ripper_tower` **does** speak
  `{{ trigger.payload_json.message }}` verbatim, but only on a tray *problem*
  (`not is_accepted`, or a refused or failed count). Its text is
  `buildTrayCommandMessage` — counts, colon lists, and on a failure the raw
  `eject` output. Computer-style, and never containing the CLI hint.
- The line the owner most recently heard, from the automation trace at
  2026-07-30 17:55:22Z, was **`"A rip failed on 09 - Pioneer BDR-211M. It may
  need a look."`** — a drive model read aloud as a part number, *and* the word
  "failed" about a disc that never failed.

That last one is the worst of the three and nobody had named it. `rip/event` has
`result: "success" | "fail"` and no third value, so a `needs_attention` **hold**
— rip-deck declining to guess, nothing wrong with the disc or the drive —
publishes `result: "fail"` and the automation announced a failure. The dashboard
has drawn that distinction since `HeldBayCard` shipped: amber, *"Nothing failed.
Rip Deck did not rip this disc."* The spoken half never had it.

## Why

**Because the reader and the listener want different sentences, not the same
sentence with the punctuation taken out.** A reader can scroll back, re-read, and
act on a per-bay `detail`. A listener standing at the tower gets one pass, no
scrollback, and can act on exactly one thing: which slot, and what to do. Trying
to serve both from one string is what produced a message that was accurate and
unusable — which is the same defect the held-disc card has, in a different
medium.

**Because rip-deck is the one that knows which of the three things happened.** A
hold, a failure and a slow success are three different sentences, and the
automation cannot tell them apart from `result` alone — that is what
`spoken_message` carries and `result` cannot. Giving Home Assistant the
vocabulary would mean a template per case in an automation shared with the 3D and
2D printers.

**Additive, so the shared contract holds.** `AGENTS.md` names
`automation.job_status_announcement` as a contract owned elsewhere: replacing the
disc pipeline changes only the source topic. `announcement.test.ts` locks the
`rip/event` **shape**; a new optional field breaks nothing, the printer branches
were not touched, and the fallback means the two sides can be deployed in either
order.

## Evidence

Owner, 2026-07-30 (`docs/held-disc-ux-and-spoken-message-gaps.md`):

> *"The HA announcement is announcing the full error message with weird
> computer-style text."*

Measured, same day:

- Live broker capture of `rip-deck/tower/resp/drive` (a `close_trays` probe):
  `"message": "Closed 1 drive: slot 9."`, `bays[].detail` per bay — confirming
  the tray payload carries no CLI text, only counts and device words.
- Retained `rip-deck/tower/rip/last`:
  `{"title":"Unknown disc","result":"fail","drive":"09 - Pioneer BDR-211M",
  "verdict_message":"Not enough information to judge this rip yet."}`
- HA trace `automation.job_status_announcement` run
  `1528ea1c663f1c3790c9137d1c1adc04`, 2026-07-30T17:55:22Z, spoken service data:
  `"message": "A rip failed on 09 - Pioneer BDR-211M. It may need a look."`
- HA config `automation.control_optical_ripper_tower`, branch *"Speak a tray
  PROBLEM only"*: `"message": "{{ trigger.payload_json.message }}"`.

Tests: `announcement.test.ts` (`spoken_message — what the speakers say`) and
`trayCommand.test.ts` (`buildTraySpokenMessage`) assert no backtick, no `--`, no
`rip-deck rip`, no drive model, and that a hold is not announced as a failure.

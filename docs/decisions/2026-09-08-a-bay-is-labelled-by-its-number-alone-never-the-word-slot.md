# A bay is labelled by its number alone, never the word "Slot"

- **Status:** Accepted
- **Date:** 2026-09-08
- **Type:** UI naming rule
- **Supersedes:** —
- **Superseded by:** —

## Decision

Every place the UI names a bay shows the bare number — `1`, `7` — never `Slot 1`.
This binds the dashboard cards (fixed in #54), the tower kiosk rows and its disc
detail heading, and any future view. Accessible names and log lines may still say
"slot" where a screen reader or a grep needs the noun; the visible label does not.

## Context

PR #54 removed the word from the dashboard's bay badges after the owner asked for it.
The kiosk shipped in #52 the same day and still rendered `Slot 1` … `Slot 9` in each
row and as the detail view's heading. The owner repeated the instruction while asking
for colour in the kiosk, and noted he had already given it to another agent.

## Why

The number is the whole identity: the tower has nine bays in physical order and the
display sits on top of it. On a 480×320 kiosk the word costs 40px per row that the
rip name now uses. Repeating a rule the owner has already stated is the failure the
decision records exist to prevent.

## Evidence

> "Also, just like I told another agent, no "Slot" word. Just the number is fine."

Owner, 2026-09-08, T3 Code chat on the kiosk colour pass (agentic worktree
`t3code-5bd9f91d`, branch `t3code/5bd9f91d`). Prior application: PR #54,
"Show bay numbers without Slot".

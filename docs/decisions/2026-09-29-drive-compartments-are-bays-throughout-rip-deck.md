# Drive compartments are bays throughout Rip Deck

- **Status:** Accepted
- **Date:** 2026-09-29
- **Type:** Domain terminology
- **Supersedes:** [The 2026-09-08 rule](2026-09-08-a-bay-is-labelled-by-its-number-alone-never-the-word-slot.md) where it allowed “slot” in accessible names and prose
- **Superseded by:** —

## Decision

Use **bay** for the numbered physical compartment throughout the internal drive
model, operator UI, CLI help, and new configuration. A drive may have separate
media or card slots. Existing configuration, CLI flags, MQTT commands, URLs,
history rows, and JSON clients retain compatibility at their boundaries.

## Context

Rip Deck already called its display objects bays, while `slot` still named the
physical number in its internal types and many messages. The earlier UI rule
removed “Slot” from compact visible labels but allowed it elsewhere.

## Why

Using distinct words prevents a compartment from being confused with a drive's
own slots. Compatibility parsing preserves existing installed configuration and
stored history during the naming change.

## Evidence

The owner said, “we should update Rip-Deck to use ‘bay’ internally and not
‘slot’ as well. A drive in a bay may have multiple slots as well.” Chat
`8bc6a61a-d5fd-4ddf-ae9c-87bad41af49f`, 2026-09-29.

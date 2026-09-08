# An adopted completed card does not claim its telemetry is missing

- **Status:** Accepted
- **Date:** 2026-09-08
- **Type:** UI / completed card copy
- **Supersedes:** —
- **Superseded by:** —

## Decision

A completed card restored from the bay ledger does not render `adopted after a restart — no health telemetry`.

Adoption remains part of the wire model because it controls startup safety and timestamps. It is not a visible caveat on a completed card. The card continues to render the saved rip outcome, destination, warnings and health verdict that the daemon can recover from the ledger and the per-job files.

## Context

The visible sentence tried to explain why an adopted process had no current stdout. It described the process boundary instead of the completed rip. A completed rip has durable `<jobUuid>.features.json` and `<jobUuid>.verdict.json` files, and the dashboard already reads the saved verdict. The sentence therefore suggested missing evidence where durable evidence exists.

The operator did not have an action to take from the statement. The card already identifies a restored result through its timestamp and persisted fields without exposing the daemon's restart mechanics.

## Why

A status card should show facts that change an operator decision. Startup adoption prevents a duplicate rip, but the mechanism does not make a completed backup less valid and does not remove its persisted health evidence. Omitting the sentence is more accurate than replacing it with another implementation note.

The `is_adopted` field stays intact for startup behaviour and API consumers. This decision removes only the confusing visible copy.

## Evidence

- Owner, 2026-09-08, chat `t3code-7308e9f1`: “I dunno what "adopted after a restart — no health telemetry" means either.”
- A focused card test confirms that an adopted rip renders neither the restart statement nor the missing-telemetry claim.

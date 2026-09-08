# Web logs show operator events, not progress telemetry

Status: Accepted
Date: 2026-09-08
Type: ux / diagnostics
Supersedes: —
Superseded by: —

## Decision

Rip Deck retains the complete MakeMKV robot capture on disk. The Web UI loads
the bounded complete capture and removes counter telemetry such as `PRGV`,
drive-table rows and per-file `PRGC` churn before rendering it. The visible log
keeps MakeMKV warnings and errors, major stage changes, unknown records, and a
Rip Deck terminal line.

Every new terminal line carries the result, structured failure reason, process
termination, exit code, kernel I/O-error total and MakeMKV read-error total.
Repeated identical important messages are collapsed with an exact count.

## Context

An active job can emit more than 100,000 `PRGV` rows. The old Load more control
multiplied `lines` beyond the API limit and returned a 400 response. More
importantly, a failed job's raw MakeMKV capture sometimes ended with only
progress rows while the kernel counters already held the reason.

## Why

Raw capture and operator presentation have different jobs. Retaining every
record supports later diagnosis. Rendering only events lets the operator find a
warning or failure cause without searching megabytes of counters.

## Evidence

The owner said in the 2026-09-08 session: *"ALL I want to see in the logs are
important messages. I don't wanna see any of these `PRGV` redundant messages."*
After another failure he said: *"And again, logs tell me nothing"*.

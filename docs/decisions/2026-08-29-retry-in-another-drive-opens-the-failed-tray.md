# Retry in another drive opens the failed tray

Status: Accepted
Date: 2026-08-29
Type: Dashboard action
Supersedes: The no-transport clause for `retry_in_another_drive` in `packages/web/README.md`
Superseded by: —

## Decision

The dashboard's `retry_in_another_drive` action calls the existing guarded
`POST /api/tray` route with `open_bay` for the failed drive. When the tray opens,
the response tells the operator to move the disc to another bay; normal insert
detection starts the comparison rip there. A bay that still owns an active rip
is refused by the daemon's existing first safety branch.

## Context

The live failed card rendered an enabled Retry in another drive button. Pressing
it returned a red message that the action had no transport. The control therefore
offered a physical workflow and could not perform its first physical step.

## Why

Software cannot move a disc between drives. It can open the failed tray safely,
which is the only machine step the workflow needs. Reusing the tray endpoint
keeps USB-path resolution, active-rip refusal and the command watchdog in one
authoritative path.

## Evidence

- Owner, chat 2026-08-29: *"This doesn't let me do anything."* The attached UI
  showed `retry_in_another_drive ... has no transport yet`.
- The HTTP data-source regression test asserts the exact `open_bay` request and
  the instruction returned after a successful move.

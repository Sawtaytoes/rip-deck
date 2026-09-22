# The kiosk can cancel one rip

- **Status:** Accepted
- **Date:** 2026-09-21
- **Type:** Kiosk / operator control
- **Supersedes:** —
- **Superseded by:** —

## Decision

An active rip's kiosk detail view offers **Cancel rip**. The action uses the
existing per-bay `POST /api/bay-action` cancel operation: it stops only the
selected rip, keeps the partial output, waits for the ripper to exit, and then
opens that bay's tray.

The kiosk confirms cancellation in a Charcuterie modal inside the page. The
modal names the rip and states every effect before the operator confirms. Its
**Keep ripping** and **Cancel rip** buttons are CastKit touch targets, and their
identities include the drive, job and state. The confirm button disables if that
identity changes before the second press. The kiosk does not use the browser's
native `confirm()` because the remote physical display can return touches only
to named page targets.

Preview and disconnected states show no enabled cancellation path. The daemon's
existing ownership and rip-exit checks remain the final safety boundary.

## Context

The main dashboard could cancel a rip safely, but the basement tower kiosk only
offered disabled tray controls while a rip was active. An operator standing at
the tower had to leave the kiosk to stop the job. Reusing the dashboard's native
confirmation would not solve that gap because the remote CastKit touch path
cannot interact with a Chromium browser dialog.

## Why

- The kiosk is the control surface beside the physical drives.
- Cancellation must identify one job and one bay.
- An irreversible stop needs a confirmation that states what happens to the
  partial output and tray.
- The confirmation itself must work through CastKit's stale-frame touch guard.

## Evidence

Owner, 2026-09-21, T3 Code chat `36527ea2`:

> "Basement Rip Deck Kiosk needs a way to cancel a rip."

The 480×320 browser verification measured every detail control at 46 px high;
the narrowest was 73.8 px wide. Both confirmation controls measured 48 px high.
The live-path check sent exactly
`{"action":"cancel","drive_id":"usb-2-1-1-2-4-4-1"}`, closed the modal, and
rendered the daemon's success report. See the [detail
view](../previews/kiosk-disc-details.png) and [confirmation
view](../previews/kiosk-cancel-confirmation.png).

# Operator guide

Rip Deck watches every configured bay. An inserted disc starts automatically unless bay memory proves that the same completed disc is still present or the bay needs operator attention.

## Read a bay card

Each bay card shows the drive slot, disc name and type, current phase, progress, and health information.

A finished rip has three operator outcomes:

- `pass`: the backup completed without a detected problem.
- `warning`: a usable backup completed, but Rip Deck detected evidence that needs review.
- `fail`: no completed backup exists.

A warning is not downgraded to a pass and is not promoted to a failure when a verified copy exists. See the [read-error decision](decisions/2026-08-27-a-read-error-on-a-verified-backup-is-a-warning-not-a-failure.md).

## Control a rip

The dashboard can cancel a running rip. Cancellation waits for that job to stop before it opens only the matching tray.

Attention cards can expose actions such as Keep trying, Give up, and Clear quarantine. Use the action on the affected bay instead of power-cycling the tower during other rips.

## Use tray controls safely

Bulk tray commands move one motor at a time. Close trays does not move any tray while a rip is active, because simultaneous tray motors on the shared USB tower can disconnect the complete bus.

Do not restart the service or power-cycle the tower while any bay is starting or ripping.

## Retire a finished card

Use Mark as taken out after you remove a disc and a drive continues to report stale media state. The action clears the finished card and its loaded-disc reminder without deleting the permanent history.

## Review leftovers

The leftovers panel lists incomplete and duplicate output. A live rip remains visible but locked. Rename refuses an existing destination instead of overwriting it, and Delete refuses any path claimed by an active rip.

## Review older rips

Open `/history` to search and filter the permanent rip log. See [Rip history](history.md) for API queries and data limits.

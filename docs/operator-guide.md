# Operator guide

Rip Deck watches every configured bay. An inserted disc starts automatically unless bay memory proves that the same completed disc is still present or the bay needs operator attention.

## Read a bay card

Each bay card shows the drive slot, disc name and type, current phase, progress, and health information.

A finished rip has three operator outcomes:

- `pass`: the backup completed without a detected problem.
- `warning`: a usable backup completed, but Rip Deck detected evidence that needs review.
- `fail`: no completed backup exists.

A warning is not downgraded to a pass and is not promoted to a failure when a verified copy exists. See the [read-error decision](decisions/2026-08-27-a-read-error-on-a-verified-backup-is-a-warning-not-a-failure.md).

## Rip a data CD-ROM

Rip Deck reads a data CD-ROM with GNU ddrescue and publishes a folder named
`[DATA] <title>`. The folder holds the raw image and ddrescue's mapfile.

Three operator points:

1. **A data disc usually needs you to type its name.** Rip Deck reads a name
   from the disc's volume label when there is one. Many data CD-ROMs — sampler
   libraries especially — carry no filesystem and therefore no label, and
   nothing else can read a name off one. The card asks. Type the name from the
   sleeve and press Rip.
2. **Keep the mapfile.** It records every sector the drive could not read. A
   later ddrescue run resumes from it and tries only those sectors again.
   Deleting it makes a partial image unrepairable.
3. **"No ISO 9660 filesystem" on a success line is normal.** Many data discs
   hold no filesystem. The image is still complete. The line that reports
   completeness is the sector count, not the filesystem.

A disc that carries **both** audio tracks and a data session is ripped as an
audio CD, and its data session is not imaged. The bay card says so.

## Control a rip

The dashboard can cancel a running rip. Cancellation waits for that job to stop before it opens only the matching tray.

Attention cards can expose actions such as Keep trying, Give up, and Clear quarantine. Use the action on the affected bay instead of power-cycling the tower during other rips.

## Use tray controls safely

Bulk tray commands move one motor at a time. Simultaneous tray motors on the shared USB tower can disconnect the complete bus, so Rip Deck never runs two tray moves together.

Close trays shuts every drawer Rip Deck opened. A rip in another bay does not stop it. The ripping bay's own drawer is never commanded, because that drawer is already shut and a motor command mid-read can destroy the copy. A targeted close against a ripping bay is still refused. See the [close-during-a-rip decision](decisions/2026-09-11-close-trays-closes-the-safe-bays-during-a-rip.md).

Do not restart the service or power-cycle the tower while any bay is starting or ripping.

## Retire a finished card

Use Mark as taken out after you remove a disc and a drive continues to report stale media state. The action clears the finished card and its loaded-disc reminder without deleting the permanent history.

## Review leftovers

The leftovers panel lists incomplete and duplicate output. A live rip remains visible but locked. Rename refuses an existing destination instead of overwriting it, and Delete refuses any path claimed by an active rip.

## Review older rips

Open `/history` to search and filter the permanent rip log. See [Rip history](history.md) for API queries and data limits.

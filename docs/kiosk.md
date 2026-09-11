# Tower kiosk

`/kiosk` is Rip Deck's dedicated 480×320 view. It shows every configured slot in physical order without an app title or a scrolling card grid. Each row is washed in its state's intent colour (info while ripping, success when ready to remove, warning for a slow read or a bay that needs attention, danger for a failure or quarantine, neutral when empty), carries the bay number as a solid chip — never the word "Slot" — and is one line: the rip name at 20 px with `status · type · ETA` after it on the same baseline, and the percentage at the right edge. There is no bar column: the row's own background is the progress, a translucent wash of its intent colour that grows from the left ([decision](decisions/2026-09-10-a-kiosk-row-is-one-line-and-its-background-is-the-progress.md)). The kiosk renders in the fleet's Outfit, like the rest of the app. When no drive answers the daemon's probe (`is_tower_present` false, the daemon's definition of the tower being off) the rows give way to a single "Tower is off" panel, so a switched-off tower does not look like a dead display. A row opens `/kiosk/slots/<drive-id>` with the same chip and title as its heading, the current disc's artwork (when available), type, progress, ETA, outcome, and Open / Close / Disc removed / Back controls.

The colour treatment was chosen from three served candidates ([comparison](previews/2026-09-08-rip-deck-kiosk-colour.html), [render](previews/2026-09-08-rip-deck-kiosk-colour.png)); see the [decision](decisions/2026-09-08-a-kiosk-row-is-tinted-by-its-state-and-headlines-the-rip-name.md).

The kiosk uses the normal Rip Deck data source and command endpoints. Preview and disconnected states disable physical controls. Active rips disable tray and removal commands; the daemon independently refuses unsafe commands. `clear_loaded` accepts an optional `drive_id` or `slot` to dismiss exactly one disc. Omitting the target retains the existing whole-tower command. A malformed or unknown target never becomes a bulk clear. Dismissal preserves the bay latch so a drive that still reports the disc does not rip it again.

## CastKit contract

Point CastKit's remote-display worker at **`/kiosk/castkit.json`**. This app-owned, versioned JSON manifest specifies the viewport, initial page, stable touch identity attribute, refresh limits, and the cached loading URL `/kiosk/loading`. CastKit reads those instructions; it owns no Rip Deck view, disc metadata, artwork lookup, or tray commands.

For photographs and demonstrations, **`/kiosk/castkit-showcase.json`** opens the
read-only `showcase` fixture instead. Its nine rows include one empty bay, active,
stalled, successful, successful-with-warnings, and failed states, plus UHD, Blu-ray,
DVD, and CD media. Fixture responses set `is_fake: true`, the display says
`Preview — controls disabled`, and no touch can operate the physical tower. Restore
the normal manifest and restart the CastKit worker after the demonstration.

![Kiosk showcase with the full state and media mix](previews/kiosk-showcase.png)

The loading URL uses the same React application and shared Charcuterie Skeleton component. CastKit renders it once and preloads the bitmap into ESPHome PSRAM. Row bounds from the rendered frame identify where a completed tap should show that cache immediately. The current WT32 receiver supports one optimistic cache image. It does not cache disc-specific progress or command success.

Action identities contain the drive, job, and state. CastKit binds a physical touch to the identity in the acknowledged image and checks that it still matches Chromium before dispatch. Back and slot navigation use stable route identities. A pending command disables its controls, and a server report supplies the result.

![Nine rows](previews/kiosk-nine-rows.png)
![Disc details](previews/kiosk-disc-details.png)
![Tower is off](previews/kiosk-tower-off.png)

The screenshots use fixtures. Missing artwork produces a placeholder; the kiosk does not invent a poster for an unidentified disc.

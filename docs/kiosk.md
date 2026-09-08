# Tower kiosk

`/kiosk` is Rip Deck's dedicated 480×320 view. It shows every configured slot in physical order without an app title or a scrolling card grid. A row opens `/kiosk/<drive-id>` with the current disc's artwork (when available), title, type, progress, ETA, outcome, and Open / Close / Disc removed / Back controls.

The kiosk uses the normal Rip Deck data source and command endpoints. Preview and disconnected states disable physical controls. Active rips disable tray and removal commands; the daemon independently refuses unsafe commands. `clear_loaded` accepts an optional `drive_id` or `slot` to dismiss exactly one disc. Omitting the target retains the existing whole-tower command. A malformed or unknown target never becomes a bulk clear. Dismissal preserves the bay latch so a drive that still reports the disc does not rip it again.

## CastKit contract

Point CastKit's remote-display worker at **`/kiosk/castkit.json`**. This app-owned, versioned JSON manifest specifies the viewport, initial page, stable touch identity attribute, refresh limits, and the cached loading URL `/kiosk/loading`. CastKit reads those instructions; it owns no Rip Deck view, disc metadata, artwork lookup, or tray commands.

The loading URL uses the same React application and shared Charcuterie Skeleton component. CastKit renders it once and preloads the bitmap into ESPHome PSRAM. Row bounds from the rendered frame identify where a completed tap should show that cache immediately. The current WT32 receiver supports one optimistic cache image. It does not cache disc-specific progress or command success.

Action identities contain the drive, job, and state. CastKit binds a physical touch to the identity in the acknowledged image and checks that it still matches Chromium before dispatch. Back and slot navigation use stable route identities. A pending command disables its controls, and a server report supplies the result.

![Nine rows](previews/kiosk-nine-rows.png)
![Disc details](previews/kiosk-disc-details.png)

The screenshots use fixtures. Missing artwork produces a placeholder; the kiosk does not invent a poster for an unidentified disc.

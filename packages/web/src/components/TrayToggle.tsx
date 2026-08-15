import { IconButton } from "@charcuterie/ui"
import type { IntentName } from "@charcuterie/ui/tokens"

import {
  bayActionLabel,
  nextTrayCommandFor,
} from "../format"
import type { BayView, TrayCommandWord } from "../types"

/**
 * One bay's tray control: **⏏, pressed twice.**
 *
 * > *"This button should also have an eject icon, not 'open
 * > tray' because it's an open/close toggle."*
 *
 * Press → open. Press again → close. What the owner saw before
 * was two separately-labelled buttons, which is two controls for
 * one drawer.
 *
 * ⚠️ **The direction is an inference, not a reading, and there
 * is no reading to be had.** sysfs reports MEDIA, not the door:
 * an open tray and a closed EMPTY tray are identical bytes, and
 * telling them apart needs a `CDROM_DRIVE_STATUS` ioctl Node
 * cannot issue (`docs/eject-and-durable-bay-state.md` §2).
 * `format.nextTrayCommandFor` makes the inference and writes
 * down why; it is called HERE, at the toggle, rather than inside
 * `useTrayCommand`, so the one guess on this path stays in a
 * pure function the unit tests can pin.
 *
 * ⚠️ Today `/json` does not serve `last_tray_command`, so an
 * empty bay's toggle degrades to `open_bay` on every press. That
 * is a known gap in the feed, NOT something to paper over with
 * component state — a local "we opened it" flag survives exactly
 * until the page reloads and then confidently points the wrong
 * way, which is worse than a control that repeats itself.
 *
 * Presentational on purpose. Each card owns its own
 * `useTrayCommand` instance and decides where the answer line
 * goes, because a refusal is a sentence and the three cards have
 * three different places to put one.
 *
 * ## What M5 changed
 *
 * `@charcuterie/ui`'s `IconButton`, whose `label` prop is
 * **required and is a `string`** — which is exactly what this
 * component was already doing by hand, and now cannot stop doing.
 * A glyph with no accessible name is a button nobody can address:
 * a screen reader reads "⏏" and `getByRole("button", { name: "Open
 * tray" })` finds nothing.
 *
 * The amber-card override became an `intent` rather than a
 * `className` of four utilities. A caller naming a *role* cannot
 * pick a colour that fails contrast, and cannot pin the button to
 * one scheme the way `border-amber-800 bg-[#232833]` did.
 */
export function TrayToggle({
  bay,
  isPending,
  onPress,
  intent = "neutral",
}: {
  bay: BayView
  isPending: boolean
  onPress: (command: TrayCommandWord) => void
  /** `warning` on a held bay, so it keeps that card's palette. */
  intent?: IntentName
}) {
  const command = nextTrayCommandFor(bay)
  // "Open tray" / "Close tray" — the button shows the icon the
  // owner asked for, and the words are what a screen reader and
  // a hover both get.
  const label = bayActionLabel(command)

  return (
    <IconButton
      appearance="outline"
      intent={intent}
      isDisabled={isPending}
      isLoading={isPending}
      label={label}
      loadingLabel={`${label}…`}
      onClick={() => {
        onPress(command)
      }}
      size="sm"
      title={label}
    >
      ⏏
    </IconButton>
  )
}

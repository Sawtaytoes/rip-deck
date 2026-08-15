import { Alert } from "@charcuterie/ui"
import type { ReactNode } from "react"

import type { LoadedDiscsView } from "../types"

/**
 * "There are still discs in the tower" — a chore, not an alert.
 *
 * The owner, 2026-07-30, after powering the tower off from his
 * phone while a rip finished without him:
 *
 * > *"The UI can note that something was in a tray when you power
 * > it off. It doesn't today. … It'd be good to know in the UI or
 * > through a Home Assistant automation as a reminder to take out
 * > the disc. Kinda like taking out the trash or there's a leak.
 * > It's something I need to do eventually but wasn't at home to
 * > do it."*
 *
 * ## Why it is `info` and not `warning`
 *
 * Every other banner on this page means something is **wrong**:
 * `UsbAlertBanner` is `danger` because a bad cable is a fault,
 * `HeldBayCard` is amber because rip-deck declined to act. This is
 * neither. The rip worked, the drive is fine, and the only thing
 * outstanding is a walk to the rack — so it is painted like
 * information, because a chore rendered as a warning is how a
 * person learns to ignore warnings.
 *
 * (It was hardcoded slate before M5, which said the same thing by
 * accident. `info` says it on purpose, and says it in the one
 * vocabulary every other component on the page now uses.)
 *
 * ## Why it is loudest when the page has nothing else on it
 *
 * A powered-off tower renders nine absent bays and no cards at
 * all, which is exactly the moment this matters: there is nothing
 * else on screen to remind anyone. The daemon answers the question
 * from memory rather than a probe (`rip/loadedDiscs.ts`), and the
 * sentence it hands over already accounts for the power — a live
 * tower is one button from Open trays, a dark one is not — so
 * this component renders the daemon's words rather than composing
 * its own and drifting from what Home Assistant says out loud.
 */
export function LoadedDiscsBanner({
  loaded,
  actions,
}: {
  /** Absent on a daemon older than 2026-07-30. */
  loaded: LoadedDiscsView | undefined
  /**
   * The "Mark as taken out" control, or nothing.
   *
   * A `ReactNode` passed in rather than rendered here so this
   * component stays presentational — it forwards the daemon's words
   * and has no data source of its own. `HostSection` supplies the
   * smart `ClearLoadedButton`; the tests pass nothing and the slot
   * simply stays empty.
   */
  actions?: ReactNode
}) {
  if (loaded === undefined || loaded.count === 0)
    return null

  // Named discs first: "TROY - BONUS DISC in slot 7" is what he
  // is actually going to go and pick up. A bay with no name still
  // earns its slot — dropping it would make the list disagree
  // with the count in the sentence above it.
  const named = loaded.discs.map((disc) => {
    const where =
      disc.slot === null
        ? disc.label
        : `slot ${String(disc.slot)}`

    return disc.title === null
      ? where
      : `${disc.title} · ${where}`
  })

  return (
    <Alert
      actions={actions}
      className="mb-2.5"
      details={named}
      heading={`💿 ${loaded.message}`}
      intent="info"
      label="Discs still in the tower"
    />
  )
}

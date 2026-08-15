import { Alert } from "@charcuterie/ui"

import { verdictIntent } from "../format"
import type { TowerAlert } from "../types"

/**
 * One trouble, and every bay it touches.
 *
 * This is the whole reason `/json` carries a grouped alert list
 * alongside the per-bay cards. A USB hub losing power stalls
 * four bays at once, and four cards each saying "the disc may
 * need cleaning" is four wrong instructions — the exact
 * confidently-wrong alert the verdict model was built to
 * prevent. The daemon groups by verdict kind; this renders the
 * group, naming every affected bay in one sentence.
 *
 * Only alerts spanning MORE THAN ONE bay appear here, and that
 * filter is the whole point rather than a tidiness pass. A
 * trouble confined to one bay is already fully told by that
 * bay's card, and repeating it above the fold turns the banner
 * into a second copy of the page — nine verdicts becoming
 * eighteen lines is how a banner stops being read, and then the
 * hub fault it exists for is the one that gets skimmed past.
 * What is left is exactly the class the cards cannot express: a
 * problem that is one problem in several places.
 *
 * `is_announceable` is shown because it answers a question the
 * owner will otherwise ask: whether the house speakers already
 * told him. Only `confirmed` verdicts announce, so a `suspected`
 * one appearing here for the first time is not a missed
 * notification.
 *
 * ## What M5 took out
 *
 * A `TONE_CLASS` map that was byte-identical to `VerdictBadge`'s,
 * and the block markup under it. Both are `@charcuterie/ui`'s
 * `Alert` now, and the tone→intent map is declared once in
 * `format.ts`.
 *
 * The `<section aria-label>` stays **here** rather than moving onto
 * each `Alert`'s own `label`, and that is a decision rather than an
 * oversight: the landmark is the **group** — one region holding
 * however many troubles there are — and naming each alert instead
 * would put an unpredictable number of landmarks on the page for a
 * screen-reader user to walk past.
 */
export function TowerAlerts({
  alerts,
}: {
  alerts: TowerAlert[]
}) {
  const shared = alerts.filter(
    (alert) => alert.drive_ids.length > 1,
  )

  if (shared.length === 0) return null

  return (
    <section
      aria-label="Tower alerts"
      className="mb-2.5 flex flex-col gap-1.5"
    >
      {shared.map((alert) => (
        <Alert
          description={
            `${alert.labels.length} bays · ${alert.labels.join(", ")}` +
            ` · ${alert.confidence}` +
            (alert.is_announceable
              ? ""
              : " · not announced")
          }
          heading={alert.message}
          intent={verdictIntent(alert.verdict)}
          key={alert.verdict}
        />
      ))}
    </section>
  )
}

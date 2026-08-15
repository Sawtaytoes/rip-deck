import { Alert } from "@charcuterie/ui"

import type { TowerAlert } from "../types"

/**
 * The "change your USB connection" banner.
 *
 * Its own component, and above `TowerAlerts` rather than inside
 * it, because a flapping bus is a different KIND of alert from the
 * per-bay verdicts that list groups. Two reasons it cannot ride
 * `TowerAlerts`:
 *
 *  1. `TowerAlerts` shows only troubles spanning MORE THAN ONE bay
 *     and touching a NON-held bay. A flap is exactly what holds
 *     bays, so its own symptom would filter it out.
 *  2. It fires with no rip running at all — an idle tower sitting
 *     on a bad cable — when there is no bay verdict to carry it.
 *
 * So it is a single, unconditional banner: if the daemon says the
 * bus is flapping, the owner sees it, held bays or not. Painted
 * `danger` because that is what a bad cable is — and stated as an
 * intent rather than as `border-red-900 bg-red-950/40 text-red-200`,
 * which is what was here and is why this page had no light mode.
 *
 * The `label` is what makes it a **named landmark**: exactly one of
 * these is ever on the page, so `getByRole("region", { name: "USB
 * connection alert" })` is unambiguous. The per-bay verdicts
 * deliberately pass none — see `VerdictBadge`.
 */
export function UsbAlertBanner({
  alert,
}: {
  alert: TowerAlert | null
}) {
  if (alert === null) return null

  return (
    <Alert
      className="mb-2.5"
      description={
        alert.labels.length > 0
          ? `Seen flapping: ${alert.labels.join(", ")}`
          : undefined
      }
      heading={alert.message}
      intent="danger"
      label="USB connection alert"
    />
  )
}

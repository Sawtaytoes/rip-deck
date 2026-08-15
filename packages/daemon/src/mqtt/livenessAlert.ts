import type { Liveness } from "../rip/liveness.ts"
import type { DriveAlertPayload } from "./announcement.ts"

/**
 * Requirement H3 — tell the owner mid-rip that a bay is
 * struggling.
 *
 * This is the thing ARM structurally could not do: its health
 * verdict was computed at rip END, so "bay 7 stopped making
 * progress" could only ever arrive after the rip had already
 * failed. `assessLiveness` already produces exactly what the
 * `drive/<slug>/alert` topic needs — an `alert` action and a
 * plain-language reason — so H3 is a matter of publishing it,
 * not of computing anything new.
 *
 * Published NOT retained: a live "go look at bay 7" alert must
 * not fire again tomorrow when Home Assistant reconnects.
 *
 * A liveness alert is deliberately NOT a health verdict. All we
 * know here is timing — the rip stopped moving — so the kind
 * stays `unknown`. Naming a cause (a dirty disc, a failing
 * drive) requires the error-pattern evidence the health engine
 * collects, and even then only a `confirmed` verdict may
 * announce. Guessing "clean the disc" from a clock is exactly
 * the confidently-wrong alert that makes the owner stop trusting
 * the feature.
 */

/** Only a non-`continue` liveness is worth waking anyone for. */
export const isLivenessAlertable = (
  liveness: Liveness,
): boolean => liveness.action !== "continue"

export const buildLivenessAlertPayload = (input: {
  liveness: Liveness
  /** Display label for the bay, e.g. "07 - Pioneer BDR-211M". */
  driveLabel: string
  slot: number | null
}): DriveAlertPayload => {
  const { liveness, driveLabel, slot } = input

  return {
    drive: driveLabel,
    slot,
    verdict: "unknown",
    action: toAlertAction(liveness),
    message: liveness.reason,
    evidence: [
      `Liveness: ${liveness.kind}`,
      `No forward progress for ${seconds(
        liveness.msSinceProgress,
      )}`,
      `Last output ${seconds(liveness.msSinceEvent)} ago`,
    ],
    // `hung` means makemkvcon is alive and retrying, which does
    // sometimes recover; `silent` means a thread blocked in the
    // kernel on a device that is not answering, which does not.
    is_keep_trying_sensible: liveness.kind !== "silent",
  }
}

/**
 * The one physical action a liveness reading justifies.
 *
 * `silent` is a drive-level observation — nothing is coming back
 * from the device — so pointing at the drive is honest.
 * Everything else gets `none`: the message says what we saw, and
 * the health engine names causes.
 */
const toAlertAction = (liveness: Liveness): string =>
  liveness.kind === "silent" ? "check_drive" : "none"

const seconds = (ms: number): string =>
  `${Math.round(ms / 1000)}s`

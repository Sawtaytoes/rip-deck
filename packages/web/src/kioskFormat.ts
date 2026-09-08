import type { IntentName } from "@charcuterie/ui/tokens"
import {
  humanDuration,
  isBayHeld,
  TRAY_REFUSED_STATES,
} from "./format"
import type { BayView } from "./types"

/** Compact, truthful state for the dedicated tower display. */
export const kioskBaySummary = (bay: BayView) => {
  const state = bay.state
  const isActive = TRAY_REFUSED_STATES.has(state.state)
  const percent = Number.isFinite(state.progress_percent)
    ? Math.max(
        0,
        Math.min(100, Math.floor(state.progress_percent)),
      )
    : 0
  const status = !bay.is_present
    ? "Offline"
    : bay.is_quarantined
      ? "Quarantined"
      : state.state === "failed"
        ? "Failed"
        : state.state === "cancelled"
          ? "Cancelled"
          : isBayHeld(bay)
            ? "Needs attention"
            : state.state === "completed"
              ? state.has_warnings
                ? "Warning"
                : "Success"
              : state.state === "stalled"
                ? "Stalled"
                : state.state === "throttled"
                  ? "Slow read"
                  : isActive
                    ? "Ripping"
                    : "Empty"
  const intent: IntentName =
    status === "Failed" || status === "Quarantined"
      ? "danger"
      : status === "Warning" ||
          status === "Needs attention" ||
          status === "Stalled"
        ? "warning"
        : status === "Success"
          ? "success"
          : isActive
            ? "info"
            : "neutral"
  const type =
    state.disctype === "cd"
      ? "CD"
      : state.disctype === "bluray"
        ? "Blu-ray"
        : state.disctype === "dvd"
          ? "DVD"
          : state.disctype === "uhd"
            ? "UHD"
            : (state.disctype ?? "")
  const eta =
    isActive &&
    state.eta_seconds !== null &&
    state.eta_seconds > 0
      ? `~${humanDuration(state.eta_seconds)}`
      : ""
  const detail = [
    type,
    eta || (status === "Success" ? "Ready to remove" : ""),
  ]
    .filter(Boolean)
    .join(" · ")
  return { status, intent, percent, detail, isActive }
}

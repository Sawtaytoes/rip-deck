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
  const percent =
    state.state === "completed"
      ? 100
      : Number.isFinite(state.progress_percent)
        ? Math.max(
            0,
            Math.min(
              100,
              Math.floor(state.progress_percent),
            ),
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
  const readErrors =
    state.read_error_count > 0
      ? `${state.read_error_count} read error${state.read_error_count === 1 ? "" : "s"}`
      : ""
  const detail = [
    type,
    eta ||
      (status === "Success"
        ? "Ready to remove"
        : status === "Failed"
          ? readErrors
          : ""),
  ]
    .filter(Boolean)
    .join(" · ")
  const isEmpty = status === "Empty" || status === "Offline"
  // The rip name leads the row; an empty or offline bay says what it
  // is waiting for instead, so the line is never blank.
  const title = isEmpty
    ? bay.is_present
      ? "Ready for disc"
      : "Drive disconnected"
    : (state.title ?? bay.label)
  const meta = [status, detail].filter(Boolean).join(" · ")
  return {
    status,
    intent,
    percent,
    detail,
    isActive,
    isEmpty,
    title,
    meta,
  }
}

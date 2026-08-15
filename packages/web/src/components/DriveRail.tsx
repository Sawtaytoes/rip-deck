import {
  driveName,
  isBayHeld,
  isVerdictActionable,
} from "../format"
import type { BayView } from "../types"

/**
 * At-a-glance status for EVERY bay — including the idle ones
 * that have no job and so never appear as a card.
 *
 * Ported from the viewer's `DriveRail`, moved off `host.drives`
 * and onto `rip-deck.bays`. That is not a cosmetic swap: the
 * ARM-shaped drive list has no quarantine flag and no slot, so
 * the ported version could not show a bay taken out of service,
 * and it labelled chips `sr0`…`sr8` — which is nine labels that
 * silently mean a different nine drives after the tower is
 * power-cycled.
 *
 * The chip label is the SLOT, because that is the number the
 * owner can walk up to the rack and count. Slot, `/dev/srN` and
 * MakeMKV's disc index are three different numberings and only
 * one of them is a place.
 */
type ChipState =
  | "ripping"
  | "done"
  | "attention"
  | "quarantined"
  | "idle"

const CHIP: Record<ChipState, string> = {
  ripping:
    "border-intent-success-border bg-intent-success-surface text-intent-success-content",
  // Calm, not celebratory: a finished bay is a fact, and nine
  // bright green chips would compete with the one that is
  // actually moving.
  done: "border-intent-success-border bg-surface-raised text-intent-success-content",
  attention:
    "border-intent-warning-border bg-intent-warning-surface text-intent-warning-content",
  quarantined:
    "border-intent-danger-border bg-intent-danger-surface text-intent-danger-content",
  idle: "border-border-subtle bg-surface-raised text-content-muted",
}

/** A rip is finished with this bay, one way or another. */
const LATCHED_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
])

const ACTIVE_STATES = new Set([
  "ripping",
  "throttled",
  "stalled",
])

function bayStatus(bay: BayView): {
  state: ChipState
  detail: string
} {
  // Quarantine outranks everything: the bay is out of service,
  // so whatever its last job did is history.
  if (bay.is_quarantined) {
    return { state: "quarantined", detail: "quarantined" }
  }

  // Before the verdict, because a held bay's verdict is the
  // placeholder `unknown` the feed stamps on anything the health
  // engine never judged — so the chip would read "unknown",
  // which describes rip-deck's confidence rather than the bay.
  // "held" is the fact, and it is the one the owner can act on.
  if (isBayHeld(bay)) {
    return { state: "attention", detail: "held" }
  }

  // A verdict that asks for nothing is not trouble. This read
  // `verdict !== "ok"` while three finished backups showed amber
  // `unknown` chips on the live rack — `unknown` is what the
  // feed stamps on a bay it did not measure.
  if (isVerdictActionable(bay.state.verdict)) {
    return { state: "attention", detail: bay.state.verdict }
  }

  if (ACTIVE_STATES.has(bay.state.state)) {
    return {
      state: "ripping",
      detail: `${bay.state.progress_percent}%`,
    }
  }

  // A bay with a finished disc still in it is not idle, and
  // saying "idle" hides the one thing the owner might act on:
  // there is something in there to take out.
  if (LATCHED_STATES.has(bay.state.state)) {
    return {
      state: "done",
      detail:
        bay.state.state === "completed"
          ? "done"
          : bay.state.state,
    }
  }

  return { state: "idle", detail: "idle" }
}

export function DriveRail({ bays }: { bays: BayView[] }) {
  if (bays.length === 0) return null

  return (
    <div className="mb-2.5 flex flex-wrap gap-1.5">
      {bays.map((bay) => {
        const { state, detail } = bayStatus(bay)
        const label =
          bay.slot === null
            ? driveName(bay.dev_path)
            : String(bay.slot).padStart(2, "0")

        return (
          <span
            key={bay.drive_id}
            title={bay.label}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm tabular-nums ${CHIP[state]}`}
          >
            <span className="font-semibold">{label}</span>
            <span className="opacity-80">{detail}</span>
          </span>
        )
      })}
    </div>
  )
}

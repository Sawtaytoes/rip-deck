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
  | "failed"
  | "stopped"
  | "quarantined"
  | "idle"

const DANGER_CHIP =
  "border-intent-danger-border bg-intent-danger-surface text-intent-danger-content"

const NEUTRAL_CHIP =
  "border-border-subtle bg-surface-raised text-content-muted"

const CHIP: Record<ChipState, string> = {
  ripping:
    "border-intent-success-border bg-intent-success-surface text-intent-success-content",
  // Calm, not celebratory: a finished bay is a fact, and nine
  // bright green chips would compete with the one that is
  // actually moving.
  done: "border-intent-success-border bg-surface-raised text-intent-success-content",
  attention:
    "border-intent-warning-border bg-intent-warning-surface text-intent-warning-content",
  // A failed rip and an out-of-service bay are both red. They
  // are not the same fact, and the DETAIL word is what separates
  // them — "failed" against "quarantined". The colour answers
  // one question only, and both answer it the same way: there is
  // no backup, and this bay wants you.
  failed: DANGER_CHIP,
  quarantined: DANGER_CHIP,
  // The owner stopped this one on purpose, so it is not an
  // alarm. It produced no backup either, so it is not green.
  stopped: NEUTRAL_CHIP,
  idle: NEUTRAL_CHIP,
}

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

  // ⚠️ BEFORE the verdict, and before the latched branch below,
  // which is where this used to land. `failed` sat in one set
  // with `completed` and `cancelled`, so a rip that produced no
  // backup at all painted the same calm GREEN as one that
  // finished — a chip reading "01 failed" in success colours.
  // Most failures reach it: the verdict branch above catches a
  // failure only when the health engine judged the disc, and
  // `towerFeed` stamps the non-actionable `unknown` on every bay
  // nothing measured.
  //
  // A failure outranks its own verdict here. The verdict names
  // the ACTION and is worth keeping as the word on the chip, but
  // it must not soften the colour to amber: "go clean the disc"
  // and "there is no backup" are two facts, and the second is
  // the louder one.
  if (bay.state.state === "failed") {
    return {
      state: "failed",
      detail: isVerdictActionable(bay.state.verdict)
        ? bay.state.verdict
        : "failed",
    }
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
  if (bay.state.state === "completed") {
    return { state: "done", detail: "done" }
  }

  // Cancelled is the same "there is a disc in there" fact, said
  // about a rip the owner stopped. Not an alarm, and not a
  // success — see `CHIP`.
  if (bay.state.state === "cancelled") {
    return { state: "stopped", detail: "cancelled" }
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

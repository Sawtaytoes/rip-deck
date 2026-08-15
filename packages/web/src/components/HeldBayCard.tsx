import { Button } from "@charcuterie/ui"
import { useState } from "react"

import {
  bareDriveModel,
  isRipOffered,
  isTrayOffered,
  jobActionsFor,
  trayOutcomeFor,
} from "../cardFormat"
import { bayActionLabel, heldDetailLines } from "../format"
import type { BayActionState } from "../hooks/useBayActions"
import { useTrayCommand } from "../hooks/useTrayCommand"
import type { BayAction, BayView } from "../types"
import { TrayToggle } from "./TrayToggle"

/**
 * A disc rip-deck REFUSED to rip, and what to do about it.
 *
 * Its own component rather than a `RipCard` variant or a
 * `VerdictBadge` tone, and the reason is that a held bay has no
 * rip at all. Every number a `RipCard` is built around — percent,
 * ETA, throughput, elapsed, read errors — is zero or absent here,
 * and a `RipCard` full of zeroes reads as a rip that ran and
 * achieved nothing, which is the opposite of what happened.
 * `VerdictBadge` is closer in spirit but is a strip INSIDE a
 * card; there is no card for it to sit in, and the daemon's
 * stand-in verdict for these bays is `unknown` — "Not enough
 * information to judge this rip yet" — a sentence about a rip
 * that never started.
 *
 * `QuarantinedBayCard` is the right precedent, and this is
 * deliberately its shape: a bay with no job, one sentence saying
 * why, and exactly the control that ends it. What differs is the
 * COLOUR and the verb, because the two states call for opposite
 * amounts of worry:
 *
 *  - quarantine is red — a drive is out of service and something
 *    is actually wrong with the hardware;
 *  - held is amber — nothing is wrong. rip-deck declined to guess,
 *    the disc is fine, the drive is fine, and the fix is a button
 *    press.
 *
 * Amber is also what separates it from a FAILED rip at a glance,
 * which is the distinction that matters most on this page: a
 * failed rip is a red card with a percentage and read errors on
 * it and means "this disc may be damaged"; a held bay is an amber
 * card with no numbers on it at all and means "rip-deck does not
 * know whether this was already ripped, so it did not rip it".
 * Those two call for completely different actions and must never
 * be told apart by reading closely.
 *
 * ## The card used to be a dead end, and that was the defect
 *
 * It said *"rip it by hand with `rip-deck rip --slot N --name
 * "…"`"* — a CLI command a dashboard cannot run — and offered ⏏ as
 * its only control. ⏏ does not even un-hold on this hardware: the
 * drives keep reporting the disc after the tray opens, so the bay
 * never reads empty and never re-arms
 * ([decision](docs/decisions/2026-07-27-tray-memory-beats-disc-presence.md)).
 * Physically pulling the disc out was the only thing that worked.
 * The owner: *"It's waiting on me, but what am I supposed to do?
 * Is there an input to fix the name? I don't have a way to do
 * anything actionable other than eject. Horrible user
 * experience."*
 *
 * So the card carries the fix: a name box and one button
 * ([decision](docs/decisions/2026-07-30-a-held-bay-is-ripped-from-the-dashboard.md)).
 * **A name the operator types is not an invented name** — B3
 * forbids *rip-deck* inventing one, and this is exactly what
 * `rip-deck rip --name` has always been, through a text box
 * instead of a shell.
 */
export function HeldBayCard({
  bay,
  onAction,
  action,
  isSharedDetail = false,
}: {
  bay: BayView
  onAction: (input: {
    driveId: string
    label: string
    action: BayAction
  }) => void
  /** In-flight / just-finished feedback for this bay, if any. */
  action?: BayActionState
  /**
   * A held bay above this one already printed the identical
   * sentence in full.
   *
   * The startup hold fires on every loaded bay at once, so three
   * discs produce three copies of the same paragraph — the same
   * shape as the hub-fault text that ended up repeated on five
   * surfaces (`docs/HANDOFF-eject-and-open-questions.md` §4).
   * The repetition also buries the one thing that DOES differ
   * per card, which is which disc is in which slot. So this
   * borrows `VerdictBadge`'s answer: say it once, then point.
   */
  isSharedDetail?: boolean
}) {
  const {
    run: runTrayCommand,
    pendingDriveIds,
    lastReport,
    lastError,
  } = useTrayCommand()

  // Prefilled from the disc's own label when there is one. On the
  // disc that produced this complaint there was NOT — the hold was
  // an identify race, so the bay had no name to show — and that is
  // the common case: an operator with a readable label rarely sees
  // this card at all. Empty is a normal starting state, and the
  // button says so.
  const [typedName, setTypedName] = useState(
    bay.state.title ?? "",
  )

  const isBusy = action?.status === "pending"
  const isRipPending = pendingDriveIds.has(bay.drive_id)
  const trimmedName = typedName.trim()
  // What the daemon published, minus the re-rip control that
  // means nothing on a disc rip-deck never read and minus the
  // tray pair the ⏏ toggle owns. `bayActionsFor` and
  // `jobActionsFor` argue all three.
  const actions: BayAction[] = jobActionsFor(bay)
  const detailLines = isSharedDetail
    ? []
    : heldDetailLines(bay)
  const trayOutcome = trayOutcomeFor({
    report: lastReport,
    lastError,
    driveId: bay.drive_id,
  })
  // The slot is said once, in its own chip, so the registry's
  // "07 - " prefix comes off the model (§3). This card's whole
  // job is to say WHICH disc is waiting in WHICH slot, and the
  // prefix was burying both under a repeated number.
  const model = bareDriveModel({
    label: bay.label,
    slot: bay.slot,
  })

  return (
    <div className="my-1.5 rounded-xl border border-intent-warning-border bg-intent-warning-surface px-3.5 py-2.5 text-content-primary">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-semibold text-intent-warning-content">
          <span className="shrink-0 rounded-md border border-intent-warning-border bg-surface-raised px-1.5 py-0.5 text-sm font-normal tabular-nums text-intent-warning-content">
            slot {bay.slot ?? "?"}
          </span>
          <span className="min-w-0 break-words">
            ⏸ {bay.state.title ?? model} · held — not ripped
          </span>
        </span>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {isTrayOffered(bay) && (
            <TrayToggle
              bay={bay}
              isPending={pendingDriveIds.has(bay.drive_id)}
              onPress={(command) => {
                runTrayCommand({
                  command,
                  driveId: bay.drive_id,
                })
              }}
              intent="warning"
            />
          )}
          {actions.map((bayAction) => (
            <Button
              key={bayAction}
              appearance="outline"
              intent="warning"
              isDisabled={isBusy}
              onClick={() => {
                onAction({
                  driveId: bay.drive_id,
                  label: bay.label,
                  action: bayAction,
                })
              }}
              size="sm"
            >
              {bayActionLabel(bayAction)}
            </Button>
          ))}
        </div>
      </div>

      {/* Said before the detail, because it is the bit that
          stops this card being mistaken for a failure. Nothing
          here went wrong; rip-deck declined to act on a guess. */}
      <div className="mt-1 text-sm text-intent-warning-content">
        Nothing failed. Rip-Deck did not rip this disc, and
        it is waiting on you.
      </div>

      {isSharedDetail && (
        <div className="mt-1 text-sm text-content-muted">
          Same reason as above.
        </div>
      )}

      {detailLines.map((line) => (
        <div
          key={line}
          className="mt-1 text-sm text-content-secondary"
        >
          {line}
        </div>
      ))}

      {/* The way out. One box and one button, and the button's
          label says which of the two things it is about to do —
          two near-identical buttons ("Rip with this name" beside
          "Try again") would leave the operator guessing which one
          he wants, on the card whose whole problem was not knowing
          what to do. Empty box → re-read the disc. Anything typed
          → rip under that name. */}
      {isRipOffered(bay) && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()

            runTrayCommand({
              command: "rip_bay",
              driveId: bay.drive_id,
              name: trimmedName,
            })
          }}
        >
          <input
            type="text"
            value={typedName}
            onChange={(event) => {
              setTypedName(event.target.value)
            }}
            disabled={isRipPending}
            placeholder="Name this disc (optional)"
            aria-label={`Name for the disc in slot ${
              bay.slot ?? "?"
            }`}
            className="min-w-0 flex-1 rounded-md border border-intent-warning-border bg-surface-raised px-2.5 py-1 text-sm text-content-primary placeholder:text-content-muted focus:border-intent-warning-border focus:outline-none disabled:opacity-50"
          />
          <Button
            appearance="solid"
            intent="warning"
            isDisabled={isRipPending}
            size="sm"
            type="submit"
          >
            {isRipPending
              ? "Starting…"
              : trimmedName === ""
                ? "Try again"
                : "Rip as this"}
          </Button>
        </form>
      )}

      {/* The bay's own sentence about the press, never the
          report's rack-wide `message`. */}
      {trayOutcome && (
        <div
          className={`mt-1.5 text-sm ${
            trayOutcome.isTrouble
              ? "text-intent-warning-content"
              : "text-content-secondary"
          }`}
        >
          {trayOutcome.text}
        </div>
      )}

      {action && (
        <div
          className={`mt-1.5 text-sm ${
            action.status === "fail"
              ? "text-intent-danger-content"
              : action.status === "ok"
                ? "text-intent-success-content"
                : "text-content-secondary"
          }`}
        >
          {action.status === "pending"
            ? `${bayActionLabel(action.action).toLowerCase()}…`
            : action.status === "ok"
              ? `✓ ${bayActionLabel(action.action).toLowerCase()}`
              : `✗ ${action.msg ?? "failed"}`}
        </div>
      )}
    </div>
  )
}

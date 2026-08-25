import { Button } from "@charcuterie/ui"

import {
  bareDriveModel,
  isTrayOffered,
  jobActionsFor,
  trayOutcomeFor,
} from "../cardFormat"
import { bayActionLabel } from "../format"
import type { BayActionState } from "../hooks/useBayActions"
import { useTrayCommand } from "../hooks/useTrayCommand"
import type { BayAction, BayView } from "../types"
import { TrayToggle } from "./TrayToggle"

/**
 * A bay taken out of service, and the control that returns it.
 *
 * A quarantined bay usually has no job, so it produces no `Rip`
 * and would otherwise be a chip on the rail and nothing else —
 * which is how a drive stays quietly out of service for a week.
 * It gets its own card because the decision it is waiting on is
 * a human one: quarantine is deliberately never self-healing,
 * since an automatic un-quarantine re-enters the same crash loop
 * later, at night, with nobody watching.
 *
 * So the card says which bay, why, and offers exactly the action
 * the daemon published for it. It does not offer to retry.
 *
 * It DOES offer a tray control, and that is the one here the
 * daemon has not published: quarantine's documented way out is
 * "take the disc out to re-arm this bay", and without it a disc
 * can be locked in a drive no button opens
 * (`docs/eject-and-durable-bay-state.md` §2). `trayActionsFor`
 * says a quarantined bay is eligible for BOTH directions,
 * because quarantine says nothing about what is in the drive —
 * so this is exactly where the ⏏ toggle earns its second press.
 */
export function QuarantinedBayCard({
  bay,
  onAction,
  action,
}: {
  bay: BayView
  onAction: (input: {
    driveId: string
    label: string
    action: BayAction
  }) => void
  action?: BayActionState
}) {
  const {
    run: runTrayCommand,
    pendingDriveIds,
    lastReport,
    lastError,
  } = useTrayCommand()

  const actions: BayAction[] = jobActionsFor(bay)
  const trayOutcome = trayOutcomeFor({
    report: lastReport,
    lastError,
    driveId: bay.drive_id,
  })
  // Slot in its own chip, model without the registry's "07 - "
  // prefix — the same "say the slot once" rule as the rip card.
  const model = bareDriveModel({
    label: bay.label,
    slot: bay.slot,
  })

  return (
    <div className="my-1.5 rounded-xl border border-intent-danger-border bg-surface-raised px-3.5 py-2.5 text-content-primary">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-semibold text-intent-danger-content">
          <span className="shrink-0 rounded-md bg-surface-sunken px-1.5 py-0.5 text-sm font-normal tabular-nums text-content-muted">
            Slot {bay.slot ?? "?"}
          </span>
          <span className="min-w-0 break-words">
            ⚠ {model} · out of service
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
            />
          )}
          {action && action.status !== "fail" && (
            <span
              className={`text-sm ${
                action.status === "ok"
                  ? "text-intent-success-content"
                  : "text-content-secondary"
              }`}
            >
              {action.status === "pending"
                ? `${bayActionLabel(action.action).toLowerCase()}…`
                : `✓ ${bayActionLabel(action.action).toLowerCase()}`}
            </span>
          )}
          {actions.map((bayAction) => (
            <Button
              key={bayAction}
              appearance="outline"
              intent="neutral"
              isDisabled={action?.status === "pending"}
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
      {bay.quarantine_reason && (
        <div className="mt-0.5 text-sm text-content-muted">
          {bay.quarantine_reason}
        </div>
      )}

      {/* The bay's own sentence about a tray press. A refusal
          here is the interesting case: quarantine does not stop
          a tray moving, but a rip does. */}
      {trayOutcome && (
        <div
          className={`mt-1.5 rounded-md border px-2 py-1 text-sm ${
            trayOutcome.isTrouble
              ? "border-intent-warning-border bg-intent-warning-surface text-intent-warning-content"
              : "border-border-default bg-surface-sunken text-content-secondary"
          }`}
        >
          {trayOutcome.text}
        </div>
      )}

      {/* A refusal is a sentence, not a chip. In the header row
          it either truncated or pushed the buttons off. */}
      {action?.status === "fail" && (
        <div className="mt-1.5 rounded-md border border-intent-danger-border bg-intent-danger-surface px-2 py-1 text-sm text-intent-danger-content">
          ✗ {bayActionLabel(action.action).toLowerCase()}{" "}
          failed{action.msg ? `: ${action.msg}` : ""}
        </div>
      )}
    </div>
  )
}

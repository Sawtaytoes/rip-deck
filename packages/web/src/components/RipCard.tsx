import {
  Button,
  Lightbox,
  ProgressCard,
  type ProgressCardLayout,
  Tooltip,
} from "@charcuterie/ui"

import {
  bareDriveModel,
  isTrayOffered,
  jobActionsFor,
  trayOutcomeFor,
} from "../cardFormat"
import {
  bayActionLabel,
  discLabel,
  driveName,
  elapsedText,
  estimatedCompletionText,
  etaText,
  etaTrendText,
  isVerdictActionable,
  RIP_VISUAL_INTENT,
  ripProgressLabel,
  ripVisual,
  ripWarningLines,
  throughputText,
  verdictIntent,
} from "../format"
import type { BayActionState } from "../hooks/useBayActions"
import { useTrayCommand } from "../hooks/useTrayCommand"
import type { BayAction, BayView, Rip } from "../types"
import { DiscKindLogo } from "./DiscKindLogo"
import { TrayToggle } from "./TrayToggle"
import { VerdictBadge } from "./VerdictBadge"

export type RipCardLayout = ProgressCardLayout

function actionText(state: BayActionState): string {
  const verb = bayActionLabel(state.action).toLowerCase()
  if (state.status === "pending") return `${verb}…`
  if (state.status === "ok") return `✓ ${verb}`
  return `✗ ${verb} failed${state.msg ? `: ${state.msg}` : ""}`
}

const JOB_ACTION_HELP: Partial<Record<BayAction, string>> =
  {
    keep_trying:
      "Keep trying disables the automatic stall timeout for this rip.",
    cancel:
      "Cancel stops the rip, keeps its partial output, and opens its tray.",
  }

/** Live progress owns the headline; detailed diagnosis is supplementary. */
export function RipCard({
  rip,
  bay,
  onShowLog,
  onAction,
  action,
  isSharedTrouble = false,
  layout = "band",
  now = Date.now(),
}: {
  rip: Rip
  bay?: BayView
  onShowLog: (rip: Rip) => void
  onAction: (input: {
    driveId: string
    label: string
    action: BayAction
  }) => void
  action?: BayActionState
  isSharedTrouble?: boolean
  layout?: RipCardLayout
  now?: number
}) {
  const {
    run: runTrayCommand,
    pendingDriveIds,
    lastReport,
    lastError,
  } = useTrayCommand()
  const visual = ripVisual(rip)
  const houseLabel = rip.drive_name ?? driveName(rip.drive)
  const model = bareDriveModel({
    label: rip.drive_name,
    slot: rip.slot,
  })
  const title =
    discLabel(rip) ?? (model || driveName(rip.drive))
  const activity = bay?.state.state ?? rip.status
  const hasDiagnosis = isVerdictActionable(rip.verdict)
  const isDanger =
    visual.state === "failed" ||
    (hasDiagnosis &&
      verdictIntent(rip.verdict) === "danger")
  const isWarning =
    !isDanger &&
    (visual.state === "warning" ||
      rip.read_error_count > 0 ||
      rip.warnings.length > 0 ||
      hasDiagnosis ||
      activity === "stalled" ||
      activity === "throttled")
  const cardIntent = isDanger
    ? "danger"
    : isWarning
      ? "warning"
      : "neutral"
  const progressIntent = isDanger
    ? "danger"
    : isWarning
      ? "warning"
      : RIP_VISUAL_INTENT[visual.state]
  const status = rip.active
    ? activity === "stalled"
      ? "Stalled"
      : activity === "throttled"
        ? "Slow read"
        : isDanger || isWarning
          ? "Needs attention"
          : visual.state === "indeterminate"
            ? "Preparing disc"
            : "Ripping"
    : visual.percentText
  const hasPercentage = rip.active && rip.percent !== null
  // A long rip can still visibly advance below one percent.
  const progressText = hasPercentage
    ? `${rip.percent?.toFixed(1)}%`
    : rip.active
      ? status
      : visual.percentText
  const eta = rip.active
    ? etaText(rip.eta_seconds).replace(/ left$/, "")
    : ""
  const finish = rip.active
    ? estimatedCompletionText(rip.eta_seconds, now).replace(
        /^Estimated finish /,
        "",
      )
    : ""
  const speed = rip.active
    ? throughputText(rip.throughput_bytes_per_sec)
    : ""
  const elapsed = rip.active
    ? elapsedText(rip.start, now)
    : ""
  const trend = rip.active
    ? etaTrendText(rip.eta_trend)
    : ""
  const actions = jobActionsFor(bay)
  const trayOutcome = trayOutcomeFor({
    report: lastReport,
    lastError,
    driveId: rip.drive_id,
  })

  return (
    <ProgressCard
      aria-label={`${title} — ${rip.slot ?? "?"}`}
      role="article"
      className="my-1.5"
      elevation="none"
      intent={cardIntent}
      layout={layout}
      isIndeterminate={visual.state === "indeterminate"}
      isValueEmphasized={hasPercentage}
      progressIntent={progressIntent}
      progressLabel={ripProgressLabel(rip)}
      status={hasPercentage ? status : undefined}
      value={visual.fillPercent}
      valueText={progressText}
      metrics={
        rip.active
          ? [
              { label: "Speed", value: speed || "—" },
              { label: "Remaining", value: eta || "—" },
              { label: "Finishes", value: finish || "—" },
            ]
          : []
      }
      media={
        rip.poster !== null ? (
          <>
            <span className="rounded-md bg-surface-sunken px-2 py-0.5 font-semibold tabular-nums text-content-muted">
              {rip.slot ?? "?"}
            </span>
            <Lightbox
              alt={`${title} poster`}
              caption={rip.disctype_label ?? undefined}
              className="relative z-10"
              src={rip.poster}
              thumbnail={
                <img
                  src={rip.poster}
                  alt=""
                  loading="lazy"
                  className="aspect-[2/3] w-16 rounded-lg object-cover ring-1 ring-border-subtle @md/bay:w-24"
                />
              }
            />
          </>
        ) : undefined
      }
      header={
        <>
          <div className="flex items-start gap-2">
            {rip.poster === null && (
              <span className="shrink-0 rounded-md bg-surface-sunken px-2 py-0.5 font-semibold tabular-nums text-content-muted">
                {rip.slot ?? "?"}
              </span>
            )}
            <span className="min-w-0 break-words text-lg font-semibold leading-snug">
              {title}
            </span>
          </div>
          <DiscKindLogo className="mt-2" kind={rip.kind} />
        </>
      }
      actions={
        <>
          {bay !== undefined && isTrayOffered(bay) && (
            <TrayToggle
              bay={bay}
              isPending={pendingDriveIds.has(rip.drive_id)}
              onPress={(command) =>
                runTrayCommand({
                  command,
                  driveId: rip.drive_id,
                })
              }
            />
          )}
          {actions.map((bayAction) => {
            const button = (
              <Button
                key={bayAction}
                appearance="outline"
                intent={
                  bayAction === "cancel"
                    ? "danger"
                    : "neutral"
                }
                isDisabled={action?.status === "pending"}
                onClick={() =>
                  onAction({
                    driveId: rip.drive_id,
                    label: houseLabel,
                    action: bayAction,
                  })
                }
                size="sm"
              >
                {bayActionLabel(bayAction)}
              </Button>
            )
            const help = JOB_ACTION_HELP[bayAction]
            return help ? (
              <Tooltip key={bayAction} label={help}>
                {button}
              </Tooltip>
            ) : (
              <span key={bayAction}>{button}</span>
            )
          })}
        </>
      }
    >
      {rip.read_error_count > 0 && (
        <div
          className={`mt-2 text-sm font-semibold ${isDanger ? "text-intent-danger-content" : "text-intent-warning-content"}`}
        >
          {rip.read_error_count} read{" "}
          {rip.read_error_count === 1 ? "error" : "errors"}
        </div>
      )}
      {rip.warnings.map((warning) => (
        <ul
          className="mt-2 text-sm text-intent-warning-content"
          key={warning}
        >
          {ripWarningLines(warning).map((line) => (
            <li
              className="ml-4 list-disc pl-0.5"
              key={line}
            >
              {line}
            </li>
          ))}
        </ul>
      ))}
      <VerdictBadge
        verdict={rip.verdict}
        message={rip.verdict_message}
        confidence={rip.verdict_confidence}
        evidence={bay?.alert?.evidence ?? []}
        isShared={isSharedTrouble}
      />
      {rip.path && (
        <div className="mt-2 break-all text-sm text-content-muted @max-md/bay:hidden">
          → {rip.path}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-content-muted">
        {elapsed && <span>{elapsed}</span>}
        {trend && <span>{trend}</span>}
        {rip.is_keep_trying_requested && (
          <span>Keep trying enabled</span>
        )}
        {action && action.status !== "fail" && (
          <span>{actionText(action)}</span>
        )}
        {rip.logfile && (
          <Button
            appearance="ghost"
            className="relative z-10 ml-auto @max-md/bay:hidden"
            intent="neutral"
            onClick={() => onShowLog(rip)}
            size="sm"
          >
            Logs
          </Button>
        )}
      </div>
      {trayOutcome && (
        <div
          className={`mt-2 rounded-lg border px-2 py-1 text-sm ${trayOutcome.isTrouble ? "border-intent-warning-border text-intent-warning-content" : "border-border-subtle text-content-secondary"}`}
        >
          {trayOutcome.text}
        </div>
      )}
      {action?.status === "fail" && (
        <div className="mt-2 rounded-lg border border-intent-danger-border bg-intent-danger-surface px-2 py-1 text-sm text-intent-danger-content">
          {actionText(action)}
        </div>
      )}

      {rip.logfile && (
        <button
          type="button"
          aria-label={`Show the log for slot ${rip.slot ?? "?"}`}
          onClick={() => onShowLog(rip)}
          className="absolute inset-0 rounded-2xl @md/bay:hidden"
        />
      )}
    </ProgressCard>
  )
}

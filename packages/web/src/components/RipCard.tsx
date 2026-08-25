import {
  Accordion,
  Button,
  Lightbox,
  ProgressBar,
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
  discTypeText,
  driveName,
  elapsedText,
  etaText,
  etaTrendText,
  RIP_VISUAL_INTENT,
  ripProgressLabel,
  ripVisual,
  throughputText,
} from "../format"
import type { BayActionState } from "../hooks/useBayActions"
import { useTrayCommand } from "../hooks/useTrayCommand"
import type {
  BayAction,
  BayView,
  Drive,
  Rip,
} from "../types"
import { DiscKindLogo } from "./DiscKindLogo"
import { TrayToggle } from "./TrayToggle"
import { VerdictBadge } from "./VerdictBadge"

/** Short feedback for an in-flight / just-finished bay action. */
function actionText(state: BayActionState): string {
  const verb = bayActionLabel(state.action).toLowerCase()

  if (state.status === "pending") return `${verb}…`
  if (state.status === "ok") return `✓ ${verb}`

  return `✗ ${verb} failed${state.msg ? `: ${state.msg}` : ""}`
}

const CARD_BORDER: Record<string, string> = {
  done: "border-intent-success-border",
  failed: "border-intent-danger-border",
  running: "border-border-subtle",
  indeterminate: "border-border-subtle",
}

/**
 * Where this card stops being a card and becomes an accordion.
 *
 * A CONTAINER query, not a viewport one: the owner's layout puts
 * one to four of these side by side and remembers the choice, so
 * "am I on a phone" is the wrong question — the card is narrow
 * whenever its COLUMN is narrow, which happens on a phone and on
 * a four-up ultrawide alike (§4).
 *
 **The contract is `BayGrid`'s, verbatim:** container name
 * `bay`, container type `inline-size`, narrow below
 * `@max-md/bay:` (28rem / 448px), full density at `@md/bay:` and
 * up. The page shell states it; the card obeys it. Do not pick a
 * different number here — two thresholds for one layout is the
 * doubled opinion this repo keeps paying for.
 *
 * ⚠️ **This card must be rendered inside a `BayGrid` cell**, and
 * `HostSection` is the only thing that renders one — every path
 * there goes through a `BayGrid`. The card deliberately does NOT
 * declare a container of its own. It did briefly, as a belt: a
 * card with no container to query would leave the collapsed
 * card's full-bleed log overlay without its `@md/bay:hidden`,
 * and an unmatched container query is false, so the overlay
 * would swallow clicks at every width. That failure mode is
 * real — but the belt cost more than it saved. Nested containers
 * resolve to the INNERMOST, so a card-level `bay` container is
 * the same box one padding narrower, and every `@md/bay:` here
 * would silently fire ~28px later than the 448px `BayGrid`
 * documents. Two containers with one name is the doubled
 * opinion, just spelled in CSS. If a card ever does need to
 * render outside the grid, give it a cell — do not give it a
 * second container.
 *
 * Spelled out at every use rather than held in a constant:
 * Tailwind generates utilities by SCANNING the source text, and
 * a class name assembled from a variable is a class name that
 * gets no CSS.
 */

/**
 * One bay's card.
 *
 * **The field order is the owner's ranked list, verbatim**
 * (`docs/HANDOFF-stage7-ui-and-naming.md` §12): slot number,
 * disc name, thumbnail, drive controls, overall progress,
 * per-item progress, status, location, disc type, then drive
 * name/serial behind an advanced-info disclosure, then logs.
 *
 * Read what that reordering cost: the DRIVE NAME used to be this
 * card's headline and is now tenth, behind a `<details>`. Slot,
 * disc and thumbnail all outrank it. A bay is where a disc
 * happens to be sitting; it is not what the card is about.
 *
 * What the card believes, and why it disagrees with the ported
 * viewer:
 *
 *  - **The ETA is the daemon's, not an extrapolation.** The
 *    viewer fitted a line through elapsed and percent. Every
 *    MakeMKV stage restarts PRGV from zero, so that fit crosses
 *    a discontinuity and reported a rising ETA on a perfectly
 *    healthy rip (§2.4). `eta_seconds` is measured per stage.
 *  - **Read errors are shown, always, and never in a calm
 *    colour.** Exit code 0 is necessary and not sufficient —
 *    MakeMKV exits 0 having saved nothing — and never reporting
 *    success on a rip that had read errors is the one rule that
 *    overrides everything else here. It is also the ONE thing
 *    the narrow accordion still shows: §4 lists four fields for
 *    a collapsed card and this is not among them, but a rip
 *    whose read errors are one tap away is a rip that reads as
 *    fine.
 *  - **The controls are the daemon's `bay.actions`.** The card
 *    does not decide that a quarantined bay gets a clear button
 *    or that a suspected disc verdict gets a retry; it renders
 *    the list the tower view published. One place decides, and
 *    it is the place that knows. The ⏏ toggle is the single
 *    exception and `format.trayActionsFor` argues it.
 *  - **The destination is a FIELD, not evidence.** It used to
 *    surface inside the verdict's evidence list, because for a
 *    completed outcome the outcome's `detail` string *is* the
 *    path — so "where did it rip to" rendered as a symptom of
 *    ill health (§5). `Job.destinationPath` is now populated
 *    from the bay ledger and arrives as `rip.path`, so it sits
 *    on the metadata line where the owner asked for it.
 */
export function RipCard({
  rip,
  bay,
  drive,
  onShowLog,
  onAction,
  action,
  isSharedTrouble = false,
  now = Date.now(),
}: {
  rip: Rip
  /** The native view of the same bay, when we have it. */
  bay?: BayView
  /**
   * The physical drive behind this bay, for the advanced panel.
   *
   * Optional because the serial and the model live in
   * `host.drives` rather than on the rip, and a card rendered
   * without them simply says less. Item 10 of the ranked list is
   * "drive name, serial, and other info" — the serial is the
   * only part that is not already on `rip`.
   */
  drive?: Drive
  onShowLog: (rip: Rip) => void
  onAction: (input: {
    driveId: string
    label: string
    action: BayAction
  }) => void
  /** In-flight / just-finished feedback for this bay, if any. */
  action?: BayActionState
  /** This bay's trouble is stated in full by a tower alert. */
  isSharedTrouble?: boolean
  /** Injectable so elapsed text is deterministic in tests. */
  now?: number
}) {
  const {
    run: runTrayCommand,
    pendingDriveIds,
    lastReport,
    lastError,
  } = useTrayCommand()

  const visual = ripVisual(rip)
  // The house label — "07 - Pioneer BDR-211M" — is still what a
  // bay action is announced against, because that is the name
  // the MQTT topic and the entity id carry. It is no longer what
  // the card SHOWS.
  const houseLabel = rip.drive_name ?? driveName(rip.drive)
  const model = bareDriveModel({
    label: rip.drive_name,
    slot: rip.slot,
  })
  // Null rather than the word "disc": a bay adopted from the
  // ledger has `identity: null`, and a placeholder is not more
  // information than a blank. `discLabel` says why the name
  // cannot honestly be recovered on this side.
  const disc = discLabel(rip)
  // Second in the ranked list, so it is the headline — and the
  // drive falls back into that slot only when there is genuinely
  // no disc name, which is the adopted-bay case. A card with no
  // title at all is worse than one titled by its bay.
  const title = disc ?? (model || driveName(rip.drive))
  const discType = discTypeText(rip)

  const isBusy = action?.status === "pending"
  const isTrayBusy = pendingDriveIds.has(rip.drive_id)
  const elapsed = rip.active
    ? elapsedText(rip.start, now)
    : ""
  const eta = rip.active ? etaText(rip.eta_seconds) : ""
  const trend = rip.active
    ? etaTrendText(rip.eta_trend)
    : ""
  const throughput = rip.active
    ? throughputText(rip.throughput_bytes_per_sec)
    : ""
  // What the daemon published, minus the one control that must
  // never sit on a finished rip and minus the tray pair the ⏏
  // toggle owns. `bayActionsFor` and `jobActionsFor` argue both.
  const actions: BayAction[] = jobActionsFor(bay)
  const trayOutcome = trayOutcomeFor({
    report: lastReport,
    lastError,
    driveId: rip.drive_id,
  })
  // The native job state, not the ARM-flattened status.
  // `toArmStatus` folds `ripping`, `throttled` and `stalled` into
  // one word because the viewer only ever special-cased success
  // and failure — but a bay that has stopped answering reading
  // "ripping" is a lie on the card, and telling those three apart
  // is most of why this dashboard exists.
  const activity = bay?.state.state ?? rip.status

  return (
    <article
      className={`relative my-1.5 rounded-xl border bg-surface-raised px-3.5 py-2.5 text-content-primary ${CARD_BORDER[visual.state]}`}
    >
      {/* Collapsed, the whole card is the log button (§4:
          "tapping opens the log"). It is `display: none` above
          the threshold rather than conditionally rendered, so a
          wide card has no invisible overlay to tab into — and
          the controls sit above it on `z-10`, or a press on ⏏
          would open a log instead of a drawer. */}
      {rip.logfile && (
        <button
          type="button"
          aria-label={`Show the log for slot ${rip.slot ?? "?"}`}
          onClick={() => {
            onShowLog(rip)
          }}
          className="absolute inset-0 rounded-xl @md/bay:hidden"
        />
      )}

      <div className="flex gap-3">
        {/* 3. The thumbnail. Always shown when present — the
            owner wants the poster and title on a phone, not only
            once a column clears 28rem. Sized smaller under
            `@md/bay` so a narrow card still has room for the
            name; full 2:3 trim (`w-28` ≈ 112×168) when the cell
            is wide. Wrapped in Charcuterie's `Lightbox` so a
            click opens it full-size. `ring-border-subtle` so the
            ring survives a light scheme. */}
        {rip.poster && (
          <Lightbox
            alt={`${title} poster`}
            caption={rip.disctype_label ?? undefined}
            className="relative z-10 shrink-0"
            src={rip.poster}
            thumbnail={
              <img
                src={rip.poster}
                alt=""
                loading="lazy"
                onError={(event) => {
                  event.currentTarget.style.display = "none"
                }}
                className="aspect-[2/3] w-16 rounded-md object-cover ring-1 ring-border-subtle @md/bay:w-28"
              />
            }
          />
        )}

        <div className="min-w-0 flex-1">
          {/* Title + controls wrap independently so a narrow card
              never ellipsises the disc name down to "T…" behind
              Keep trying / Give up / Cancel. */}
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
            <span className="flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2">
              {/* 1. The slot, said ONCE. It used to be said
                  twice — prefixed onto the drive name by
                  `config/drives.json` and again on the line
                  below (§3). The registry keeps its prefix,
                  because that name is the MQTT label and
                  therefore the HA entity id; the card stops
                  rendering it. */}
              <span className="shrink-0 rounded-md bg-surface-sunken px-1.5 py-0.5 text-sm tabular-nums text-content-muted">
                slot {rip.slot ?? "?"}
              </span>
              {/* 2. The disc — wrap, never truncate. The poster
                  and the title are what the operator is looking
                  for on a phone; `truncate` hid both. */}
              <span className="min-w-0 break-words font-semibold text-content-primary">
                <DiscKindLogo
                  className="mr-1.5"
                  kind={rip.kind}
                />
                {title}
              </span>
            </span>

            {/* 4. Drive controls. `z-10` keeps them above the
                collapsed card's log overlay.

                This row must be allowed to SHRINK, and that is a
                correction. It carried `shrink-0`, which pins a
                flex item at its max-content width — so the row's
                own `flex-wrap` could never engage and the widest
                single line (`43.0% · Keep trying · Give up ·
                Cancel`) set the card's floor. That floor was
                288px against 13px button text and fit a 360px
                phone; `@charcuterie/ui@2.9.0`'s 17px-body type
                ramp took the same row to 331px and it began
                overflowing the document by 6px. `min-w-0` lets
                the row narrow and wrap its buttons instead,
                which is what the wrap was there for. */}
            <div className="relative z-10 flex min-w-0 flex-wrap items-center gap-2">
              <span className="tabular-nums text-content-secondary">
                {visual.percentText}
              </span>
              {bay !== undefined && isTrayOffered(bay) && (
                <TrayToggle
                  bay={bay}
                  isPending={isTrayBusy}
                  onPress={(command) => {
                    runTrayCommand({
                      command,
                      driveId: rip.drive_id,
                    })
                  }}
                />
              )}
              {actions.map((bayAction) => (
                <Button
                  key={bayAction}
                  appearance="outline"
                  intent={
                    bayAction === "cancel" ||
                    bayAction === "give_up"
                      ? "danger"
                      : "neutral"
                  }
                  isDisabled={isBusy}
                  onClick={() => {
                    onAction({
                      driveId: rip.drive_id,
                      label: houseLabel,
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

          {/* 5. Overall progress — `@charcuterie/ui`'s, which
              corrects three things about the copy this replaced.
              The role goes on the TRACK rather than the fill, so a
              4% rip is no longer a progressbar 4px wide as far as
              a screen reader and a Playwright bounding box are
              concerned. The name is a real label naming the SLOT,
              so nine bays are nine addressable bars instead of
              nine identical "Working"s. And `aria-valuenow` is
              omitted while indeterminate, which is what says
              "unknown" rather than "zero". */}
          <ProgressBar
            className="mt-2"
            intent={RIP_VISUAL_INTENT[visual.state]}
            isIndeterminate={
              visual.state === "indeterminate"
            }
            label={ripProgressLabel(rip)}
            value={visual.fillPercent}
          />

          {/* Never quiet, never green, and never behind a tap. A
              rip with read errors is not a success no matter
              what the exit code said. */}
          {rip.read_error_count > 0 && (
            <div className="mt-1.5 inline-block rounded-md border border-intent-danger-border bg-intent-danger-surface px-2 py-0.5 text-sm font-semibold text-intent-danger-content">
              {rip.read_error_count} read{" "}
              {rip.read_error_count === 1
                ? "error"
                : "errors"}
            </div>
          )}

          {/* Everything below is what a collapsed card drops. */}
          <div className="@max-md/bay:hidden">
            {(elapsed || eta || throughput) && (
              <div className="mt-1 text-sm tabular-nums text-content-muted">
                {[elapsed, eta, throughput]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}

            {/* 6. Per-item progress — the title being written
                right now, not the whole backup.

                ⚠️ This is the LABEL only. MakeMKV emits both
                halves (PRGC current-item against PRGT total) and
                `rip/progress.ts` models both as `currentFraction`
                and `totalFraction`, but `/json` serialises only
                the total: `armView.toArmPercent` reads
                `totalFraction` and `stage` carries
                `currentLabel`. So there is a per-item NAME on
                this side and no per-item NUMBER, and a second
                bar here would have to invent one. Requirement C5
                asks for two-level progress and it is half
                served; the missing field is the daemon's. */}
            {rip.stage && (
              <div className="mt-1 truncate text-sm text-content-muted">
                {rip.stage}
              </div>
            )}

            {/* 7, 8, 9 — status, then where it landed, then what
                kind of disc it was. One row that WRAPS rather
                than a box underneath: the destination is a fact
                about the rip, and the box it used to live in was
                the verdict's evidence list (§5). */}
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-content-muted">
              <span className="text-content-secondary">
                {activity}
              </span>
              {rip.path && (
                <span className="min-w-0 break-all">
                  → {rip.path}
                </span>
              )}
              {discType !== null && (
                <span className="text-content-muted">
                  {discType}
                </span>
              )}
              {action && action.status !== "fail" ? (
                <span
                  className={
                    action.status === "ok"
                      ? "text-intent-success-content"
                      : "text-content-secondary"
                  }
                >
                  {actionText(action)}
                </span>
              ) : null}
            </div>

            {trend && (
              <div className="mt-1.5 inline-block rounded-md border border-border-default bg-surface-sunken px-2 py-0.5 text-sm text-content-secondary">
                ⏱ {trend}
              </div>
            )}

            {rip.is_keep_trying_requested && (
              <div className="mt-1.5 inline-block rounded-md border border-border-default bg-surface-sunken px-2 py-0.5 text-sm text-content-secondary">
                keep trying — stall watchdog suppressed
              </div>
            )}

            {/* An adopted process has no stdout, so it has no
                health telemetry at all; saying "unknown" without
                saying why reads as a bug. */}
            {rip.is_adopted && (
              <div className="mt-1.5 inline-block rounded-md border border-border-default bg-surface-sunken px-2 py-0.5 text-sm text-content-muted">
                adopted after a restart — no health
                telemetry
              </div>
            )}

            <VerdictBadge
              verdict={rip.verdict}
              message={rip.verdict_message}
              confidence={rip.verdict_confidence}
              evidence={bay?.alert?.evidence ?? []}
              isShared={isSharedTrouble}
            />

            {/* 10. The drive, its serial and the addressing —
                tenth on the list, so behind a disclosure rather
                than in the headline where it used to be. The
                Charcuterie `Accordion` carries the chevron and
                `aria-expanded` the hand-rolled `<details>` never
                showed — a pill with `list-none` had no affordance
                that it opened at all. `headingLevel={2}` because
                the page's only other heading is
                DashboardHeader's `<h1>`, and jumping to `3` is a
                skipped level `heading-order` flags. The ⓘ glyph
                is gone with the pill: the library ships no symbol
                characters, which the kiosk Pis have no font for. */}
            <Accordion
              className="relative z-10 mt-1.5"
              headingLevel={2}
              items={[
                {
                  key: "drive-info",
                  label: "drive info",
                  content: (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 break-all">
                      <dt className="text-content-muted">
                        drive
                      </dt>
                      <dd>{model || houseLabel}</dd>
                      {drive?.serial_id && (
                        <>
                          <dt className="text-content-muted">
                            serial
                          </dt>
                          <dd>{drive.serial_id}</dd>
                        </>
                      )}
                      <dt className="text-content-muted">
                        device
                      </dt>
                      {/* Addressing, never identity: `/dev/srN`
                          reshuffles on every USB
                          re-enumeration. */}
                      <dd>
                        {rip.drive ?? "not on the bus"}
                      </dd>
                      <dt className="text-content-muted">
                        drive id
                      </dt>
                      <dd>{rip.drive_id}</dd>
                      <dt className="text-content-muted">
                        job
                      </dt>
                      <dd>{rip.job_uuid}</dd>
                    </dl>
                  ),
                },
              ]}
            />

            {/* 11. The log. Hidden when this job has no capture
                — which now means what it says, rather than the
                blanket `logfile: null` the daemon sent while
                `/logs` answered 501. */}
            {rip.logfile && (
              <Button
                appearance="outline"
                className="relative z-10 mt-1.5"
                intent="neutral"
                onClick={() => {
                  onShowLog(rip)
                }}
                size="sm"
              >
                Logs
              </Button>
            )}
          </div>

          {/* A tray press answers per BAY, and the sentence is
              the bay's `detail` — never the report's `message`,
              which is written about the whole rack and would
              report success about the one bay the daemon
              correctly protected. Kept out of the collapsed
              card's hidden block: it is the answer to a press
              the operator just made. */}
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

          {/* A refused action gets its own line rather than the
              tail of the meta row. The refusals that matter are
              sentences, and the meta row is `break-all`, which
              snaps English mid-word. */}
          {action?.status === "fail" && (
            <div className="mt-1.5 rounded-md border border-intent-danger-border bg-intent-danger-surface px-2 py-1 text-sm text-intent-danger-content">
              {actionText(action)}
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

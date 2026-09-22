import {
  Badge,
  Button,
  ButtonLink,
  Modal,
  ProgressBar,
} from "@charcuterie/ui"
import { useState } from "react"
import { useLocation, useParams } from "react-router"
import { readFixtureName } from "../fixture"
import { trayActionsFor } from "../format"
import { useBayActions } from "../hooks/useBayActions"
import { useRipDeckState } from "../hooks/useRipDeckState"
import { useTrayCommand } from "../hooks/useTrayCommand"
import { kioskBaySummary } from "../kioskFormat"
import type { BayView } from "../types"

const slotPath = (bay: BayView) =>
  `/kiosk/slots/${encodeURIComponent(bay.drive_id)}`

const CANCEL_HELP =
  "Cancel stops the rip, keeps its partial output, and opens its tray after the ripper exits."

type CancelTarget = {
  driveId: string
  identity: string
  label: string
  title: string
}

/** All configured slots in physical order, with dedicated full-size controls. */
export const Kiosk = () => {
  const { driveId } = useParams<{ driveId: string }>()
  const { search } = useLocation()
  const fixture = readFixtureName(search)
  const query = useRipDeckState(fixture)
  const { run, pendingDriveIds, lastReport, lastError } =
    useTrayCommand()
  const { runConfirmedAction, actionFor } = useBayActions()
  const [cancelTarget, setCancelTarget] =
    useState<CancelTarget | null>(null)
  const tower = query.data?.ripDeck
  const bays = [...(tower?.bays ?? [])].sort(
    (first, second) =>
      (first.slot ?? 999) - (second.slot ?? 999),
  )
  const selected = bays.find(
    (bay) => bay.drive_id === driveId,
  )
  const isOffline =
    query.isError || Boolean(tower?.error) || !tower
  const isReadOnly = isOffline || tower?.is_fake === true
  const summary = selected
    ? kioskBaySummary(selected)
    : null
  const trayActions = selected
    ? [...selected.actions, ...trayActionsFor(selected)]
    : []
  const selectedRip = query.data?.hosts
    .flatMap((host) => host.rips)
    .find(
      (rip) =>
        rip.drive_id === selected?.drive_id &&
        rip.job_uuid === selected?.state.job_id,
    )
  const isTrayPending =
    selected !== undefined &&
    pendingDriveIds.has(selected.drive_id)
  const targetIdentity = selected
    ? `${selected.drive_id}:${selected.state.job_id ?? "empty"}:${selected.state.state}`
    : ""
  const selectedAction = selected
    ? actionFor(selected.drive_id)
    : undefined
  const isActionPending =
    selectedAction?.status === "pending"
  const isPending = isTrayPending || isActionPending
  const isCancelOffered =
    selected?.actions.includes("cancel") === true
  const reportText =
    selectedAction?.msg ?? lastError ?? lastReport?.message
  const canConfirmCancel =
    cancelTarget !== null &&
    selected !== undefined &&
    cancelTarget.identity === targetIdentity &&
    selected.actions.includes("cancel") &&
    !isReadOnly &&
    !isPending
  // The house label ("4K") is worth a line only when the summary
  // has not already said it — a location never repeats its type.
  const discTypeLabel =
    selectedRip?.disctype_label ?? selected?.state.disctype
  const discTypeLine =
    summary &&
    discTypeLabel &&
    !summary.detail.includes(discTypeLabel)
      ? discTypeLabel
      : null
  const statusMessage = query.isError
    ? "Connection lost — controls unavailable"
    : tower?.error
      ? "Drive state unavailable — controls disabled"
      : !tower
        ? "Connecting to Rip Deck…"
        : tower.is_fake
          ? "Preview — controls disabled"
          : null

  return (
    <main
      className="rip-kiosk"
      data-scheme="dark"
      data-castkit-ready={tower ? "true" : "false"}
    >
      {statusMessage && (
        <div className="rip-kiosk-status" role="status">
          {statusMessage}
        </div>
      )}
      {driveId && !selected && tower && (
        <div className="rip-kiosk-details">
          <p>This bay is no longer available.</p>
          <ButtonLink
            href={`/kiosk${search}`}
            data-castkit-target="kiosk-back"
          >
            Back
          </ButtonLink>
        </div>
      )}
      {selected && summary ? (
        <section
          className="rip-kiosk-details"
          aria-label={`Slot ${selected.slot ?? "?"} controls`}
        >
          <div className="rip-kiosk-heading">
            <h1>
              <Badge
                className="rip-kiosk-number"
                intent={summary.intent}
                appearance="solid"
              >
                {selected.slot ?? "?"}
              </Badge>
              <span className="rip-kiosk-title">
                {summary.title}
              </span>
            </h1>
            <Badge
              className="rip-kiosk-outcome"
              intent={summary.intent}
              appearance="soft"
            >
              {summary.status} · {summary.percent}%
            </Badge>
          </div>
          <div className="rip-kiosk-disc">
            {selectedRip?.poster ? (
              <img
                className="rip-kiosk-poster"
                src={selectedRip.poster}
                alt={`Poster for ${selected.state.title ?? "this disc"}`}
              />
            ) : (
              <div className="rip-kiosk-poster rip-kiosk-no-poster">
                No artwork
              </div>
            )}
            <div className="rip-kiosk-disc-info">
              <p className="rip-kiosk-meta">
                {summary.detail || "No disc information"}
              </p>
              {discTypeLine && <p>{discTypeLine}</p>}
              <p>
                {selected.state.read_error_count > 0
                  ? `${selected.state.read_error_count} read errors`
                  : summary.isActive
                    ? "No read errors"
                    : selected.outcome_detail}
              </p>
              <ProgressBar
                label={`Slot ${selected.slot ?? "?"} progress`}
                value={summary.percent}
                intent={summary.intent}
                size="lg"
              />
            </div>
          </div>
          <div
            className="rip-kiosk-actions"
            data-has-cancel={
              isCancelOffered ? "true" : "false"
            }
          >
            <Button
              size="lg"
              isDisabled={
                isReadOnly ||
                isPending ||
                !trayActions.includes("open_bay")
              }
              data-castkit-target={`open:${targetIdentity}`}
              onClick={() =>
                run({
                  command: "open_bay",
                  driveId: selected.drive_id,
                })
              }
            >
              Open
            </Button>
            <Button
              size="lg"
              isDisabled={
                isReadOnly ||
                isPending ||
                !trayActions.includes("close_bay")
              }
              data-castkit-target={`close:${targetIdentity}`}
              onClick={() =>
                run({
                  command: "close_bay",
                  driveId: selected.drive_id,
                })
              }
            >
              Close
            </Button>
            <Button
              size="lg"
              isDisabled={
                isReadOnly ||
                isPending ||
                summary.isActive ||
                (selected.state.state === "idle" &&
                  !selected.is_quarantined)
              }
              data-castkit-target={`removed:${targetIdentity}`}
              onClick={() =>
                run({
                  command: "clear_loaded",
                  driveId: selected.drive_id,
                })
              }
            >
              Disc removed
            </Button>
            {isCancelOffered && (
              <Button
                size="lg"
                intent="danger"
                isDisabled={isReadOnly || isPending}
                data-castkit-target={`cancel:${targetIdentity}`}
                onClick={() =>
                  setCancelTarget({
                    driveId: selected.drive_id,
                    identity: targetIdentity,
                    label: selected.label,
                    title:
                      selected.state.title ?? "this rip",
                  })
                }
              >
                Cancel rip
              </Button>
            )}
            <ButtonLink
              className="rip-kiosk-back"
              href={`/kiosk${search}`}
              size="lg"
              data-castkit-target="kiosk-back"
            >
              Back
            </ButtonLink>
          </div>
          <p className="rip-kiosk-report" role="status">
            {isActionPending
              ? "Stopping this rip…"
              : isTrayPending
                ? "Working…"
                : (reportText ??
                  (isCancelOffered
                    ? CANCEL_HELP
                    : summary.isActive
                      ? "Tray controls are unavailable while this slot rips."
                      : selected.outcome_detail))}
          </p>
        </section>
      ) : !driveId && tower && !tower.is_tower_present ? (
        // No drive answered the last probe, which is the daemon's
        // own definition of "tower off". A blank panel here read as
        // a dead display when the owner had simply switched the
        // tower off at the wall.
        <section
          className="rip-kiosk-off"
          aria-label="Tower status"
        >
          <h1>Tower is off</h1>
          <p>
            No drives answered. Power the tower on to see
            its bays.
          </p>
        </section>
      ) : (
        !driveId && (
          <section
            className="rip-kiosk-rows"
            aria-label="Drive slots"
            style={{
              gridTemplateRows: `repeat(${Math.max(1, bays.length)}, minmax(0, 1fr))`,
            }}
          >
            {bays.map((bay) => {
              const row = kioskBaySummary(bay)
              return (
                <ButtonLink
                  key={bay.drive_id}
                  href={`${slotPath(bay)}${search}`}
                  appearance="soft"
                  intent={row.intent}
                  className="rip-kiosk-row"
                  data-empty={
                    row.isEmpty ? "true" : "false"
                  }
                  data-castkit-loading="disc-details"
                  data-castkit-target={`slot:${bay.drive_id}`}
                  aria-label={`Slot ${bay.slot ?? "?"}: ${row.status}, ${row.percent}%`}
                >
                  <Badge
                    className="rip-kiosk-number"
                    intent={row.intent}
                    appearance="solid"
                  >
                    {bay.slot ?? "?"}
                  </Badge>
                  <span className="rip-kiosk-line">
                    <strong className="rip-kiosk-title">
                      {row.title}
                    </strong>
                    <span className="rip-kiosk-meta">
                      {row.meta}
                    </span>
                  </span>
                  <strong className="rip-kiosk-percent">
                    {row.isEmpty ? "—" : `${row.percent}%`}
                  </strong>
                  {/* The row is its own bar: the fill washes the whole
                      row behind the text (see `.rip-kiosk-fill`). Last
                      in the DOM so the row's text still starts with the
                      bay number, not the bar's hidden label. */}
                  <ProgressBar
                    className="rip-kiosk-fill"
                    label={`Slot ${bay.slot ?? "?"} progress`}
                    value={row.percent}
                    intent={row.intent}
                    size="md"
                  />
                </ButtonLink>
              )
            })}
          </section>
        )
      )}
      <Modal
        aria-labelledby="rip-kiosk-cancel-title"
        className="rip-kiosk-cancel"
        isDismissable={false}
        isVisible={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        role="alertdialog"
      >
        <h2 id="rip-kiosk-cancel-title">
          Cancel this rip?
        </h2>
        <p>
          <strong>{cancelTarget?.title}</strong>
          {" — "}
          {CANCEL_HELP}
        </p>
        <div className="rip-kiosk-cancel-actions">
          <Button
            size="lg"
            data-castkit-target={`keep-ripping:${cancelTarget?.identity ?? "none"}`}
            onClick={() => setCancelTarget(null)}
          >
            Keep ripping
          </Button>
          <Button
            size="lg"
            intent="danger"
            isDisabled={!canConfirmCancel}
            data-castkit-target={`confirm-cancel:${cancelTarget?.identity ?? "none"}`}
            onClick={() => {
              if (!cancelTarget || !canConfirmCancel) return

              const target = cancelTarget
              setCancelTarget(null)
              void runConfirmedAction({
                driveId: target.driveId,
                label: target.label,
                action: "cancel",
              })
            }}
          >
            Cancel rip
          </Button>
        </div>
      </Modal>
    </main>
  )
}

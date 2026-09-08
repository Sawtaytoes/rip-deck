import {
  Button,
  ButtonLink,
  ProgressBar,
} from "@charcuterie/ui"
import { useLocation, useParams } from "react-router"
import { readFixtureName } from "../fixture"
import { trayActionsFor } from "../format"
import { useRipDeckState } from "../hooks/useRipDeckState"
import { useTrayCommand } from "../hooks/useTrayCommand"
import { kioskBaySummary } from "../kioskFormat"
import type { BayView } from "../types"

const slotPath = (bay: BayView) =>
  `/kiosk/${encodeURIComponent(bay.drive_id)}`

/** All configured slots in physical order, with dedicated full-size controls. */
export const Kiosk = () => {
  const { driveId } = useParams<{ driveId: string }>()
  const { search } = useLocation()
  const fixture = readFixtureName(search)
  const query = useRipDeckState(fixture)
  const { run, pendingDriveIds, lastReport, lastError } =
    useTrayCommand()
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
  const isPending =
    selected !== undefined &&
    pendingDriveIds.has(selected.drive_id)
  const targetIdentity = selected
    ? `${selected.drive_id}:${selected.state.job_id ?? "empty"}:${selected.state.state}`
    : ""
  const reportText = lastError ?? lastReport?.message
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
            <h1>Slot {selected.slot ?? "?"}</h1>
            <strong>
              {summary.status} · {summary.percent}%
            </strong>
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
              <p className="rip-kiosk-title">
                {selected.state.title ?? selected.label}
              </p>
              <p>
                {summary.detail || "No disc information"}
              </p>
              <p>
                {selectedRip?.disctype_label ??
                  selected.state.disctype ??
                  "Unknown disc type"}
              </p>
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
          <div className="rip-kiosk-actions">
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
            {isPending
              ? "Working…"
              : (reportText ??
                (summary.isActive
                  ? "Tray controls are unavailable while this slot rips."
                  : selected.outcome_detail))}
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
                  appearance="outline"
                  intent={row.intent}
                  className="rip-kiosk-row"
                  data-castkit-loading="disc-details"
                  data-castkit-target={`slot:${bay.drive_id}`}
                  aria-label={`Slot ${bay.slot ?? "?"}: ${row.status}, ${row.percent}%`}
                >
                  <span className="rip-kiosk-number">
                    Slot {bay.slot ?? "?"}
                  </span>
                  <strong className="rip-kiosk-percent">
                    {row.percent}%
                  </strong>
                  <ProgressBar
                    label={`Slot ${bay.slot ?? "?"} progress`}
                    value={row.percent}
                    intent={row.intent}
                    size="lg"
                  />
                  <span className="rip-kiosk-description">
                    <strong>{row.status}</strong>
                    <span>
                      {row.detail ||
                        (bay.is_present
                          ? "Ready for disc"
                          : "Drive disconnected")}
                    </span>
                  </span>
                </ButtonLink>
              )
            })}
          </section>
        )
      )}
    </main>
  )
}

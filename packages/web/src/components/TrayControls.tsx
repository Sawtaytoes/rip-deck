import { Button } from "@charcuterie/ui"

import { useTrayCommand } from "../hooks/useTrayCommand"

/**
 * The two bulk tray buttons: **Open trays** and **Close trays**.
 *
 * Two buttons, not one toggle
 * ([decision](docs/decisions/2026-07-30-open-trays-escalates-and-close-trays-is-plain.md),
 * superseding the old "Open all complete" that closed on a second
 * press). Open always opens, Close always closes; a control whose
 * action depends on invisible prior state is the thing the owner
 * named as broken.
 *
 * Neither button holds any escalation state. **Open trays** sends
 * `open_trays` every press and the daemon resolves the width from
 * tray memory — first press opens the finished bays, the next
 * widens to all — so a page reload or a second dashboard cannot
 * desync a click counter that does not exist. On an off tower the
 * same press powers it on. **Close trays** sends `close_trays`,
 * which closes only the bays rip-deck opened.
 *
 * ## The third button is not a tray button
 *
 * **Tower off** cuts mains to the rack
 * ([decision](docs/decisions/2026-07-30-the-dashboard-can-switch-the-tower-off.md)).
 * It rides this component because it rides the same command
 * surface and answers with the same report — and because the
 * refusal below is the reason it is allowed to exist at all: one
 * bay mid-rip refuses the WHOLE press, since there is one power
 * lead. rip-deck never touches the Home Assistant switch itself;
 * it publishes a request on `cmd/power` that an automation acts
 * on, the same way an Open press against a dark tower already
 * asks for it to be switched on.
 *
 * There is deliberately **no Tower on button**: a dark tower is
 * powered on by pressing Open trays, which is the press an
 * operator walking up to a dead rack was going to make anyway.
 *
 * Discs still loaded do NOT refuse it — they are named in the
 * report instead, which is the owner's own call: he knows what is
 * in his tower, and powering it down only traps them until it
 * comes back on.
 *
 * ⚠️ **A refusal RESOLVES.** `is_accepted: true` with per-bay
 * `refused_ripping` is the daemon answering "I heard you, and I
 * did not touch bay 4 because it is ripping" — the most important
 * sentence these buttons can produce, and the one that would be
 * thrown away by treating anything short of total success as an
 * error. `lastError` is reserved for the endpoint being genuinely
 * unreachable: a 405, a 503, a dead network.
 */
export function TrayControls() {
  const { run, isBulkPending, lastReport, lastError } =
    useTrayCommand()

  // Named separately from the summary sentence because it is the
  // half a person has to act on: which bay, by name, was left
  // alone. `counts.refused` says how many; only this says which.
  const refused =
    lastReport?.bays.filter(
      (bay) => bay.result === "refused_ripping",
    ) ?? []

  // The slot is the number the owner can walk up to the rack and
  // count; the full house label nine times over is a wall.
  const refusedNames = refused.map((bay) =>
    bay.slot === null
      ? bay.label
      : `slot ${String(bay.slot)}`,
  )

  /**
   * The refusal sentences, said ONCE each.
   *
   * A busy rack refuses every bay for the identical reason, and
   * printing that paragraph nine times buries the page under it —
   * the same defect `HeldBayCard` already solved the same way.
   * Equality of the whole sentence, not a pattern over it.
   */
  const refusedDetails = [
    ...new Set(refused.map((bay) => bay.detail)),
  ]

  return (
    <div className="flex max-w-sm flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          appearance="outline"
          intent="neutral"
          isDisabled={isBulkPending}
          onClick={() => {
            run({ command: "open_trays" })
          }}
          size="sm"
        >
          ⏏ {isBulkPending ? "Working…" : "Open trays"}
        </Button>

        <Button
          appearance="outline"
          intent="neutral"
          isDisabled={isBulkPending}
          onClick={() => {
            run({ command: "close_trays" })
          }}
          size="sm"
        >
          Close trays
        </Button>

        {/* Set apart from the tray pair, because it is a
            different kind of act: the trays are reversible from
            this page and the mains are not. */}
        <Button
          appearance="outline"
          className="ml-1.5"
          intent="danger"
          isDisabled={isBulkPending}
          onClick={() => {
            run({ command: "power_off" })
          }}
          size="sm"
        >
          Tower off
        </Button>
      </div>

      {lastError !== null && (
        <div className="rounded-md border border-intent-danger-border bg-intent-danger-surface px-2 py-1 text-sm text-intent-danger-content">
          tray command failed: {lastError}
        </div>
      )}

      {lastReport !== null && (
        <div
          className={`rounded-md border px-2 py-1 text-sm ${
            refused.length > 0
              ? "border-intent-warning-border bg-intent-warning-surface text-intent-warning-content"
              : "border-border-default bg-surface-sunken text-content-secondary"
          }`}
        >
          {lastReport.message}

          {refusedNames.length > 0 && (
            <div className="mt-1 font-semibold">
              {refusedNames.join(" · ")}
            </div>
          )}

          {refusedDetails.map((detail) => (
            <div key={detail} className="mt-0.5">
              {detail}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

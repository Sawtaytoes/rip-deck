import { Badge, Button, Card } from "@charcuterie/ui"

import {
  hasHistoryTitle,
  historyBayText,
  historyDurationText,
  historyFinishedText,
  historyOutcomeIntent,
  historyOutcomeText,
  historyReadErrorText,
  historySizeText,
  historyThroughputText,
  historyTitle,
} from "../historyFormat"
import type { HistoryRip } from "../types"
import { DiscKindLogo } from "./DiscKindLogo"
import { VerdictBadge } from "./VerdictBadge"

/**
 * One rip that is over.
 *
 * ## What it deliberately is NOT
 *
 * `RipCard`. That card is 600 lines about a bay you can still
 * act on — a progress bar, an ETA, a tray toggle, a Rip button —
 * and every one of those is meaningless here. Reusing it would
 * mean a card whose body is mostly branches asking whether this
 * rip is still happening, and the answer is always no.
 *
 * What it borrows instead is the vocabulary: `DiscKindLogo`,
 * `VerdictBadge` and the intent tokens, so a finished rip on this
 * page and the same rip on the dashboard an hour earlier look
 * like the same product.
 *
 * ## The order of the facts
 *
 * The title, then WHEN. The reason this page exists is the
 * owner's *"check by date"*, so the date is never more than one
 * line from the name and it is never relative — "3 days ago"
 * cannot be matched against a stack of discs on the desk.
 *
 * ## ⚠️ Read errors are shown on a FINISHED rip too
 *
 * The green chip says the rip completed. It does not say the
 * disc read cleanly, and conflating those is
 * [ARM #1298](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/1298)
 * — the defect this whole project was built around. So
 * `historyReadErrorText` renders beside the success chip rather
 * than instead of it, in the danger colour, on a card that also
 * says "Finished".
 */
export function HistoryCard({
  rip,
  onShowLog,
}: {
  rip: HistoryRip
  /** Absent when nothing can open a capture. */
  onShowLog?: (rip: HistoryRip) => void
}) {
  const readErrors = historyReadErrorText(rip)
  const duration = historyDurationText(rip)
  const size = historySizeText(rip)
  const throughput = historyThroughputText(rip)

  return (
    <Card
      // A `<section>` with no heading is not a landmark, so
      // twenty-five of these do not trip axe's
      // `landmark-unique` — the same argument `VerdictBadge`
      // makes for taking no `label`. The title below is the
      // heading a reader navigates by.
      className="w-full"
      padding="md"
      surface="raised"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          {/* `items-start` and a wrapping title, NOT `truncate`.
              The disc name is the one field somebody came to this
              page to read, and in the Narrow View a truncated
              "EYES WIDE SHU…" is the answer being hidden by the
              layout. Two lines cost nothing here; the row is
              already four deep. */}
          <h3 className="flex min-w-0 items-start gap-2 text-base font-semibold">
            {rip.disctype !== null && (
              <DiscKindLogo
                className="shrink-0"
                kind={rip.disctype}
              />
            )}

            <span
              // The two stand-ins are not the disc's name, so
              // they are not styled as one — a reader scanning a
              // page of titles should see at a glance which rows
              // have one. Muted and regular-weight, NOT italic:
              // the house font's italic `d` is a script form, and
              // "Name not recorded" rendered as "recordea".
              className={
                hasHistoryTitle(rip)
                  ? "[overflow-wrap:anywhere]"
                  : "font-normal text-content-muted [overflow-wrap:anywhere]"
              }
            >
              {historyTitle(rip)}
            </span>
          </h3>

          <p className="mt-0.5 text-sm text-content-muted">
            {historyFinishedText(rip)} ·{" "}
            {historyBayText(rip)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge
            intent={historyOutcomeIntent(rip)}
            size="sm"
          >
            {historyOutcomeText(rip)}
          </Badge>

          {onShowLog !== undefined && rip.has_log && (
            <Button
              appearance="outline"
              onClick={() => {
                onShowLog(rip)
              }}
              size="sm"
            >
              Logs
            </Button>
          )}
        </div>
      </div>

      {/* The measurements, as a row of plain facts. Each one is
          omitted rather than shown as a dash: a rip with no
          recorded duration is a row that says nothing about
          duration, not one that claims zero. */}
      {(duration !== "" ||
        size !== "" ||
        throughput !== "" ||
        readErrors !== "") && (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {duration !== "" && (
            <span className="text-content-muted">
              {duration}
            </span>
          )}

          {size !== "" && (
            <span className="text-content-muted">
              {size}
            </span>
          )}

          {throughput !== "" && (
            <span className="text-content-muted">
              {throughput}
            </span>
          )}

          {/* ⚠️ Beside the success chip, never in place of it.
              See the header — this is ARM #1298. */}
          {readErrors !== "" && (
            <span className="font-medium text-intent-danger-content">
              {readErrors}
            </span>
          )}
        </p>
      )}

      {/* rip-deck's own sentence, rendered and never rewritten.
          It names what happened and, on a failure, where the
          partial output was kept — which is the only text on
          this card a human can act on. */}
      <p className="mt-2 text-sm text-content">
        {rip.outcome_detail}
      </p>

      {rip.destination_path !== null && (
        <p className="mt-1 truncate text-sm text-content-muted">
          {rip.destination_path}
        </p>
      )}

      {/* ⚠️ Only when the engine actually said something.
          `VerdictBadge` already drops an `ok` verdict, but not an
          `unknown` one — and `unknown` is what every row carries
          while the health gate is shut, which is every row on the
          tower today. Rendering it would put an empty grey alert
          under twenty-five cards, which is how a real verdict
          stops being noticed. The gate is the daemon's
          (`historyEndpoint.ts`); this is the card refusing to
          draw a box around nothing. */}
      {rip.verdict !== "unknown" &&
        rip.verdict_message !== null && (
          <VerdictBadge
            confidence={null}
            message={rip.verdict_message}
            verdict={rip.verdict}
          />
        )}
    </Card>
  )
}

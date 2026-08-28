import { Alert, Button, EmptyState } from "@charcuterie/ui"
import { useState } from "react"

import { historyTitle } from "../historyFormat"
import {
  HISTORY_PAGE_SIZE,
  useHistory,
} from "../hooks/useHistory"
import { contentMaxWidthRem } from "../hooks/useLayoutColumns"
import type { HistoryRip } from "../types"
import { AppHeader } from "./AppHeader"
import { HistoryCard } from "./HistoryCard"
import { HistoryControls } from "./HistoryControls"
import { LogModal, type LogTarget } from "./LogModal"

/**
 * Every rip this tower has finished.
 *
 * The owner, 2026-08-27:
 *
 * > *"there's no way to view rips that were previously done
 * > since the last time the image restarted. We do display
 * > current rips from before the image restarted, but I'd like a
 * > way to also see older ones, check by date, etc."*
 *
 * The dashboard shows BAYS — what is in the tower now, and the
 * disc each one last finished with. That is bay memory, and it
 * is overwritten by the next disc. This page reads the permanent
 * log instead (`rip/ripHistory.ts`), so a rip stays findable
 * after its disc has been taken out, its bay reused and the
 * daemon restarted.
 *
 * ## ⚠️ One column at every width, and that is not an oversight
 *
 * The fleet rule is that a list of cards is a GRID. It was
 * narrowed on 2026-08-25: an item that is a title, a summary
 * line and some chips is a READING surface and gets one column,
 * because prose is scanned DOWN a column and a grid makes the
 * eye shift in two directions
 * ([decision](docs/decisions/2026-08-25-a-text-heavy-row-list-is-one-column-narrowing-the-grid-rule.md)).
 * Every row here is exactly that shape — a disc name over a date
 * over rip-deck's own sentence about what happened. There is no
 * poster and no tile for the eye to anchor on, so two columns of
 * it would be two columns of prose.
 *
 * `BayGrid` on the dashboard is still a grid, and correctly so:
 * a bay card has a progress bar, a poster and a tray control.
 * Do not "fix" this page to match it.
 *
 * ## Why there is no auto-refresh
 *
 * A finished rip does not change. `useHistory` fetches when the
 * page asks and when a filter moves, and never on a timer — see
 * its header for why putting this endpoint on the dashboard's
 * five-second poll would be worse than a saving.
 */
export function History() {
  const {
    rips,
    page,
    isPending,
    isError,
    error,
    filters,
    setFilters,
    offset,
    setOffset,
    isFiltered,
    clearFilters,
  } = useHistory()

  const [logTarget, setLogTarget] =
    useState<LogTarget | null>(null)

  const handleShowLog = (rip: HistoryRip) => {
    setLogTarget({
      jobUuid: rip.job_uuid,
      label: historyTitle(rip),
    })
  }

  const total = page?.total ?? 0
  const hasPrevious = offset > 0
  const hasNext = offset + HISTORY_PAGE_SIZE < total

  return (
    <main
      className="mx-auto w-full p-5"
      // The same shell width the dashboard uses at one column, so
      // moving between the two pages does not re-flow the window.
      style={{
        maxWidth: `${String(contentMaxWidthRem(1))}rem`,
      }}
    >
      <AppHeader
        subtitle="Every rip this tower has finished · newest first"
        title="🗜️ Rip Deck · History"
      />

      <div className="mb-4">
        <HistoryControls
          filters={filters}
          isFiltered={isFiltered}
          newestAtMs={page?.newest_at_ms ?? null}
          oldestAtMs={page?.oldest_at_ms ?? null}
          onChange={setFilters}
          onClear={clearFilters}
        />
      </div>

      {isError && page === undefined && (
        <Alert
          description={
            error === null
              ? "The history endpoint did not answer."
              : error.message
          }
          heading="Could not read the history"
          intent="warning"
          label="History"
        />
      )}

      {/* Nothing at all while the first answer is in flight. A
          skeleton for a list that is usually 25 rows long is more
          movement than the wait it covers. */}
      {page !== undefined && rips.length === 0 && (
        <EmptyState
          // ⚠️ No action button. `HistoryControls` already shows
          // "Clear filters" whenever `isFiltered` is true — which
          // is exactly when this state would offer one — and two
          // identical buttons on one screen is the reader working
          // out whether they do the same thing.
          description={
            // ⚠️ Two different states, and the difference is
            // what `total_unfiltered` is for. "Your filter found
            // nothing" is worth a button; "this tower has
            // finished nothing" is not, and offering to clear a
            // filter that is already clear would be a control
            // that does nothing.
            isFiltered
              ? `No rip matches these filters. There are ` +
                `${String(page.total_unfiltered)} in the ` +
                `history altogether.`
              : "Nothing has finished yet. Every rip this tower " +
                "completes is written down here, and it stays " +
                "after the disc comes out."
          }
          heading={
            isFiltered
              ? "No rips match"
              : "No rips in the history"
          }
        />
      )}

      {rips.length > 0 && (
        <>
          <p className="mb-3 text-sm text-content-muted">
            {isFiltered
              ? `${String(total)} of ${String(
                  page?.total_unfiltered ?? total,
                )} rips`
              : `${String(total)} rips`}
          </p>

          {/* One column at every width — see the header. */}
          {/* Named, so a reader tabbing through the page is told
              what the list is — and so a test can ask for a chip
              inside it rather than matching the word "Finished"
              on the outcome filter three inches above. */}
          <ul
            aria-busy={isPending}
            aria-label="Finished rips"
            className="flex list-none flex-col gap-3 p-0"
          >
            {rips.map((rip) => (
              <li key={rip.job_uuid}>
                <HistoryCard
                  onShowLog={handleShowLog}
                  rip={rip}
                />
              </li>
            ))}
          </ul>

          {(hasPrevious || hasNext) && (
            <nav
              aria-label="History pages"
              className="mt-4 flex items-center justify-between gap-3"
            >
              <Button
                appearance="outline"
                isDisabled={!hasPrevious}
                onClick={() => {
                  setOffset(
                    Math.max(0, offset - HISTORY_PAGE_SIZE),
                  )
                }}
              >
                Newer
              </Button>

              <span className="text-sm text-content-muted">
                {String(offset + 1)}–
                {String(
                  Math.min(offset + rips.length, total),
                )}{" "}
                of {String(total)}
              </span>

              <Button
                appearance="outline"
                isDisabled={!hasNext}
                onClick={() => {
                  setOffset(offset + HISTORY_PAGE_SIZE)
                }}
              >
                Older
              </Button>
            </nav>
          )}
        </>
      )}

      <LogModal
        onClose={() => {
          setLogTarget(null)
        }}
        target={logTarget}
      />
    </main>
  )
}

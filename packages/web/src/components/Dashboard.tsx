import { useState } from "react"

import {
  type FixtureName,
  readFixtureName,
} from "../fixture"
import { useBayActions } from "../hooks/useBayActions"
import {
  contentMaxWidthRem,
  useLayoutColumns,
} from "../hooks/useLayoutColumns"
import { useRipDeckState } from "../hooks/useRipDeckState"
import type { Rip } from "../types"
import { DashboardHeader } from "./DashboardHeader"
import { HostSection } from "./HostSection"
import { LogModal, type LogTarget } from "./LogModal"

/**
 * The whole screen: every bay of the tower, in one view.
 *
 * Ported from the viewer's `Dashboard`. The viewer's
 * hide/clear-recent controls are gone — their store lived in
 * `server.py` and rip-deck's `/json` has neither the endpoint nor
 * the `hidden` field, and a dismiss button backed by nothing is
 * worse than no button. What replaced them is the fixture
 * banner: every fixture response carries `is_fake: true`, and
 * saying so in the header is the difference between a demo and a
 * lie about a rack.
 *
 * It also owns the SHELL — the column count and the page's own
 * width — and hands the count down rather than letting each
 * section work it out. Nine bays spread across two buckets that
 * each chose their own column count would read as two different
 * pages stacked on top of each other.
 *
 * `now` is injectable so elapsed text is deterministic in tests.
 */
export function Dashboard({
  fixture,
  now,
}: {
  /**
   * Which fixture scenario to ask for. Defaults to the page's
   * own `?fake=`, which is the daemon's convention verbatim so
   * one URL means one thing against either data source.
   */
  fixture?: FixtureName | null
  now?: number
}) {
  const requested =
    fixture === undefined
      ? readFixtureName(window.location.search)
      : fixture
  const { data, isError, error, dataUpdatedAt } =
    useRipDeckState(requested)
  const { runAction, actionFor } = useBayActions()
  const [logTarget, setLogTarget] =
    useState<LogTarget | null>(null)

  const handleShowLog = (rip: Rip) => {
    if (!rip.logfile) return

    setLogTarget({
      jobUuid: rip.job_uuid,
      label: rip.label ?? rip.job_uuid,
    })
  }

  const tower = data?.ripDeck
  // Bays rather than rendered cards, deliberately. The buckets
  // shuffle every poll as rips finish, and a column count that
  // reflowed the page each time a disc completed would be worse
  // than one that is a card out.
  const { columns, choice, autoColumns, setChoice } =
    useLayoutColumns({ cardCount: tower?.bays.length ?? 0 })

  return (
    <main
      className="mx-auto w-full p-5"
      style={{
        maxWidth: `${String(contentMaxWidthRem(columns))}rem`,
      }}
    >
      <DashboardHeader
        updatedAt={dataUpdatedAt}
        choice={choice}
        autoColumns={autoColumns}
        onChooseColumns={setChoice}
        hasBays={(tower?.bays.length ?? 0) > 0}
      />

      {tower?.is_fake && (
        <div className="mb-4 rounded-xl border border-intent-info-border bg-intent-info-surface px-3.5 py-2 text-base text-intent-info-content">
          Fixture data
          {tower.fixture ? ` · ${tower.fixture}` : ""} —
          this is not the rack.
        </div>
      )}

      {isError && !data && (
        <div className="text-intent-danger-content">
          Rip Deck unreachable
          {error ? `: ${error.message}` : ""}
        </div>
      )}

      {data?.hosts.map((host) => (
        <HostSection
          key={host.host}
          host={host}
          // `rip-deck` describes the same instant as `hosts` — one
          // document, deliberately, so the two halves can never
          // show a nine-bay tower at two different moments and
          // make the disagreement look like a bug in the rips.
          tower={data.ripDeck}
          onShowLog={handleShowLog}
          onAction={(input) => {
            void runAction(input)
          }}
          actionFor={actionFor}
          columns={columns}
          now={now}
        />
      ))}

      {!data && !isError && (
        <div className="text-content-muted">loading…</div>
      )}

      <LogModal
        target={logTarget}
        onClose={() => {
          setLogTarget(null)
        }}
      />
    </main>
  )
}

import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useRef, useState } from "react"

import type {
  TrayCommandReport,
  TrayCommandWord,
} from "../types"
import { useDataSource } from "./useDataSource"
import { RIP_DECK_STATE_KEY } from "./useRipDeckState"

/**
 * Move a tray, and know what happened to every bay it touched.
 *
 * The sibling of `useBayActions`, deliberately NOT part of it.
 * The two differ in the only way that matters here: a bay action
 * is one bay and answers ok/msg, while a tray command can address
 * the whole rack (`open_trays`) and answers a nine-bay
 * REPORT. Folding the second into the first would mean throwing
 * away the per-bay `detail` — and the most important sentence
 * this endpoint can produce is a refusal about ONE bay
 * ("this bay is ripping, nothing was touched") in the middle of a
 * command that succeeded everywhere else.
 *
 * Two callers, by design: the header's "open all complete" button
 * (`open_trays`) and the per-bay ⏏ toggle (`open_bay` /
 * `close_bay`, chosen by `format.nextTrayCommandFor`). They share
 * this hook so one press cannot mean two different things.
 *
 * ⚠️ Which command a bay's toggle sends is NOT decided here.
 * Tray position is unreadable (`nextTrayCommandFor` explains at
 * length), and putting the inference in a hook would hide it from
 * the unit tests that are the only proof it is right.
 */

const EMPTY_DRIVE_IDS: ReadonlySet<string> = new Set()

/**
 * How long a command's answer stays on screen before it clears
 * itself.
 *
 * The report is momentary feedback — "turning the tower off",
 * "opened 8 drives", "REFUSED, slot 4 is ripping" — and the state
 * it describes is already reflected in the dashboard. Left up, it
 * lingered until the next press or a manual refresh (owner,
 * 2026-07-31: *"this message didn't go away until I refreshed the
 * page manually"*). Long enough to read a refusal, short enough
 * not to outstay the thing it answered.
 */
const TRAY_REPORT_DISMISS_MS = 12_000

export function useTrayCommand(): {
  /** driveId omitted for the bulk commands. */
  run: (input: {
    command: TrayCommandWord
    driveId?: string
    /** `rip_bay` only: the name the operator typed. */
    name?: string
  }) => void
  pendingDriveIds: ReadonlySet<string>
  isBulkPending: boolean
  /** The last report, for rendering a result line. */
  lastReport: TrayCommandReport | null
  lastError: string | null
} {
  const dataSource = useDataSource()
  const queryClient = useQueryClient()

  const [pendingDriveIds, setPendingDriveIds] =
    useState<ReadonlySet<string>>(EMPTY_DRIVE_IDS)
  const [isBulkPending, setIsBulkPending] = useState(false)
  const [lastReport, setLastReport] =
    useState<TrayCommandReport | null>(null)
  const [lastError, setLastError] = useState<string | null>(
    null,
  )

  /**
   * What is in flight, in a ref rather than in the state above.
   *
   * The state is for RENDERING; this is the guard, and it has to
   * be readable synchronously. Two clicks in one tick both see
   * the pre-update state, so a state-based check would let both
   * through — and two `open_bay`s is a drawer that opens, closes
   * under the operator's hand, and opens again.
   */
  const inFlightTargets = useRef(new Set<string>())

  // The pending auto-dismiss timer for `lastReport`/`lastError`, so
  // a new press can cancel the previous answer's countdown before
  // starting its own.
  const dismissTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null)

  const run = useCallback(
    (input: {
      command: TrayCommandWord
      driveId?: string
      name?: string
    }) => {
      const { command, driveId, name } = input

      // Keyed on the TARGET, not the command word: two bays may
      // be moving at once, and each wants its own spinner.
      const target = driveId ?? "@bulk"

      if (inFlightTargets.current.has(target)) return

      inFlightTargets.current.add(target)

      const isBulk = driveId === undefined

      if (isBulk) {
        setIsBulkPending(true)
      } else {
        setPendingDriveIds(
          (current) => new Set([...current, driveId]),
        )
      }

      // A new press clears the previous answer rather than
      // leaving it under a spinner. A result line describing the
      // press before last is worse than no line: it reads as the
      // answer to the thing that is still happening.
      if (dismissTimer.current !== null) {
        clearTimeout(dismissTimer.current)
        dismissTimer.current = null
      }
      setLastReport(null)
      setLastError(null)

      // Clear the answer on its own after a while, so a one-off
      // result does not sit on the header until the next press.
      const scheduleDismiss = () => {
        dismissTimer.current = setTimeout(() => {
          setLastReport(null)
          setLastError(null)
          dismissTimer.current = null
        }, TRAY_REPORT_DISMISS_MS)
      }

      // Fire-and-forget on purpose — `run` is called from an
      // onClick and returns void, so a rejected promise here
      // would be an unhandled rejection rather than something a
      // caller could await.
      void (async () => {
        try {
          const report = await dataSource.runTrayCommand({
            command,
            driveId,
            name,
          })

          // Resolved means the daemon ANSWERED, which includes
          // answering "no". A refusal is a report, and the UI
          // renders it from `bays[].detail`.
          setLastReport(report)
          scheduleDismiss()
        } catch (error) {
          setLastError(String(error))
          scheduleDismiss()
        } finally {
          inFlightTargets.current.delete(target)

          if (isBulk) {
            setIsBulkPending(false)
          } else {
            setPendingDriveIds((current) => {
              const next = new Set(current)

              next.delete(driveId)

              return next
            })
          }

          // An opened tray changes what `/json` says about the
          // bay — the disc is in the operator's hand — so the
          // snapshot is refetched rather than waiting out the
          // poll interval. `nextTrayCommandFor` reads that
          // snapshot, so a stale one would point the toggle the
          // wrong way on the very next press.
          await queryClient.invalidateQueries({
            queryKey: [RIP_DECK_STATE_KEY],
          })
        }
      })()
    },
    [dataSource, queryClient],
  )

  return {
    run,
    pendingDriveIds,
    isBulkPending,
    lastReport,
    lastError,
  }
}

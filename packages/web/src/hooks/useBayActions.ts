import { useQueryClient } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

import { bayActionLabel } from "../format"
import type { BayAction } from "../types"
import { useDataSource } from "./useDataSource"
import { RIP_DECK_STATE_KEY } from "./useRipDeckState"

/**
 * Run a bay action and track its per-bay feedback.
 *
 * Ported from the viewer's `useDriveControl`, with three
 * changes, each forced by something rip-deck settled:
 *
 *  1. The action set is `BayAction` — the list the daemon's
 *     tower view publishes PER BAY, in `bay.actions`. The UI
 *     never decides which controls a bay gets; it renders what
 *     the daemon offers. That is what keeps "quarantine is
 *     cleared by a human, never automatically" a property of the
 *     system rather than a convention two components share.
 *  2. The viewer's `eject` / `close` come back as `open_bay` and
 *     `close_bay` — two more `BayAction`s rather than two more
 *     hook members, because rip-deck sends them over the same one
 *     transport. This hook previously said they were gone
 *     because "rip-deck never ejects"; that was a narrow safety
 *     rule ("never eject-LOOP", i.e. no auto-eject in the rip
 *     cycle) widened into a capability ban nobody agreed to —
 *     `docs/HANDOFF-eject-and-open-questions.md` §1. The rule
 *     that survives is honoured a layer up:
 *     `format.trayActionsFor` offers no tray control on a bay
 *     that is starting or ripping.
 *  3. Keying is on `drive_id`, not `srN`. `/dev/srN` reshuffles
 *     on every USB re-enumeration, so feedback keyed on it would
 *     land on the wrong card after the tower is power-cycled.
 *
 * The transport is the data source's problem, not this hook's.
 * Today the live one refuses locally with a message naming MQTT
 * `cmd/drive`, and the mock actually performs the action.
 */

export type BayActionState = {
  action: BayAction
  status: "pending" | "ok" | "fail"
  msg?: string
}

/**
 * Actions that throw away work and therefore ask first.
 *
 * `keep_trying` and `clear_quarantine` do not: the first only
 * suppresses a watchdog, and the second is the human decision
 * quarantine is waiting for, so a dialog asking whether the
 * human meant to be the human is noise.
 *
 * Neither do `open_bay` / `close_bay`, and that is worth saying
 * because a tray command CAN destroy 90 GB — but only on a bay
 * that is ripping, and such a bay is never offered the control
 * (`format.trayActionsFor`) and is refused by the daemon anyway
 * as the first branch of `decideTrayBayAction`. A confirm
 * dialog on the safe cases would be a dialog the operator
 * learns to click through, on the day it matters.
 */
const CONFIRMED_ACTIONS: readonly BayAction[] = [
  "cancel",
  "give_up",
]

/** How long a ✓/✗ stays on the card before clearing itself. */
const FEEDBACK_LINGER_MS = 5_000

export function useBayActions() {
  const dataSource = useDataSource()
  const queryClient = useQueryClient()
  const [stateByDriveId, setStateByDriveId] = useState<
    Record<string, BayActionState>
  >({})
  const timers = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({})

  // Clear the linger timers on unmount. The viewer left these
  // running; here they would keep a test file's event loop alive
  // for five seconds after the last assertion, which is the same
  // class of "the suite passes and then hangs" HANDOFF §8 warns
  // about for SSE mocks.
  useEffect(() => {
    const pending = timers.current

    return () => {
      for (const timer of Object.values(pending)) {
        clearTimeout(timer)
      }
    }
  }, [])

  const runAction = useCallback(
    async (input: {
      driveId: string
      label: string
      action: BayAction
    }) => {
      const { driveId, label, action } = input

      if (
        CONFIRMED_ACTIONS.includes(action) &&
        !window.confirm(
          `${bayActionLabel(action)} on ${label}? ` +
            "The partial output is kept — cleanup is your " +
            "decision, not Rip-Deck's.",
        )
      ) {
        return
      }

      const existingTimer = timers.current[driveId]

      if (existingTimer) clearTimeout(existingTimer)

      setStateByDriveId((current) => ({
        ...current,
        [driveId]: { action, status: "pending" },
      }))

      let result: { ok: boolean; msg: string }

      try {
        result = await dataSource.runBayAction({
          driveId,
          action,
        })
      } catch (error) {
        result = { ok: false, msg: String(error) }
      }

      setStateByDriveId((current) => ({
        ...current,
        [driveId]: {
          action,
          status: result.ok ? "ok" : "fail",
          msg: result.msg,
        },
      }))

      await queryClient.invalidateQueries({
        queryKey: [RIP_DECK_STATE_KEY],
      })

      timers.current[driveId] = setTimeout(() => {
        setStateByDriveId((current) => {
          const next = { ...current }

          delete next[driveId]

          return next
        })
      }, FEEDBACK_LINGER_MS)
    },
    [dataSource, queryClient],
  )

  const actionFor = useCallback(
    (driveId: string): BayActionState | undefined =>
      stateByDriveId[driveId],
    [stateByDriveId],
  )

  return { runAction, actionFor }
}

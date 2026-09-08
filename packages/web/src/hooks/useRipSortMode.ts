import { useCallback, useState } from "react"

import type { RipSortMode } from "../ripSort"

export const RIP_SORT_MODE_STORAGE_KEY =
  "rip-deck.rip-sort-mode"

export const readStoredRipSortMode = (): RipSortMode => {
  try {
    return window.localStorage.getItem(
      RIP_SORT_MODE_STORAGE_KEY,
    ) === "finishing-soonest"
      ? "finishing-soonest"
      : "slot"
  } catch {
    return "slot"
  }
}

/**
 * The card-order preference. The click still changes this visit
 * if storage is unavailable; persistence is only the second job.
 */
export function useRipSortMode(): {
  mode: RipSortMode
  setMode: (mode: RipSortMode) => void
} {
  const [mode, setStoredMode] = useState<RipSortMode>(
    readStoredRipSortMode,
  )

  const setMode = useCallback((next: RipSortMode) => {
    setStoredMode(next)

    try {
      window.localStorage.setItem(
        RIP_SORT_MODE_STORAGE_KEY,
        next,
      )
    } catch {
      // The in-memory choice above still applies to this visit.
    }
  }, [])

  return { mode, setMode }
}

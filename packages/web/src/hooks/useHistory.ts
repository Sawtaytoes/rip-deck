import {
  keepPreviousData,
  useQuery,
} from "@tanstack/react-query"
import { useState } from "react"

import type {
  HistoryFilters,
  HistoryPage,
  HistoryRip,
} from "../types"
import { useDataSource } from "./useDataSource"

/** The query key the page's filters and offset are folded into. */
export const HISTORY_KEY = "rip-deck-history"

/** How many rows one page holds. The daemon caps this at 200. */
export const HISTORY_PAGE_SIZE = 25

export const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  fromMs: null,
  toMs: null,
  search: "",
  outcome: "all",
}

/**
 * The finished-rip history, and the filters over it.
 *
 * ## Why this is not on the 5-second poll
 *
 * `useRipDeckState` polls `/json` forever because a tower changes.
 * A rip that finished last Tuesday does not, so this is fetched
 * when the page mounts and again when a filter moves, and never
 * on a timer. That is not only a saving: the endpoint reads a log
 * off disk and joins two files per row, and putting that on a
 * twelve-times-a-minute loop would be a filesystem walk between
 * the browser and the bay table — the exact thing `useLeftovers`
 * refuses for the same reason.
 *
 * ## Why the previous page is kept while the next loads
 *
 * `keepPreviousData`. Typing in the search box re-queries on
 * every keystroke, and without it the list would blank between
 * each one — so the thing you are reading disappears exactly
 * while you are refining what you asked for. With it the old rows
 * stay put and `isPending` says a newer answer is coming.
 *
 * ## The date conversion, and why it happens HERE
 *
 * A date the reader picks is a LOCAL day. The daemon accepts a
 * bare `YYYY-MM-DD` and resolves it in its own zone, which is
 * right for `curl` and wrong for a browser somewhere else — so
 * `toDayStartMs` / `toDayEndMs` turn the picked day into an
 * instant before it is sent, and the two never have to agree
 * about a zone. See `httpDataSource.fetchHistory`.
 */

/** Local midnight at the start of an ISO `YYYY-MM-DD`. */
export const toDayStartMs = (
  isoDate: string | null,
): number | null => {
  if (isoDate === null || isoDate === "") return null

  const parts = isoDate.split("-").map(Number)

  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return null
  }

  const [year, month, day] = parts

  return new Date(
    year,
    month - 1,
    day,
    0,
    0,
    0,
    0,
  ).getTime()
}

/**
 * The last millisecond of an ISO `YYYY-MM-DD`, locally.
 *
 * So picking one day at both ends of the range is that whole day
 * rather than an empty instant — the same rule the daemon's own
 * bare-date branch keeps.
 */
export const toDayEndMs = (
  isoDate: string | null,
): number | null => {
  const start = toDayStartMs(isoDate)

  return start === null
    ? null
    : start + 24 * 60 * 60 * 1_000 - 1
}

export function useHistory(): {
  page: HistoryPage | undefined
  rips: HistoryRip[]
  isPending: boolean
  isError: boolean
  error: Error | null
  filters: HistoryFilters
  setFilters: (filters: HistoryFilters) => void
  offset: number
  setOffset: (offset: number) => void
  /** Every filter is at its default, so an empty list is real. */
  isFiltered: boolean
  clearFilters: () => void
} {
  const dataSource = useDataSource()
  const [filters, setStoredFilters] =
    useState<HistoryFilters>(EMPTY_HISTORY_FILTERS)
  const [offset, setOffset] = useState(0)

  const query = useQuery({
    queryKey: [
      HISTORY_KEY,
      filters.fromMs,
      filters.toMs,
      filters.search,
      filters.outcome,
      offset,
    ],
    queryFn: () =>
      dataSource.fetchHistory({
        filters,
        limit: HISTORY_PAGE_SIZE,
        offset,
      }),
    placeholderData: keepPreviousData,
  })

  return {
    page: query.data,
    rips: query.data?.rips ?? [],
    isPending: query.isPending || query.isPlaceholderData,
    isError: query.isError,
    error: query.error,
    filters,
    // Any filter change resets to the first page. Keeping the
    // offset would leave a narrowed search on page 3 of a result
    // that now has one page, i.e. looking at nothing.
    setFilters: (next) => {
      setStoredFilters(next)
      setOffset(0)
    },
    offset,
    setOffset,
    isFiltered:
      filters.fromMs !== null ||
      filters.toMs !== null ||
      filters.search !== "" ||
      filters.outcome !== "all",
    clearFilters: () => {
      setStoredFilters(EMPTY_HISTORY_FILTERS)
      setOffset(0)
    },
  }
}

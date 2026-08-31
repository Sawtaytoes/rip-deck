import {
  Button,
  DatePicker,
  Field,
  SearchInput,
  SegmentedControl,
} from "@charcuterie/ui"

import {
  toDayEndMs,
  toDayStartMs,
} from "../hooks/useHistory"
import type { HistoryFilters } from "../types"

/**
 * The three ways to narrow the history, and the button that
 * undoes all of them.
 *
 * ## Why a date RANGE and not a "last 30 days" number
 *
 * The owner asked to *"check by date"*, and the thing he is
 * checking against is a physical stack of discs — "these went
 * through on the Tuesday". A relative window cannot answer that.
 * `DatePicker`'s presets are still there for the common case,
 * because "last 7 days" is the other half of the same question.
 *
 * ## Why the picker is bounded by the log's own span
 *
 * `minValue` / `maxValue` come from `oldest_at_ms` /
 * `newest_at_ms`, so a day outside the history cannot be
 * selected at all. Without them the calendar offers 2019 as
 * readily as last week, and every one of those clicks answers
 * "nothing found" — which reads as a broken filter rather than
 * an empty month.
 *
 * ## Why it is two rows and not one
 *
 * The page is a reading column, capped at 56rem by
 * `contentMaxWidthRem(1)` — the same cap the dashboard uses at
 * one column, so moving between the two does not re-flow the
 * window. A range picker is two date inputs and the word "to",
 * which is most of that width on its own, so all three controls
 * on one line is 1030px of controls in an 856px column and every
 * one of them wraps into a stack three deep.
 *
 * So the split is DECLARED rather than left to `flex-wrap`: the
 * two controls reached for most — a name and an outcome — share
 * the first row, and the date range gets the second. Widening the
 * column to fit one row instead would trade a legible list for a
 * tidy toolbar, which is the wrong way round.
 *
 * ## ⚠️ No native `<select>` anywhere here
 *
 * The outcome filter is a `SegmentedControl` — three mutually
 * exclusive words, all worth seeing at once. A native `<select>`
 * paints as the OS widget on Windows and is deprecated
 * fleet-wide
 * ([decision](docs/decisions/2026-08-20-listbox-is-the-picker-in-every-owned-app-and-native-select-is-a-hatch-we-have-never-needed.md));
 * a `Picker` would be right for a long list and is the wrong
 * shape for three.
 */

const ClearIcon = () => (
  <svg
    aria-hidden="true"
    className="size-4"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
  >
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

/** Local midnight as `YYYY-MM-DD`, for the picker's own value. */
const toIsoDay = (
  epochMs: number | null,
): string | null => {
  if (epochMs === null) return null

  const at = new Date(epochMs)
  const month = String(at.getMonth() + 1).padStart(2, "0")
  const day = String(at.getDate()).padStart(2, "0")

  return `${String(at.getFullYear())}-${month}-${day}`
}

/** The label, on the `Field` and on the picker, deliberately equal. */
const DATE_LABEL = "Finished between"

const OUTCOME_ITEMS = [
  { label: "All", value: "all" },
  { label: "Finished", value: "completed" },
  // "Not finished" covers `needs_attention` as well as `failed`,
  // which is the daemon's own rule: a bay flagged for a human is
  // not a rip that worked. See `historyEndpoint.isSuccessful`.
  { label: "Not finished", value: "failed" },
] as const

export function HistoryControls({
  filters,
  onChange,
  isFiltered,
  onClear,
  oldestAtMs,
  newestAtMs,
}: {
  filters: HistoryFilters
  onChange: (filters: HistoryFilters) => void
  isFiltered: boolean
  onClear: () => void
  /** The log's own span. Null before the first answer lands. */
  oldestAtMs: number | null
  newestAtMs: number | null
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field className="min-w-56 flex-1" label="Search">
          <SearchInput
            clearIcon={<ClearIcon />}
            onChange={(event) => {
              onChange({
                ...filters,
                search: event.currentTarget.value,
              })
            }}
            onClear={() => {
              onChange({ ...filters, search: "" })
            }}
            placeholder="Disc name, bay, drive id…"
            size="sm"
            value={filters.search}
          />
        </Field>

        <SegmentedControl
          items={OUTCOME_ITEMS}
          label="Outcome"
          onChange={(value) => {
            onChange({
              ...filters,
              outcome:
                value === "completed" || value === "failed"
                  ? value
                  : "all",
            })
          }}
          selectedValue={filters.outcome}
        />
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        {/* Wrapped in a `Field` for the VISIBLE label. `DatePicker`'s
          own `label` names the control and the calendar dialog for
          a screen reader and draws nothing, and its docstring says
          to pass the same text as the `Field`'s — the same name,
          which is what WCAG 2.5.3 wants. */}
        <Field label={DATE_LABEL}>
          <DatePicker
            isRange
            label={DATE_LABEL}
            maxValue={toIsoDay(newestAtMs) ?? undefined}
            minValue={toIsoDay(oldestAtMs) ?? undefined}
            size="sm"
            onChange={(value) => {
              // A range picker hands back a `DateRange`; the string
              // arm is the single-date mode this one never uses.
              if (
                value === null ||
                typeof value === "string"
              ) {
                onChange({
                  ...filters,
                  fromMs: null,
                  toMs: null,
                })

                return
              }

              onChange({
                ...filters,
                fromMs: toDayStartMs(value.start),
                // The LAST millisecond of the closing day, so
                // picking one day at both ends is that whole day
                // rather than an empty instant.
                toMs: toDayEndMs(value.end),
              })
            }}
            value={{
              end: toIsoDay(filters.toMs),
              start: toIsoDay(filters.fromMs),
            }}
          />
        </Field>

        {/* Only when there is something to undo. A permanently
          visible Clear teaches the eye to skip the place the real
          one appears — the same argument `LeftoverRips` makes for
          hiding an empty panel. */}
        {isFiltered && (
          <Button appearance="outline" onClick={onClear}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}

import type { SegmentedItem } from "@charcuterie/ui"
import { SegmentedControl } from "@charcuterie/ui"

import {
  COLUMN_CHOICES,
  type ColumnChoice,
} from "../hooks/useLayoutColumns"

/**
 * The group's name, said once and used twice — as the visible word
 * and as the control's accessible name. Two literals is how those
 * two drift apart.
 */
const GROUP_LABEL = "columns"

const toChoice = (value: string): ColumnChoice =>
  value === "auto" ? "auto" : Number(value)

/**
 * The owner's override on the column count.
 *
 * > "maybe we could have a width selection somewhere at the top
 * > and store that value in LocalStorage or be smart about it"
 *
 * Both, and in that order: the picker is the answer when the
 * heuristic guesses wrong about a window nobody anticipated, and
 * `auto` is what it does the rest of the time.
 *
 * ⚠️ **`auto` is a choice in the same row, always.** A control
 * that only offers numbers once a number has been picked is a
 * one-way door: the owner tries `4`, dislikes it, and now has no
 * way back to the mode that adapts except clearing site data. So
 * `auto` sits first, is styled like its neighbours, and shows the
 * count it is currently choosing — which is also the fastest way
 * to tell that the heuristic is doing something sensible.
 *
 * ## What M5 changed, and it is not the styling
 *
 * This was five `<button aria-pressed>` inside a `<fieldset>`.
 * That is the **toolbar of independent toggles** pattern: nothing
 * in it says the five are mutually exclusive, so a screen reader
 * announced "auto, pressed" with no "1 of 5" and no clue that
 * pressing another one un-presses this one. It is a `radiogroup`
 * now, arrow-navigable, from `@charcuterie/ui`.
 *
 * **`selectedValue` is initial, not controlled**, which is
 * Charcuterie's thesis and works here because nothing else ever
 * moves this value: the first render reads the stored choice, and
 * every change after that starts at `onChange`. `useLayoutColumns`
 * keeps its own copy for the grid and for `localStorage`; it never
 * pushes one back, so there is no second owner and no echo.
 */
export function ColumnPicker({
  choice,
  autoColumns,
  onChoose,
}: {
  /** Read on the first render only — see above. */
  choice: ColumnChoice
  /** What `auto` resolves to right now, shown on its button. */
  autoColumns: number
  onChoose: (choice: ColumnChoice) => void
}) {
  const items: SegmentedItem[] = COLUMN_CHOICES.map(
    (option) => ({
      label:
        option === "auto"
          ? `auto · ${String(autoColumns)}`
          : String(option),
      value: String(option),
    }),
  )

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-content-muted text-sm">
        {GROUP_LABEL}
      </span>

      <SegmentedControl
        items={items}
        label={GROUP_LABEL}
        onChange={(value) => {
          if (value !== null) onChoose(toChoice(value))
        }}
        selectedValue={String(choice)}
        size="sm"
      />
    </div>
  )
}

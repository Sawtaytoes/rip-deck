import type { SegmentedItem } from "@charcuterie/ui"
import { SegmentedControl } from "@charcuterie/ui"

import type { RipSortMode } from "../ripSort"

const GROUP_LABEL = "order"

const SORT_MODES: readonly SegmentedItem[] = [
  { value: "slot", label: "slot number" },
  {
    value: "finishing-soonest",
    label: "finishing soonest",
  },
]

/** A compact, mutually-exclusive choice from the shared UI. */
export function RipSortModeControl({
  mode,
  onChoose,
}: {
  mode: RipSortMode
  onChoose: (mode: RipSortMode) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-content-muted text-sm">
        {GROUP_LABEL}
      </span>

      <SegmentedControl
        items={SORT_MODES}
        label={GROUP_LABEL}
        onChange={(value) => {
          if (
            value === "slot" ||
            value === "finishing-soonest"
          ) {
            onChoose(value)
          }
        }}
        selectedValue={mode}
        size="sm"
      />
    </div>
  )
}

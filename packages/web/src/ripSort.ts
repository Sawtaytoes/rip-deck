import { isJobActive } from "@rip-deck/contracts"

import type { BayView, Rip } from "./types"

export type RipSortMode = "slot" | "finishing-soonest"

type SortFacts = {
  slot: number | null
  isActive: boolean
  etaSeconds: number | null
}

type Indexed<T> = {
  item: T
  index: number
  facts: SortFacts
}

const validSlot = (slot: number | null): number | null =>
  slot !== null && Number.isFinite(slot) ? slot : null

/**
 * Only a positive, finite ETA on an active rip predicts a finish.
 * A stale ETA on a completed card and a zero/NaN/Infinity value
 * all belong in the fallback group instead.
 */
const validActiveEta = ({
  etaSeconds,
  isActive,
}: SortFacts): number | null =>
  isActive &&
  etaSeconds !== null &&
  Number.isFinite(etaSeconds) &&
  etaSeconds > 0
    ? etaSeconds
    : null

/**
 * Slots are the deterministic fallback. An unknown slot follows
 * every numbered slot, and equal/unknown slots keep their input
 * order through the final index comparison in `sortByMode`.
 */
const compareSlots = (
  left: number | null,
  right: number | null,
): number => {
  const a = validSlot(left)
  const b = validSlot(right)

  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1

  return a - b
}

const compareByMode = <T>(
  left: Indexed<T>,
  right: Indexed<T>,
  mode: RipSortMode,
): number => {
  if (mode === "slot") {
    return (
      compareSlots(left.facts.slot, right.facts.slot) ||
      left.index - right.index
    )
  }

  const leftEta = validActiveEta(left.facts)
  const rightEta = validActiveEta(right.facts)

  if (leftEta !== null && rightEta !== null) {
    return (
      leftEta - rightEta ||
      compareSlots(left.facts.slot, right.facts.slot) ||
      left.index - right.index
    )
  }

  if (leftEta !== null) return -1
  if (rightEta !== null) return 1

  return (
    compareSlots(left.facts.slot, right.facts.slot) ||
    left.index - right.index
  )
}

const sortByMode = <T>(
  items: readonly T[],
  mode: RipSortMode,
  factsOf: (item: T) => SortFacts,
): T[] =>
  items
    .map((item, index) => ({
      item,
      index,
      facts: factsOf(item),
    }))
    .sort((left, right) => compareByMode(left, right, mode))
    .map(({ item }) => item)

/** Sort rip cards without changing the input array. */
export const sortRips = (
  rips: readonly Rip[],
  mode: RipSortMode,
): Rip[] =>
  sortByMode(rips, mode, (rip) => ({
    slot: rip.slot,
    isActive: rip.active,
    etaSeconds: rip.eta_seconds,
  }))

/**
 * Held and quarantined cards have no finish estimate. They use
 * the same slot fallback in both modes.
 */
export const sortBayViews = (
  bays: readonly BayView[],
  mode: RipSortMode,
): BayView[] =>
  sortByMode(bays, mode, (bay) => ({
    slot: bay.slot,
    isActive:
      bay.state.state !== "idle" &&
      isJobActive(bay.state.state),
    etaSeconds: bay.state.eta_seconds,
  }))

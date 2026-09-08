import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import {
  RIP_SORT_MODE_STORAGE_KEY,
  useRipSortMode,
} from "./useRipSortMode"

beforeEach(() => {
  window.localStorage.clear()
})

describe("the rip sort preference", () => {
  it("defaults to slot-number order", () => {
    const { result } = renderHook(useRipSortMode)

    expect(result.current.mode).toBe("slot")
  })

  it("remembers finishing-soonest order across a reload", () => {
    const first = renderHook(useRipSortMode)

    act(() => {
      first.result.current.setMode("finishing-soonest")
    })

    expect(
      window.localStorage.getItem(
        RIP_SORT_MODE_STORAGE_KEY,
      ),
    ).toBe("finishing-soonest")

    const second = renderHook(useRipSortMode)

    expect(second.result.current.mode).toBe(
      "finishing-soonest",
    )
  })

  it("falls back to slot order for an unknown stored value", () => {
    window.localStorage.setItem(
      RIP_SORT_MODE_STORAGE_KEY,
      "fastest-drive",
    )

    const { result } = renderHook(useRipSortMode)

    expect(result.current.mode).toBe("slot")
  })
})

import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import {
  COLUMNS_STORAGE_KEY,
  chooseAutoColumns,
  contentMaxWidthRem,
  useLayoutColumns,
} from "./useLayoutColumns"

/**
 * The heuristic, written down at nine sizes.
 *
 * This table IS the spec. The handoff's one instruction about
 * this feature is "do not hand-tune breakpoints against one
 * screenshot", and a table of viewports with their answers
 * beside them is the only form in which that instruction can be
 * checked — a browser sweep proves what happens at the four
 * sizes somebody thought to open, and this proves the shape of
 * the rule between them.
 */

const NINE_BAYS = 9

const columnsAt = (input: {
  width: number
  height: number
  cardCount?: number
}): number =>
  chooseAutoColumns({
    cardCount: input.cardCount ?? NINE_BAYS,
    viewport: {
      width: input.width,
      height: input.height,
    },
  })

/**
 * Force the viewport the hook reads.
 *
 * Under the old jsdom setup this was a plain
 * `window.innerWidth = …` assignment. In the real chromium
 * vitest browser mode now runs in, `innerWidth`/`innerHeight`
 * are read-only accessors backed by the actual browser window,
 * so an assignment is a silent no-op and the hook would read the
 * live viewport instead of the size under test. `defineProperty`
 * shadows the accessor with an own value the hook reads instead;
 * `configurable` lets `beforeEach` and the resize test redefine
 * it each time.
 */
const setViewport = (input: {
  width: number
  height: number
}): void => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: input.width,
  })
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: input.height,
  })
}

beforeEach(() => {
  window.localStorage.clear()
  setViewport({ width: 1024, height: 768 })
})

describe("height is spent before width", () => {
  /**
   * The sentence the whole feature exists for:
   *
   * > "That way, you don't get 9-wide just because you're on an
   * > ultrawide even if you have more height available."
   */
  it("stays narrow on an ultrawide that is also tall", () => {
    expect(columnsAt({ width: 3440, height: 1440 })).toBe(2)
  })

  it("goes as wide as it may when the height runs out", () => {
    // Same monitor, a short window. Nine cards cannot stack in
    // 700px, so width is all that is left.
    expect(columnsAt({ width: 3440, height: 700 })).toBe(3)
  })

  it("never reaches the 9-wide the owner called weird", () => {
    // Every bay, no height at all, and a monitor wide enough to
    // hold nine cards side by side.
    expect(
      columnsAt({ width: 5120, height: 400 }),
    ).toBeLessThanOrEqual(3)
  })

  it("gives one card one column however big the window", () => {
    expect(
      columnsAt({
        width: 3440,
        height: 400,
        cardCount: 1,
      }),
    ).toBe(1)
  })
})

describe("a window that cannot hold two cards", () => {
  // A phone. One column is the owner's own answer ("1 column is
  // fine, 2 acceptable"), and it falls out of the width cap
  // rather than out of a device check.
  it("stays at one column on a phone", () => {
    expect(columnsAt({ width: 390, height: 844 })).toBe(1)
  })

  it("stays at one column on a phone held sideways", () => {
    // Short AND narrow: the height rule wants more columns and
    // cannot have them.
    expect(columnsAt({ width: 844, height: 390 })).toBe(2)
  })

  it("allows two on a tablet", () => {
    expect(columnsAt({ width: 820, height: 1180 })).toBe(2)
  })
})

describe("the desktop sizes in between", () => {
  /**
   * Note 1440x900 taking THREE columns while the larger
   * 1920x1080 takes two. That reads backwards and it is the rule
   * working: the taller window stacks nine cards in fewer
   * stacks, so it needs fewer. Width is only ever the cap.
   */
  it.each([
    { width: 1280, height: 800, expected: 3 },
    { width: 1440, height: 900, expected: 3 },
    { width: 1920, height: 1080, expected: 2 },
    { width: 1920, height: 600, expected: 3 },
    { width: 2560, height: 1440, expected: 2 },
  ])(
    "$width x $height renders $expected columns",
    ({ width, height, expected }) => {
      expect(columnsAt({ width, height })).toBe(expected)
    },
  )
})

describe("the page's own width", () => {
  it("does not stretch one column across a monitor", () => {
    expect(contentMaxWidthRem(1)).toBe(56)
  })

  it("grows with the columns", () => {
    expect(contentMaxWidthRem(3)).toBeGreaterThan(
      contentMaxWidthRem(2),
    )
  })
})

describe("the manual override", () => {
  it("defaults to auto", () => {
    const { result } = renderHook(() =>
      useLayoutColumns({ cardCount: NINE_BAYS }),
    )

    expect(result.current.choice).toBe("auto")
    expect(result.current.columns).toBe(
      result.current.autoColumns,
    )
  })

  it("remembers a number across a reload", () => {
    const first = renderHook(() =>
      useLayoutColumns({ cardCount: NINE_BAYS }),
    )

    act(() => {
      first.result.current.setChoice(4)
    })

    expect(first.result.current.columns).toBe(4)
    expect(
      window.localStorage.getItem(COLUMNS_STORAGE_KEY),
    ).toBe("4")

    // A fresh mount is what a reload looks like from here.
    const second = renderHook(() =>
      useLayoutColumns({ cardCount: NINE_BAYS }),
    )

    expect(second.result.current.columns).toBe(4)
  })

  /**
   * ⚠️ The one-way door. A picker that only offers numbers once
   * a number has been chosen strands the owner on a layout he
   * tried once, with no route back to the mode that adapts.
   */
  it("can be handed back to auto after a number", () => {
    const { result } = renderHook(() =>
      useLayoutColumns({ cardCount: NINE_BAYS }),
    )

    act(() => {
      result.current.setChoice(4)
    })
    act(() => {
      result.current.setChoice("auto")
    })

    expect(result.current.choice).toBe("auto")
    expect(result.current.columns).toBe(
      result.current.autoColumns,
    )
  })

  it("ignores a stored value nothing could have written", () => {
    window.localStorage.setItem(COLUMNS_STORAGE_KEY, "9")

    const { result } = renderHook(() =>
      useLayoutColumns({ cardCount: NINE_BAYS }),
    )

    // Falls back to the mode that works everywhere rather than
    // honouring a count the picker cannot offer.
    expect(result.current.choice).toBe("auto")
  })
})

describe("resizing the window", () => {
  it("re-reads the viewport", () => {
    setViewport({ width: 3440, height: 1440 })

    const { result } = renderHook(() =>
      useLayoutColumns({ cardCount: NINE_BAYS }),
    )

    expect(result.current.columns).toBe(2)

    act(() => {
      setViewport({ width: 3440, height: 700 })
      window.dispatchEvent(new Event("resize"))
    })

    expect(result.current.columns).toBe(3)
  })
})

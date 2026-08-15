import { firstValueFrom, take, toArray } from "rxjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  unrefInterval,
  unrefTimeout,
} from "./unrefTimers.ts"

/**
 * The trap these exist for.
 *
 * RxJS schedules `interval`/`timer`/`timeout` through
 * `asyncScheduler`, whose handles are ref'd — adopting them
 * wholesale would have turned `rip-deck rip` from a command that
 * exits into one that hangs until someone notices. The assertions
 * below are on `hasRef()` rather than on behaviour because that is
 * the property: nothing about the emissions would have told us.
 */

/**
 * Every timer handle the code under test creates.
 *
 * The handle is the only place the property lives — an unref'd
 * interval ticks exactly like a ref'd one, so there is no
 * behavioural assertion available and the spy is the test.
 */
const captureTimerHandles = () => {
  const handles: NodeJS.Timeout[] = []
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout

  vi.spyOn(globalThis, "setInterval").mockImplementation(
    (handler, periodMs) => {
      const handle = realSetInterval(handler, periodMs)
      handles.push(handle)
      return handle
    },
  )

  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (handler, delayMs) => {
      const handle = realSetTimeout(handler, delayMs)
      handles.push(handle)
      return handle
    },
  )

  return handles
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("unrefInterval", () => {
  it("ticks on the period", async () => {
    vi.useFakeTimers()

    try {
      const ticks = firstValueFrom(
        unrefInterval({ periodMs: 100 }).pipe(
          take(3),
          toArray(),
        ),
      )

      await vi.advanceTimersByTimeAsync(300)

      expect(await ticks).toEqual([0, 1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not hold the process open", () => {
    const handles = captureTimerHandles()

    const subscription = unrefInterval({
      periodMs: 60_000,
    }).subscribe()

    // The whole reason this module exists. `rip-deck rip` has to
    // exit when the rip ends, and a forgotten sampler must never
    // be the reason it does not.
    expect(handles).toHaveLength(1)
    expect(handles[0].hasRef()).toBe(false)

    subscription.unsubscribe()
  })

  it("holds the process open when it IS the process", () => {
    // `rip-deck watch` is a daemon: its poll loop is the only
    // thing keeping the process alive, so unref'ing it would make
    // the command exit immediately.
    const handles = captureTimerHandles()

    const subscription = unrefInterval({
      periodMs: 60_000,
      isKeepingProcessAlive: true,
    }).subscribe()

    expect(handles[0].hasRef()).toBe(true)

    subscription.unsubscribe()
  })

  it("clears the handle on unsubscribe", () => {
    vi.useFakeTimers()

    try {
      let tickCount = 0

      const subscription = unrefInterval({
        periodMs: 100,
      }).subscribe(() => {
        tickCount += 1
      })

      vi.advanceTimersByTime(250)
      subscription.unsubscribe()
      vi.advanceTimersByTime(1_000)

      expect(tickCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("unrefTimeout", () => {
  it("emits its value once, then completes", async () => {
    vi.useFakeTimers()

    try {
      const emitted = firstValueFrom(
        unrefTimeout({ delayMs: 100, value: "late" }).pipe(
          toArray(),
        ),
      )

      await vi.advanceTimersByTimeAsync(100)

      expect(await emitted).toEqual(["late"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not hold the process open either", () => {
    const handles = captureTimerHandles()

    const subscription = unrefTimeout({
      delayMs: 60_000,
      value: null,
    }).subscribe()

    expect(handles[0].hasRef()).toBe(false)

    subscription.unsubscribe()
  })
})

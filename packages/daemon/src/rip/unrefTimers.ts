import { Observable } from "rxjs"

/**
 * Timer sources that do NOT hold the process open.
 *
 * ## Why these exist rather than `interval()` and `timeout()`
 *
 * Every timer in this codebase is `unref()`d, and that is not a
 * stylistic preference: `rip-deck rip` has to exit when the rip
 * ends, and a sampler or a poll loop that nobody remembered to
 * clear must never be the reason it does not. RxJS's own
 * `interval`, `timer` and `timeout` all schedule through
 * `asyncScheduler`, which calls `setInterval`/`setTimeout` and
 * keeps the handle **ref'd** — so adopting them wholesale would
 * have silently converted a CLI that exits into one that hangs.
 *
 * There is no per-subscription way to ask RxJS for an unref'd
 * handle (the only lever is `timeoutProvider`/`intervalProvider`,
 * which are process-global monkey-patches), so the timers are
 * written out. A hand-rolled `Observable` is idiomatic RxJS — the
 * operators that actually earn their place here (`exhaustMap`,
 * `mergeMap`, `raceWith`, `catchError`) still do — and the
 * teardown function gives us the `clearInterval`/`clearTimeout`
 * that the old `finally` blocks had to do by hand.
 *
 * Both are cold: the handle is created on subscribe and cleared on
 * unsubscribe, so a stopped sampler leaves nothing behind.
 */

/**
 * Tick forever, without pinning the event loop.
 *
 * @param isKeepingProcessAlive — this timer IS the process, so it
 * may hold it open. Default false, matching every other timer
 * here; only `rip-deck watch` passes true.
 */
export const unrefInterval = (input: {
  periodMs: number
  isKeepingProcessAlive?: boolean
}): Observable<number> =>
  new Observable<number>((subscriber) => {
    let tickIndex = 0

    const timer = setInterval(() => {
      subscriber.next(tickIndex)
      tickIndex += 1
    }, input.periodMs)

    if (input.isKeepingProcessAlive !== true) timer.unref()

    return () => {
      clearInterval(timer)
    }
  })

/**
 * Emit one value after a delay, then complete.
 *
 * Used as the losing half of a `raceWith` watchdog, which is the
 * shape `sampler.ts` and `watcher.ts` both had hand-rolled as
 * `Promise.race` + a `finally` that cleared the timer. The race
 * loser is unsubscribed by RxJS, which clears the handle — so the
 * bookkeeping that used to be a `try/finally` is now structural.
 */
export const unrefTimeout = <T>(input: {
  delayMs: number
  value: T
}): Observable<T> =>
  new Observable<T>((subscriber) => {
    const timer = setTimeout(() => {
      subscriber.next(input.value)
      subscriber.complete()
    }, input.delayMs)

    timer.unref()

    return () => {
      clearTimeout(timer)
    }
  })

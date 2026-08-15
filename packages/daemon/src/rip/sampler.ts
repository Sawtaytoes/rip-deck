import {
  HEALTH_THRESHOLDS,
  type HealthSample,
  type JobFeatureOutcome,
  type JobFeatureVector,
  type LivenessKindLabel,
} from "@rip-deck/contracts"
import {
  catchError,
  defer,
  EMPTY,
  exhaustMap,
  firstValueFrom,
  from,
  map,
  type Observable,
  of,
  raceWith,
} from "rxjs"
import { sampleDrive } from "../drives/sysfs.ts"
import {
  buildJobFeatureVector,
  createFeatureAccumulator,
  type FeatureAccumulator,
  foldSampleIntoFeatures,
} from "../health/featureVector.ts"
import type { ComputedJobVerdict } from "../health/jobVerdict.ts"
import {
  buildHealthSample,
  createSampleState,
  type DriveCounters,
  type RipContext,
  type SampleState,
} from "../health/sample.ts"
import {
  createNullSampleStore,
  type SampleStore,
} from "../health/sampleStore.ts"
import type { ProgressTracker } from "./progress.ts"
import {
  unrefInterval,
  unrefTimeout,
} from "./unrefTimers.ts"

/**
 * The sampler loop — what finally feeds the health engine.
 *
 * `sampleDrive()` has existed since Stage 1 and nothing has ever
 * called it on a timer, which is why every value in
 * `HEALTH_THRESHOLDS` is still invented after two successful real
 * rips: there was no mechanism producing the data that would let
 * anyone tune them. This is that mechanism. Its deliverable is
 * not an alarm — it is a corpus.
 *
 * ## Why this file lives in `rip/` and not in `health/`
 *
 * `AGENTS.md`: **never block the parent process on a device
 * call.** The whole child-per-drive architecture exists because a
 * drive wedged in D-state would otherwise freeze all nine drives'
 * monitoring AND the API at once, and it warns that "one stray
 * synchronous `fs`/ioctl call in the parent reintroduces exactly
 * the failure the architecture exists to prevent". A timer-driven
 * sampler is the single most likely place to reintroduce it, so
 * the design pushes back in five specific ways:
 *
 *  1. **It is child-side code, and its neighbours say so.**
 *     `rip/ripJob.ts` "IS the per-drive child's whole job", and
 *     this sits beside it. `health/**` — the fold, the
 *     aggregation, the store — contains no device access at all,
 *     so the parent can import the health package to *read* a
 *     corpus without pulling a single device read into its
 *     process.
 *  2. **The device port is injected**, and `defaultSamplerDeps`
 *     is the only binding of it to sysfs. Anything wanting to
 *     sample from somewhere that is not the per-drive child has
 *     to pass its own reader, which makes the decision visible in
 *     the diff rather than implicit in an import.
 *  3. **Nothing here is synchronous.** No `readFileSync`, no
 *     ioctl, no `execSync`. `drives/sysfs.ts` is plain async file
 *     reads by construction — no `TEST UNIT READY`, no SCSI
 *     command — because the kernel keeps those attributes current
 *     on its own.
 *  4. **A read that does not answer is abandoned, not awaited.**
 *     Every read races a watchdog shorter than the sampling
 *     interval, and a second read is never queued behind an
 *     outstanding one. The worst case for a wedged drive is one
 *     dangling file read, not a growing queue of them.
 *  5. **Both timers are `unref()`d**, so a forgotten sampler can
 *     never be the reason a process refuses to exit. RxJS's own
 *     `interval`/`timeout` are ref'd, which is why the two timer
 *     sources come from `unrefTimers.ts` instead — read its
 *     header before reaching for either.
 *
 * ## Why the loop is `exhaustMap` and not a flag
 *
 * The non-overlap rule (3, and the interval arithmetic every
 * derived rate depends on) used to be a mutable `isTickInFlight`
 * boolean that the tick callback set and cleared. `exhaustMap`
 * states it structurally: a tick that arrives while a sample is
 * still running is DROPPED — not queued behind it, which is what
 * `concatMap` would do and what would turn a wedged drive into a
 * backlog of samples all stamped with the wrong instant.
 *
 * The flag survives anyway, because `sampleNow` is also public:
 * a caller forcing a final sample and a timer tick are two
 * sources, and only the flag makes them exclusive of each other.
 *
 * ## Why it is sane at nine drives
 *
 * The owner has asked for nine concurrent rips. Nine samplers do
 * not share a timer, a queue or a process: each per-drive child
 * runs its own, at 2 s, doing three file reads. That is 4.5
 * reads/second across the whole tower, and — the part that
 * matters — a drive wedged in bay 3 costs bay 3's sampler alone.
 * A single shared sampling loop iterating nine drives would have
 * exactly the failure mode the architecture forbids, so it is not
 * one.
 *
 * ## What this does NOT do
 *
 * It raises nothing, kills nothing and tunes nothing. Liveness
 * already owns the alarm (`rip/liveness.ts`), and `AGENTS.md`
 * says not to tune a threshold before ~30 real jobs. There were
 * two when this was written and three when the engine was wired
 * to it. The sampler's job is to make the 30th job's analysis a
 * query.
 *
 * It does not judge either. `stop()` takes an optional `judge`
 * and hands it the sealed vector, but the sampler holds no
 * threshold and reads no verdict — it records the answer and
 * stamps it onto the job's outcome only if the answer says it is
 * publishable. Nothing here decides whether the rip worked;
 * `isRipSuccessful` did that before `stop()` was called and its
 * result travels untouched in `outcome`.
 */

export const SAMPLER_TUNING = {
  /**
   * How long a counter read gets before it is abandoned.
   *
   * Deliberately shorter than `sampleIntervalMs`, so a read that
   * never returns cannot still be running when the next tick
   * fires. sysfs reads are not supposed to be able to hang —
   * that is the entire reason this system reads files instead of
   * issuing SCSI commands — but "not supposed to" is not a
   * guarantee to bet nine drives' monitoring on.
   *
   * This is a data-collection watchdog, NOT a health threshold.
   * It never decides whether a job passes or fails, so the
   * "don't tune before ~30 jobs" rule does not cover it — the
   * same distinction `PROGRESS_TUNING` draws.
   */
  readTimeoutMs: 1_500,
} as const

/** One tick's counter read, however it turned out. */
type CounterReading = {
  counters: DriveCounters | null
  isReadTimedOut: boolean
}

/**
 * The watchdog's answer, and the answer for a drive that already
 * has a read outstanding.
 *
 * Frozen and shared because it is a constant, and because nothing
 * downstream may mutate a reading it was handed.
 */
const READ_TIMED_OUT: CounterReading = Object.freeze({
  counters: null,
  isReadTimedOut: true,
})

export type SamplerDeps = {
  /** The ONLY device access in this module. */
  readCounters: (
    kernelName: string,
  ) => Promise<DriveCounters>
  now: () => number
}

/**
 * The child-side bindings.
 *
 * `sampleDrive` is three `readFile`s against `/sys/block/srN`.
 * It issues no SCSI command and can therefore not be stuck in
 * the 600-second error-recovery path that an ioctl can.
 */
export const defaultSamplerDeps: SamplerDeps = {
  readCounters: sampleDrive,
  now: () => Date.now(),
}

export type SamplerInput = {
  driveId: string
  /** e.g. "sr0". Ephemeral, and stamped on every row as such. */
  kernelName: string
  /** Null when sampling an idle drive, which is the control. */
  jobId: string | null
  discBytes: number
  startedAtMs: number
  /**
   * MakeMKV's parallel view, PULLED at sample time.
   *
   * A closure rather than pushed state, so the sampler reads
   * whatever the rip's tracker holds at that instant and the rip
   * never has to know a sampler exists. Absent means an idle
   * drive.
   */
  readRipContext?: () => RipContext | null
  store?: SampleStore
  onSample?: (sample: HealthSample) => void
  /** Overridable so a test can assert the cadence exactly. */
  sampleIntervalMs?: number
}

/**
 * Judge a sealed job row — `health/jobVerdict.evaluateJobHealth`
 * in practice.
 *
 * Injected rather than imported so this file keeps its shape: the
 * sampler measures and the engine decides, and the sampler still
 * knows nothing about thresholds. It owns the sealed vector and
 * the store, which is why the judging happens at this seam and
 * not after `stop()` has already closed both.
 */
export type JobJudge = (
  vector: JobFeatureVector,
) => ComputedJobVerdict

export type RunningSampler = {
  /**
   * Take one sample now.
   *
   * Exposed so the loop can be driven deterministically, and so
   * a caller can force a final sample at a known moment.
   */
  sampleNow: () => Promise<HealthSample | null>
  /**
   * Seal the corpus and return the job's feature row.
   *
   * `judge` is optional and, when given, is run against the
   * sealed-but-unstamped vector. Its answer is ALWAYS recorded
   * and is stamped onto `outcome.verdictKind` only when the
   * answer says it may be published — see
   * `health/publish.ts`. `outcome.verdictKind` passed in by the
   * caller is the fallback for callers that already know one.
   */
  stop: (
    outcome: JobFeatureOutcome,
    judge?: JobJudge,
  ) => Promise<JobFeatureVector>
  getSampleCount: () => number
}

export const startSampler = (
  input: SamplerInput,
  deps: SamplerDeps = defaultSamplerDeps,
): RunningSampler => {
  const sampleIntervalMs =
    input.sampleIntervalMs ??
    HEALTH_THRESHOLDS.sampleIntervalMs

  const store = input.store ?? createNullSampleStore()

  let state: SampleState = createSampleState()
  let features: FeatureAccumulator =
    createFeatureAccumulator({
      jobId: input.jobId,
      driveId: input.driveId,
      kernelName: input.kernelName,
      discBytes: input.discBytes,
      startedAtMs: input.startedAtMs,
      sampleIntervalMs,
    })

  let isTickInFlight = false
  let isStopped = false
  let outstandingReadCount = 0

  /**
   * One counter read, raced against the watchdog.
   *
   * The loser is not cancelled — a file read has no cancellation
   * — but `raceWith` unsubscribes it, its rejection is already
   * handled, and its result is simply dropped. So the worst case
   * for a wedged drive is one dangling read, not an unhandled
   * rejection and not a stuck loop.
   */
  const counterReading$ = defer(
    (): Observable<CounterReading> => {
      // A read issued by an earlier tick has still not come back,
      // so the drive is not answering. Queueing a second one
      // behind it would turn a wedge into a growing pile of file
      // handles over a three-hour rip, and would tell us nothing
      // the first one will not.
      if (outstandingReadCount > 0)
        return of(READ_TIMED_OUT)

      outstandingReadCount += 1

      // Settled BEFORE the race, so a rejection can never surface
      // as an unhandled rejection after the watchdog has won.
      const read = deps
        .readCounters(input.kernelName)
        .catch(() => null)
        .finally(() => {
          outstandingReadCount -= 1
        })

      return from(read).pipe(
        map(
          (counters): CounterReading => ({
            counters,
            isReadTimedOut: false,
          }),
        ),
        raceWith(
          unrefTimeout({
            delayMs: SAMPLER_TUNING.readTimeoutMs,
            value: READ_TIMED_OUT,
          }),
        ),
      )
    },
  )

  const sampleNow =
    async (): Promise<HealthSample | null> => {
      // Overlap would corrupt the interval arithmetic every
      // derived rate depends on, so a slow tick is skipped rather
      // than allowed to interleave with the next one.
      if (isStopped || isTickInFlight) return null

      isTickInFlight = true

      try {
        const { counters, isReadTimedOut } =
          await firstValueFrom(counterReading$)

        // Read AFTER the counters, so the two halves of a row
        // describe the same instant as closely as they can.
        const atMs = deps.now()

        const folded = buildHealthSample({
          state,
          driveId: input.driveId,
          kernelName: input.kernelName,
          jobId: input.jobId,
          startedAtMs: input.startedAtMs,
          atMs,
          counters,
          context: input.readRipContext?.() ?? null,
          isReadTimedOut,
        })

        state = folded.state
        features = foldSampleIntoFeatures(
          features,
          folded.sample,
        )

        // Queued, never awaited: the sampler must not be slowed by
        // its own bookkeeping, because a late sample corrupts the
        // interval arithmetic it exists to produce.
        store.write(folded.sample)
        input.onSample?.(folded.sample)

        return folded.sample
      } finally {
        isTickInFlight = false
      }
    }

  // The loop. `unrefInterval` rather than RxJS's `interval`
  // because a forgotten sampler must never be the reason a
  // process refuses to exit, and RxJS's timers are ref'd.
  const subscription = unrefInterval({
    periodMs: sampleIntervalMs,
  })
    .pipe(
      exhaustMap(() =>
        defer(sampleNow).pipe(
          // A sampling fault costs one row, never the loop and
          // never the rip. This used to be a `void sampleNow()`
          // in a timer callback, which meant the same fault
          // surfaced as an unhandled rejection instead.
          catchError(() => EMPTY),
        ),
      ),
    )
    .subscribe()

  return {
    sampleNow,
    getSampleCount: () => features.sampleCount,
    stop: async (outcome, judge) => {
      isStopped = true
      subscription.unsubscribe()

      const measured = buildJobFeatureVector({
        accumulator: features,
        endedAtMs: deps.now(),
        outcome,
      })

      // A judging fault costs the verdict, never the rip. Same
      // rule as every other write on this path: this is
      // diagnostics, and losing a three-hour rip to it would be
      // far worse than losing one row of a tuning corpus.
      let computed: ComputedJobVerdict | null = null

      try {
        computed = judge?.(measured) ?? null
      } catch {
        computed = null
      }

      // The gate. An unpublished verdict is recorded beside the
      // evidence and stamped onto nothing — `AGENTS.md` says the
      // thresholds it was reached with are invented, so reporting
      // it would be the confidently-wrong alert the health model
      // exists to prevent.
      const vector =
        computed === null || !computed.isPublished
          ? measured
          : {
              ...measured,
              outcome: {
                ...measured.outcome,
                verdictKind: computed.verdict.kind,
              },
            }

      await store.writeFeatures(vector)

      if (computed !== null) {
        await store.writeComputedVerdict(computed)
      }

      await store.close()

      return vector
    },
  }
}

/**
 * MakeMKV's view of this instant, from the rip's own tracker.
 *
 * Lives here rather than in `rip/ripJob.ts` so that wiring the
 * sampler into a rip is a call rather than a transcription — the
 * fields are nullable and easy to get subtly wrong, and unit C
 * owns `ripJob.ts`.
 *
 * `livenessKind` is optional because the liveness assessment runs
 * on its own timer and the raw `msSince*` numbers here are the
 * evidence that actually matters; the label is a convenience for
 * a later query, not a dependency.
 */
export const buildRipContext = (input: {
  tracker: ProgressTracker
  nowMs: number
  readErrorCount: number | null
  livenessKind?: LivenessKindLabel | null
}): RipContext => {
  const { progress } = input.tracker

  return {
    stageLabel: progress.totalLabel,
    progressFraction: progress.totalFraction,
    currentFraction: progress.currentFraction,
    bytesWritten: progress.bytesWritten,
    ripThroughputBytesPerSec:
      progress.throughputBytesPerSec,
    etaSeconds: progress.etaSeconds,
    etaTrend: progress.etaTrend,
    filesAdded: input.tracker.filesAdded,
    readErrorCount: input.readErrorCount,
    msSinceProgress:
      input.nowMs - input.tracker.lastForwardProgressAtMs,
    msSinceEvent: input.nowMs - input.tracker.lastEventAtMs,
    livenessKind: input.livenessKind ?? null,
  }
}

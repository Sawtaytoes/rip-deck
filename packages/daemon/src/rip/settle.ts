import { inferDiscType } from "@rip-deck/contracts"
import {
  concatMap,
  defer,
  first,
  firstValueFrom,
  map,
  repeat,
  scan,
} from "rxjs"
import { sampleDrive } from "../drives/sysfs.ts"

/**
 * Waiting for a disc to actually be ready.
 *
 * Three layers, because no single one of them is enough and
 * getting this wrong is what produced the flap-storm that killed
 * valid rips on OTHER drives:
 *
 *  1. The udev rule gates on `ENV{ID_CDROM_MEDIA}=="1"`, so
 *     events raised before `cdrom_id` has run never reach us at
 *     all. This is DiscEcho's insight, and it is structural —
 *     it filters the noise before it becomes our problem (E8).
 *  2. A debounce, because a single insertion legitimately raises
 *     several `change` events as the drive spins up and the
 *     kernel re-reads the TOC.
 *  3. `/sys/block/srN/size` stable across a window, which is the
 *     one that actually proves the disc is readable rather than
 *     merely present.
 *
 * Layer 3 is why this costs ZERO device access: the kernel's own
 * disk-event polling keeps `size` current, so we never issue an
 * ioctl. That matters more than it sounds — a `TEST UNIT READY`
 * against a drive whose SCSI host is in error recovery blocks in
 * D-state for up to 600 seconds, and doing that from the parent
 * process would freeze all nine drives' monitoring at once.
 *
 * ## Shape: a stream of readings folded by a pure function
 *
 * The poll is an RxJS chain (`defer` + `repeat({ delay })`) and
 * every decision it makes is `foldSettleRound` — pure, taking the
 * clock as an argument, exactly the idiom `progress.ts` and
 * `liveness.ts` use. The split matters more here than the
 * operators do: the stability window, the give-up and the
 * 1 GiB-sentinel refusal are now a fold with no I/O and no loop
 * in it, and the stream around it only decides *when to read*.
 *
 * The clock and the sleep stay INJECTED rather than moving to an
 * RxJS scheduler. A virtual `deps.now`/`deps.sleep` is what lets
 * the tests assert the six-second debounce and the two-minute
 * give-up exactly and instantly; `TestScheduler` would have
 * replaced that with marble arithmetic for no gain.
 */

export const SETTLE_TUNING = {
  /** Ignore further events for this long after the first. */
  debounceMs: 6_000,
  /** `size` must hold this value across this window. */
  sizeStableMs: 2_000,
  /** How often to re-read `size` while settling. */
  pollIntervalMs: 500,
  /** Give up after this long and report needs-attention. */
  timeoutMs: 120_000,
} as const

export type SettleResult =
  | {
      kind: "ready"
      sizeSectors: number
      capacityBytes: number
      discType: ReturnType<typeof inferDiscType>
    }
  /** Tray is empty, or the disc is unreadable. */
  | { kind: "no_media" }
  /** Size never stopped moving. Do NOT eject — flag it (B3). */
  | { kind: "timed_out"; lastSizeSectors: number | null }

export type SettleDeps = {
  readSizeSectors: (
    kernelName: string,
  ) => Promise<number | null>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const defaultDeps: SettleDeps = {
  readSizeSectors: async (kernelName) =>
    (await sampleDrive(kernelName)).sizeSectors,
  sleep: (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

/** One poll round: a reading, or the two minutes running out. */
type SettleRound =
  | { kind: "expired" }
  | {
      kind: "read"
      sizeSectors: number | null
      atMs: number
    }

/**
 * What the poll has learned so far.
 *
 * `stableValue` is `number | null | undefined` on purpose, and
 * seeded `undefined` rather than `null`, because `null` is a REAL
 * reading — it means the size attribute was unreadable. Seeding
 * it with null made an unreadable drive compare equal on the very
 * first pass, so `stableSince` was never set and the poll could
 * only ever time out. An empty drive would have taken the full
 * two minutes to report "no disc".
 */
type SettleProgress = {
  sizeSectors: number | null
  stableValue: number | null | undefined
  stableSince: number | null
  isSizeStable: boolean
}

/** A round's reading, and the verdict it produced (or null). */
type SettleStep = {
  progress: SettleProgress
  result: SettleResult | null
}

const createSettleStep = (): SettleStep => ({
  progress: {
    sizeSectors: null,
    stableValue: undefined,
    stableSince: null,
    isSizeStable: false,
  },
  result: null,
})

/**
 * Layer 3, as a pure fold.
 *
 * A changed reading restarts the window rather than narrowing it:
 * a disc whose size is still moving has not settled, however long
 * it has been moving for.
 */
const foldSizeReading = (input: {
  progress: SettleProgress
  sizeSectors: number | null
  atMs: number
}): SettleProgress =>
  input.sizeSectors !== input.progress.stableValue
    ? {
        sizeSectors: input.sizeSectors,
        stableValue: input.sizeSectors,
        stableSince: input.atMs,
        isSizeStable: false,
      }
    : {
        sizeSectors: input.sizeSectors,
        stableValue: input.progress.stableValue,
        stableSince: input.progress.stableSince,
        isSizeStable:
          input.progress.stableSince !== null &&
          input.atMs - input.progress.stableSince >=
            SETTLE_TUNING.sizeStableMs,
      }

/** Is there a verdict yet? Null means keep polling. */
const settleVerdict = (
  progress: SettleProgress,
): SettleResult | null => {
  if (!progress.isSizeStable) return null

  if (progress.sizeSectors === null) {
    return { kind: "no_media" }
  }

  const discType = inferDiscType(progress.sizeSectors)

  // The kernel reports a 1 GiB sentinel (2097151 sectors) for an
  // empty or unreadable tray — a stable value, so it arrives here
  // looking exactly like a settled disc.
  if (discType === "none") return { kind: "no_media" }

  return {
    kind: "ready",
    sizeSectors: progress.sizeSectors,
    capacityBytes: progress.sizeSectors * 512,
    discType,
  }
}

const foldSettleRound = (
  step: SettleStep,
  round: SettleRound,
): SettleStep => {
  if (round.kind === "expired") {
    // B3: fail closed. The size never stopped moving, so the disc
    // is flagged and left exactly where it is.
    return {
      progress: step.progress,
      result: {
        kind: "timed_out",
        lastSizeSectors: step.progress.stableValue ?? null,
      },
    }
  }

  const progress = foldSizeReading({
    progress: step.progress,
    sizeSectors: round.sizeSectors,
    atMs: round.atMs,
  })

  return { progress, result: settleVerdict(progress) }
}

/**
 * Block until the media in a drive has settled.
 *
 * Note what this does NOT do on failure: it never ejects. An
 * unidentified or unstable disc stays exactly where it is and
 * gets marked needs-attention (B3). Auto-ejecting is what caused
 * the flap-storm — each eject raised fresh events, which
 * triggered fresh handling, which ejected again, and the churn
 * took down rips in neighbouring bays that were doing nothing
 * wrong.
 */
export const waitForSettledMedia = async (
  input: {
    kernelName: string
  },
  deps: SettleDeps = defaultDeps,
): Promise<SettleResult> => {
  const { debounceMs, pollIntervalMs, timeoutMs } =
    SETTLE_TUNING

  const startedAtMs = deps.now()

  // The clock is checked BEFORE the read, not after it, so a
  // drive that has run out its two minutes is not asked one more
  // time on the way out.
  const round$ = defer<Promise<SettleRound>>(async () =>
    deps.now() - startedAtMs >= timeoutMs
      ? { kind: "expired" }
      : {
          kind: "read",
          sizeSectors: await deps.readSizeSectors(
            input.kernelName,
          ),
          atMs: deps.now(),
        },
  )

  return await firstValueFrom(
    // Layer 2. One insertion raises several events; acting on the
    // first one reads a size the kernel has not finished
    // updating, so nothing is read until the debounce is out.
    defer(() => deps.sleep(debounceMs)).pipe(
      concatMap(() =>
        round$.pipe(
          repeat({
            delay: () => deps.sleep(pollIntervalMs),
          }),
          scan(foldSettleRound, createSettleStep()),
          // `first` is the loop's exit: it completes the chain on
          // the first verdict, which unsubscribes `repeat` and
          // stops the polling. There is no separate `isDone` flag
          // to forget to set.
          first(
            (
              step,
            ): step is SettleStep & {
              result: SettleResult
            } => step.result !== null,
          ),
          map((step) => step.result),
        ),
      ),
    ),
  )
}

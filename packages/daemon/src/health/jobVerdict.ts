import {
  HEALTH_FEATURE_SCHEMA_VERSION,
  HEALTH_THRESHOLDS,
  hubChainOf,
  type JobFeatureVector,
  makeVerdict,
  type Verdict,
} from "@rip-deck/contracts"
import type { DriveBaseline } from "./baseline.ts"
import {
  type DriveObservation,
  evaluateHealth,
} from "./engine.ts"
import { IS_HEALTH_VERDICT_PUBLISHED } from "./publish.ts"

/**
 * What the engine would have said about one finished job.
 *
 * `health/engine.ts` has been written, unit-tested and called by
 * nothing since it was merged. This is the wire — the adapter
 * that turns the row the sampler already seals into the
 * observation the engine already understands, so the engine runs
 * on the real path for every rip.
 *
 * ## Why the feature vector, and not the live rip
 *
 * The engine could have been fed from `ripJob`'s in-flight state.
 * Feeding it the SEALED VECTOR instead buys the one thing this
 * unit is actually for: the same function, over the same input
 * shape, answers the question retrospectively. Point a script at
 * thirty `*.features.json` files and `evaluateJobHealth` tells
 * you what the engine would have said about each of them, months
 * later, without a disc and without a re-rip. `AGENTS.md`
 * promises exactly that — "tuning is a database query rather
 * than a re-rip" — and a wire that only worked forwards would
 * have broken the promise the vectors are persisted to keep.
 *
 * ## What this evaluation can and cannot conclude
 *
 * It is ONE drive's job, judged after the fact, so three of the
 * engine's verdicts are structurally out of reach here and that
 * is correct rather than a gap:
 *
 *  - **`hub_fault`** needs `hubCorrelationMinDrives` (2) drives
 *    collapsing together. One observation can never satisfy it.
 *    A hub fault is a cross-drive judgement and there is no
 *    cross-drive store yet, so inferring one from a single bay
 *    would be a guess wearing a `confirmed` badge.
 *  - **`drive_failing`** needs cross-disc history, and
 *    **`enumeration_flap`** needs enumeration events. Neither is
 *    recorded in the corpus, so both are passed as "no evidence"
 *    rather than as a fabricated zero-with-meaning.
 *  - A disc verdict stays `suspected` unless a second drive has
 *    agreed, which nothing tracks yet either. Per `AGENTS.md`
 *    only `confirmed` may announce, so this path cannot produce
 *    an announceable disc verdict even with the gate open.
 *
 * ## It does not decide whether the rip worked
 *
 * `isRipSuccessful` is the sole authority on that, and it has
 * already run by the time this does. Nothing here is fed back
 * into the summary — a verdict of `ok` over a rip that had read
 * errors changes nothing about that rip's failure, which is the
 * rule in `AGENTS.md` that overrides everything else.
 */

/**
 * The engine's answer for one job, recorded whether or not it is
 * allowed to be reported.
 *
 * Written to `<jobUuid>.verdict.json` beside the feature vector.
 * It carries the observation AND the thresholds it was judged
 * against, because "what would the engine have said" is
 * unanswerable later without knowing which numbers it said it
 * with — the same reason the samples carry a schema version.
 */
export type ComputedJobVerdict = {
  schemaVersion: number
  jobId: string | null
  driveId: string
  /** The instant the job ended, which is when this was judged. */
  computedAtMs: number
  /**
   * Whether this verdict was reported anywhere, or merely
   * recorded. `false` for every job until `HEALTH_THRESHOLDS` is
   * tuned — see `IS_HEALTH_VERDICT_PUBLISHED`.
   */
  isPublished: boolean
  verdict: Verdict
  /** Exactly what the engine was shown. */
  observation: DriveObservation
  /** Exactly what it judged against. */
  thresholds: Readonly<typeof HEALTH_THRESHOLDS>
}

export type JobEvidence = {
  /**
   * Read-error sector offsets, from MakeMKV and kmsg.
   *
   * The one input the feature vector cannot carry: it keeps a
   * read-error COUNT, and scratch-vs-dirt is a question about
   * where the errors were. `ripJob` has them in
   * `RipObservations`, so it passes them through; a retrospective
   * replay over old vectors has none and gets
   * `insufficient_data`, which the engine handles by declining to
   * name a pattern rather than by guessing one.
   */
  errorLbas?: number[]
  /** MakeMKV reported an expired or invalid key (D8). */
  hasKeyExpired?: boolean
  /**
   * The drive's USB port path.
   *
   * Defaults to `driveId`, which IS the port path — the watcher
   * keys every bay by `drive.identity.usbPortPath`. Kept as a
   * separate parameter anyway so that a corpus recorded under a
   * different keying degrades to an empty hub chain (no hub
   * correlation) instead of to a wrong one.
   */
  usbPortPath?: string
  /** This drive's earned throughput baseline, when one exists. */
  baseline?: DriveBaseline | null
}

/**
 * Turn a sealed job row into the observation the engine wants.
 *
 * Pure, and every field is either a direct reading or an
 * explicitly-named retrospective analogue of a live one:
 *
 *  - `recentThroughput` is the job's MEDIAN drive-side rate. A
 *    finished job has no "recent"; p50 is the honest whole-job
 *    stand-in, and an absent one yields an empty array, which
 *    `isCollapsed` reads as "no evidence of collapse" rather than
 *    as a collapse.
 *  - `msSinceProgress` is `longestNoProgressMs` — the longest gap
 *    the job ever had. Asking "did this job ever stall" is the
 *    retrospective form of "is it stalled now".
 *  - `ioErrorDelta` is the job total, not a window's.
 */
export const buildDriveObservation = (input: {
  vector: JobFeatureVector
  evidence?: JobEvidence
}): DriveObservation => {
  const { vector } = input
  const evidence = input.evidence ?? {}
  const usbPortPath = evidence.usbPortPath ?? vector.driveId

  const throughput = vector.driveThroughputP50BytesPerSec

  return {
    driveId: vector.driveId,
    hubChain: hubChainOf(usbPortPath),
    recentThroughput:
      throughput === null ? [] : [throughput],
    avgMsPerRead: vector.avgMsPerReadP50,
    ioErrorDelta: vector.ioErrorTotalDelta,
    errorLbas: evidence.errorLbas ?? [],
    msSinceProgress: vector.longestNoProgressMs,
    // Not measured anywhere yet. Zero is the "no evidence"
    // value the engine's flap check already treats as such,
    // and it is the only honest thing to pass.
    enumerationEvents: 0,
    hasKeyExpired: evidence.hasKeyExpired ?? false,
    // Both require cross-job memory that does not exist. False
    // means "nothing agrees with this yet", which keeps disc
    // verdicts at `suspected` — the conservative side.
    hasSecondDriveAgreement: false,
    hasCrossDiscHistory: false,
  }
}

/**
 * Run the engine over one finished job.
 *
 * `isPublished` defaults to the gate constant, so production
 * gets the closed gate without asking. It is a parameter so a
 * test can prove the wire genuinely carries the engine's answer
 * when the gate opens — the switch is tested before it is ever
 * thrown.
 */
export const evaluateJobHealth = (input: {
  vector: JobFeatureVector
  evidence?: JobEvidence
  isPublished?: boolean
}): ComputedJobVerdict => {
  const { vector } = input
  const observation = buildDriveObservation({
    vector,
    evidence: input.evidence,
  })

  const baseline = input.evidence?.baseline ?? null
  const baselines = new Map<string, DriveBaseline>()
  if (baseline !== null) {
    baselines.set(baseline.driveId, baseline)
  }

  const result = evaluateHealth({
    observations: [observation],
    baselines,
    // The shallowest node above this drive. Unused with a single
    // observation — `findFaultyHub` needs two collapsed drives
    // before a hub is ever named — but passing the real value
    // costs nothing and keeps the call honest if that changes.
    towerRootPortPath:
      observation.hubChain[0] ?? observation.driveId,
  })

  const verdict = result.verdictsByDriveId.get(
    observation.driveId,
  )

  return {
    schemaVersion: HEALTH_FEATURE_SCHEMA_VERSION,
    jobId: vector.jobId,
    driveId: vector.driveId,
    computedAtMs: vector.endedAtMs,
    isPublished:
      input.isPublished ?? IS_HEALTH_VERDICT_PUBLISHED,
    // `evaluateHealth` always answers for every observation it
    // was given, so the fallback is unreachable — but a `Map`
    // lookup is optional at the type level and a thrown error
    // here would cost a rip its whole feature row.
    verdict: verdict ?? unjudged(),
    observation,
    thresholds: HEALTH_THRESHOLDS,
  }
}

/**
 * The engine answered for nobody. Unreachable, see above — and
 * `unknown`/`suspected` rather than `ok` if it ever is reached,
 * because "nothing judged this" is not evidence of health.
 */
const unjudged = (): Verdict =>
  makeVerdict("unknown", "suspected", [
    "The health engine returned no verdict for this drive.",
  ])

import type { Verdict } from "@rip-deck/contracts"
import {
  type CorpusReadiness,
  EMPTY_CORPUS,
  readCorpusReadiness,
} from "./corpus.ts"

/**
 * The one switch between MEASURING health and REPORTING it.
 *
 * The engine is wired: `runRipJob` feeds `evaluateHealth` the
 * sealed feature vector of every job, and the answer is written
 * to disk beside that vector. What the answer was not allowed to
 * do was become the job's verdict, because every number it was
 * reached with is invented.
 *
 * `packages/contracts/src/health.ts` — "these are guesses":
 *
 *   > Every number in `HEALTH_THRESHOLDS` is invented. The full
 *   > feature vector is persisted per job precisely so tuning is
 *   > a database query rather than a re-rip. **Do not tune before
 *   > ~30 real jobs** — with fewer you are fitting noise.
 *
 * ## This used to be a hand-written `false`
 *
 * It was a constant somebody had to remember to flip, and the
 * text that shipped alongside it said "there are 3" — a count
 * typed into a comment on the day it happened to be true. Both
 * problems have the same cause: a fact about the state directory
 * was being kept somewhere other than the state directory. So
 * the switch now asks. `corpus.ts` counts `*.features.json` and
 * looks for a job that went badly; this module holds the answer
 * and the rule for what may be done with it.
 *
 * ## The conditions, and which one no program can check
 *
 * Three conditions were named for flipping this by hand. Two are
 * countable and `corpus.ts` counts them:
 *
 *  1. **~30 real jobs of feature vectors exist** in
 *     `$RIP_DECK_STATE_DIR`.
 *  2. **At least one records a job that genuinely went badly.**
 *     Thirty clean rips teach a detector nothing about the thing
 *     it is meant to detect.
 *
 * The third was that `HEALTH_THRESHOLDS` had actually been TUNED
 * from that corpus, rather than merely having survived contact
 * with it. Nothing on disk distinguishes a tuned threshold from
 * a guess that has not changed, so no gate can test it. The
 * owner's decision was to open on the counts and hedge the
 * result instead of adding a manual marker — the honour system,
 * stated plainly rather than enforced badly.
 *
 * `hedged()` is what makes that safe. See its own header.
 *
 * ## The gate latches, and is refreshed rather than polled
 *
 * `refreshHealthGate` is called at daemon start and again after
 * each rip seals its vector — the only two moments the count can
 * change. Every reader after that is a synchronous memory read,
 * so nothing on the watcher poll or the request path ever waits
 * on a `readdir`.
 *
 * Once open it stays open for the life of the process. A corpus
 * cannot un-earn itself, and a gate that could close again would
 * make a card's verdict appear and vanish because somebody
 * tidied the state directory mid-session.
 *
 * ## What an open gate does, and does not do
 *
 * It lets the engine's kind be stamped onto the job's persisted
 * outcome, and it lets `api/towerFeed.ts` show the engine's
 * verdict on the card instead of the `unknown` placeholder. It
 * still does NOT let a verdict decide whether a rip worked:
 * `isRipSuccessful` remains the sole authority on that, and a
 * health verdict can never upgrade a rip that had read errors.
 */

/**
 * Jobs of corpus required before the gate may open.
 *
 * The "~30 real jobs" above, named rather than left in a comment
 * so `corpus.ts` can be handed the number instead of repeating
 * it.
 */
export const HEALTH_TUNING_MIN_JOB_COUNT = 30

let corpus: CorpusReadiness = EMPTY_CORPUS

/**
 * May the engine's answer be reported?
 *
 * Synchronous on purpose — every caller is on the watcher poll,
 * the sampler's seal step or the request path, and none of them
 * may wait on a directory read. `false` until
 * `refreshHealthGate` has run at least once, which is the
 * correct answer for a process that has not looked yet.
 */
export const isHealthVerdictPublished = (): boolean =>
  corpus.isReady

/** The counts behind that answer, for logging and for tests. */
export const readHealthGate = (): CorpusReadiness => corpus

/**
 * Re-count the corpus and latch the gate open if it qualifies.
 *
 * Returns the reading it took, so `main.ts` can say the count
 * out loud at start-up — a corpus that is 12 of 30 is worth
 * seeing in the log, and a directory nobody is writing to is
 * worth noticing before it costs thirty rips.
 */
export const refreshHealthGate = async (input: {
  stateDir: string
  minJobCount?: number
}): Promise<CorpusReadiness> => {
  const reading = await readCorpusReadiness({
    stateDir: input.stateDir,
    minJobCount:
      input.minJobCount ?? HEALTH_TUNING_MIN_JOB_COUNT,
  })

  // Latched. See the header — a corpus cannot un-earn itself.
  corpus = corpus.isReady
    ? { ...reading, isReady: true }
    : reading

  return corpus
}

/** Back to "has not looked yet". For tests only. */
export const resetHealthGate = (): void => {
  corpus = EMPTY_CORPUS
}

/**
 * A verdict as it is allowed to be REPORTED.
 *
 * The gate opens on counts alone, so at the instant it opens the
 * thresholds behind every verdict are still the invented ones.
 * That is tolerable for something shown on a card next to the
 * word "suspected". It is not tolerable for something that wakes
 * the house at 2am, and `isAnnounceable` — the only thing
 * standing between a verdict and MQTT — asks for exactly one
 * property: `confirmed`.
 *
 * So confidence is forced down here, at the single boundary
 * where a verdict stops being a recording and becomes a report.
 * The consequence is precise and intended: **no verdict
 * published by the automatic gate can announce.** It can be
 * read, and it can be wrong, and being wrong costs a glance at a
 * card.
 *
 * `key_expired` loses a little by this — MakeMKV reports it
 * directly (D8) rather than through any threshold, so it was
 * never a guess. Exempting it would mean maintaining a list of
 * which kinds are threshold-free, and a list like that is wrong
 * the first time somebody adds a kind and forgets it. One rule
 * at one boundary is worth the loss.
 *
 * The RECORDED verdict in `<uuid>.verdict.json` is untouched: it
 * keeps whatever the engine actually said, because that file is
 * evidence for tuning, not a report to anybody.
 */
export const hedged = (verdict: Verdict): Verdict =>
  verdict.confidence === "suspected"
    ? verdict
    : { ...verdict, confidence: "suspected" }

/**
 * The one switch between MEASURING health and REPORTING it.
 *
 * The engine is wired: `runRipJob` feeds `evaluateHealth` the
 * sealed feature vector of every job, and the answer is written
 * to disk beside that vector. What the answer is not allowed to
 * do yet is become the job's verdict, because every number it
 * was reached with is invented.
 *
 * `AGENTS.md` — "Health thresholds are guesses":
 *
 *   > Every number in `HEALTH_THRESHOLDS` is invented. The full
 *   > feature vector is persisted per job precisely so tuning is
 *   > a database query rather than a re-rip. **Do not tune before
 *   > ~30 real jobs** — with fewer you are fitting noise.
 *
 * ## The condition that flips this
 *
 * Flip `IS_HEALTH_VERDICT_PUBLISHED` to `true` when, and only
 * when, ALL of the following hold:
 *
 *  1. **~30 real jobs of feature vectors exist** —
 *     `$RIP_DECK_STATE_DIR/*.features.json`, one per rip, on the
 *     tower itself. At the time this was written there were
 *     THREE. Count them before believing anything below.
 *  2. **`HEALTH_THRESHOLDS` has actually been tuned from them**,
 *     rather than merely surviving contact with them. A corpus
 *     nobody queried does not calibrate a guess.
 *  3. The corpus contains at least one job that genuinely went
 *     badly. Thirty clean rips teach a detector nothing about
 *     the thing it is meant to detect.
 *
 * Until then the published verdict stays `unknown`, whose own
 * template says "Not enough information to judge this rip yet" —
 * which is exactly, literally true. Shipping `ok` or
 * `disc_scratched` off guessed thresholds would be the
 * confidently-wrong alert this whole model exists to prevent,
 * and `AGENTS.md` is explicit that `ok` is the default verdict
 * *for an engine deciding with evidence in hand* — which this is
 * not, yet.
 *
 * ## What flipping it does, and does not do
 *
 * It lets the engine's kind be stamped onto the job's persisted
 * outcome. It does NOT wire a verdict into the dashboard payload
 * or into MQTT: the published verdict is built by
 * `api/towerFeed.ts`, which reads no engine output at all, and
 * `isRipSuccessful` remains the sole authority on whether a rip
 * worked. A health verdict can never upgrade a rip that had read
 * errors — see the rule that overrides everything in
 * `AGENTS.md`.
 *
 * Annotated `: boolean` deliberately. Without it the type is the
 * literal `false`, every consumer's other branch narrows to
 * dead code, and the switch stops being one honest line.
 */
export const IS_HEALTH_VERDICT_PUBLISHED: boolean = false

/**
 * Jobs of corpus required before that switch may be flipped.
 *
 * `AGENTS.md`'s "~30 real jobs", named rather than left in a
 * comment so the check can be written as code the day someone
 * wants to automate it.
 */
export const HEALTH_TUNING_MIN_JOB_COUNT = 30

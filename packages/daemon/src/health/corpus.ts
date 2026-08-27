import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { JobFeatureVector } from "@rip-deck/contracts"

/**
 * How much tuning evidence is on disk, counted rather than
 * assumed.
 *
 * `health/publish.ts` used to hold a hand-written `false`, and
 * the paragraph that shipped on every card said "there are 3"
 * — a number typed into a comment on the day it was true. It
 * cannot go stale here: the only source is the state directory
 * itself.
 *
 * ## Why files, and not a counter
 *
 * A counter would have to be written, migrated and kept
 * consistent with a directory that other things already delete
 * from. The vectors ARE the corpus; counting them is one
 * `readdir` and it can never disagree with what a tuning query
 * would find. `sampleStore.ts` writes each one as
 * `<jobUuid>.features.json`, so the glob is the schema.
 *
 * ## The two conditions this can answer, and the one it cannot
 *
 * `publish.ts` names three conditions. Two are countable and
 * both live here:
 *
 *  1. roughly 30 vectors exist;
 *  2. at least one of them records a job that went badly.
 *
 * The third — that somebody actually replaced the guessed
 * thresholds with measured ones — is a human act that leaves no
 * trace a program can read. It is deliberately NOT checked here.
 * What covers it instead is `hedged()` in `publish.ts`: a
 * verdict published on counts alone is always `suspected`, so it
 * can be shown and can never announce.
 */

/** `sampleStore.featureVectorPath`'s suffix, as a glob. */
const FEATURE_FILE_SUFFIX = ".features.json"

export type CorpusReadiness = {
  /** `*.features.json` files found. */
  jobCount: number
  /**
   * How many of them recorded trouble.
   *
   * `-1` when the vectors were not read, which happens whenever
   * `jobCount` is already below the minimum — see
   * `readCorpusReadiness`. Distinguishing "none had trouble"
   * from "nobody looked" matters, because the first is a fact
   * about the corpus and the second is a fact about this
   * function.
   */
  troubledJobCount: number
  isReady: boolean
}

/** Nothing counted, nothing claimed. */
export const EMPTY_CORPUS: CorpusReadiness = {
  jobCount: 0,
  troubledJobCount: -1,
  isReady: false,
}

/**
 * Did this job go badly?
 *
 * Three independent signs, any one of which is enough. They are
 * ORed rather than ranked because the question the corpus has to
 * answer is only "is there a failure in here to learn from",
 * and a rip that succeeded while the drive logged I/O errors is
 * exactly as instructive as one that failed outright.
 *
 *  - the rip failed — `isRipSuccessful` said so, and it is the
 *    sole authority on that;
 *  - MakeMKV counted read errors, which the one rule says is
 *    never a success;
 *  - the kernel's own `ioerr_cnt` moved during the job.
 */
export const isTroubledJob = (
  vector: JobFeatureVector,
): boolean =>
  !vector.outcome.isSuccessful ||
  vector.readErrorCount > 0 ||
  vector.ioErrorTotalDelta > 0

/**
 * Count the corpus in `stateDir`.
 *
 * Never throws. A missing directory, an unreadable file and a
 * half-written JSON document all read as "that is not a usable
 * vector", which is the same conservative direction every other
 * write on this path takes: losing a row of the tuning corpus is
 * bad, and opening a gate because a file could not be parsed
 * would be far worse.
 *
 * Reads file CONTENTS only when the count already clears the
 * minimum. Below it the answer is `false` whatever the contents
 * say, so opening 3 files to confirm a foregone conclusion is
 * work with no reader.
 */
export const readCorpusReadiness = async (input: {
  stateDir: string
  minJobCount: number
}): Promise<CorpusReadiness> => {
  const names = await readdir(input.stateDir).catch(
    () => [] as string[],
  )

  const featureFiles = names.filter((name) =>
    name.endsWith(FEATURE_FILE_SUFFIX),
  )

  if (featureFiles.length < input.minJobCount) {
    return {
      jobCount: featureFiles.length,
      troubledJobCount: -1,
      isReady: false,
    }
  }

  const vectors = await Promise.all(
    featureFiles.map((name) =>
      readVector(join(input.stateDir, name)),
    ),
  )

  const usable = vectors.filter(
    (vector): vector is JobFeatureVector => vector !== null,
  )

  const troubledJobCount =
    usable.filter(isTroubledJob).length

  return {
    jobCount: usable.length,
    troubledJobCount,
    // Both countable conditions, and the second is not a
    // formality: thirty clean rips teach a detector nothing
    // about the thing it is built to detect.
    isReady:
      usable.length >= input.minJobCount &&
      troubledJobCount > 0,
  }
}

/** One vector, or null if it could not be read as one. */
const readVector = async (
  path: string,
): Promise<JobFeatureVector | null> => {
  const text = await readFile(path, "utf8").catch(
    () => null,
  )

  if (text === null) return null

  try {
    const parsed: unknown = JSON.parse(text)

    // A shape check rather than a cast. These files are written
    // by builds that may be months apart, and a vector missing
    // the fields `isTroubledJob` reads would otherwise count as
    // a clean job — the one direction that could open the gate
    // on evidence that is not there.
    return isFeatureVector(parsed) ? parsed : null
  } catch {
    return null
  }
}

const isFeatureVector = (
  value: unknown,
): value is JobFeatureVector => {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const vector = value as Partial<JobFeatureVector>

  return (
    typeof vector.readErrorCount === "number" &&
    typeof vector.ioErrorTotalDelta === "number" &&
    typeof vector.outcome === "object" &&
    vector.outcome !== null &&
    typeof vector.outcome.isSuccessful === "boolean"
  )
}

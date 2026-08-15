import {
  createWriteStream,
  type WriteStream,
} from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  HealthSample,
  JobFeatureVector,
} from "@rip-deck/contracts"
import type { ComputedJobVerdict } from "./jobVerdict.ts"

/**
 * Persist the samples, the per-job feature row, and the verdict
 * the engine computed from it.
 *
 * `AGENTS.md` promises the full feature vector is persisted per
 * job "precisely so tuning is a database query rather than a
 * re-rip". There is no database yet, so this writes the shape a
 * database would want and nothing else: one JSON object per line
 * for the samples, one JSON document for the job row, one more
 * for what the engine made of it. All three import into SQLite or
 * DuckDB with a single statement, all three are greppable in the
 * meantime, and none needs a schema migration to exist before the
 * first rip that would have filled it.
 *
 * Modelled on `rip/eventLog.ts`, which exists for the same
 * reason: the answer to "why did this rip behave that way" had
 * gone to a closed pipe once already, and recovering it cost a
 * second 25-minute rip.
 *
 * Two properties matter more than the format:
 *
 *  1. **Writes are append-only and never awaited on the sampling
 *     path.** A sample is queued to a stream, not fsynced. The
 *     sampler must never be slowed by its own bookkeeping — a
 *     late sample corrupts the interval arithmetic it exists to
 *     produce.
 *  2. **Every failure is swallowed.** This is diagnostics, not
 *     the job. Losing the tuning corpus is bad; losing a
 *     three-hour rip because a diagnostic file could not be
 *     written would be worse, and D4 says a partial rip is worth
 *     keeping.
 */

export type SampleStore = {
  write: (sample: HealthSample) => void
  writeFeatures: (
    features: JobFeatureVector,
  ) => Promise<void>
  /**
   * What the engine said about this job, published or not.
   *
   * A third file rather than a field on the feature vector,
   * because the two answer different questions and are written
   * by different authorities: the vector is the MEASUREMENT and
   * is stamped with `HEALTH_FEATURE_SCHEMA_VERSION`, while this
   * is one particular build's JUDGEMENT of that measurement,
   * carrying the thresholds it used. Re-judging a corpus later
   * rewrites these and leaves the evidence untouched, which is
   * the property that makes tuning a query.
   */
  writeComputedVerdict: (
    computed: ComputedJobVerdict,
  ) => Promise<void>
  close: () => Promise<void>
}

export const sampleLogPath = (
  stateDir: string,
  jobUuid: string,
): string => join(stateDir, `${jobUuid}.samples.jsonl`)

export const featureVectorPath = (
  stateDir: string,
  jobUuid: string,
): string => join(stateDir, `${jobUuid}.features.json`)

export const computedVerdictPath = (
  stateDir: string,
  jobUuid: string,
): string => join(stateDir, `${jobUuid}.verdict.json`)

/** A no-op store, so callers never branch on "is capture on". */
export const createNullSampleStore = (): SampleStore => ({
  write: () => {},
  writeFeatures: async () => {},
  writeComputedVerdict: async () => {},
  close: async () => {},
})

export const createSampleStore = async (input: {
  stateDir: string
  jobUuid: string
}): Promise<SampleStore> => {
  const samplesPath = sampleLogPath(
    input.stateDir,
    input.jobUuid,
  )
  const featuresPath = featureVectorPath(
    input.stateDir,
    input.jobUuid,
  )
  const verdictPath = computedVerdictPath(
    input.stateDir,
    input.jobUuid,
  )

  await mkdir(input.stateDir, { recursive: true })

  // Append, so an adopted or restarted job extends its own
  // corpus rather than truncating what the previous process had
  // already measured.
  const stream: WriteStream = createWriteStream(
    samplesPath,
    { flags: "a" },
  )

  stream.on("error", () => {})

  return {
    write: (sample) => {
      stream.write(`${JSON.stringify(sample)}\n`)
    },
    writeFeatures: async (features) => {
      await writeFile(
        featuresPath,
        `${JSON.stringify(features, null, 2)}\n`,
        "utf8",
      ).catch(() => {})
    },
    writeComputedVerdict: async (computed) => {
      await writeFile(
        verdictPath,
        `${JSON.stringify(computed, null, 2)}\n`,
        "utf8",
      ).catch(() => {})
    },
    close: () =>
      new Promise((resolve) => {
        stream.end(() => {
          resolve()
        })
      }),
  }
}

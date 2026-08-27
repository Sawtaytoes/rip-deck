import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { JobFeatureVector } from "@rip-deck/contracts"
import type { DriveRegistry } from "../drives/registry.ts"
import {
  appendRipHistoryBatch,
  RIP_HISTORY_VERSION,
  type RipHistoryRecord,
  readRipHistoryJobUuids,
  ripHistoryPath,
} from "./ripHistory.ts"

/**
 * Every rip that finished BEFORE there was a history log.
 *
 * The log starts empty, and a history view that begins at "the
 * next disc you rip" is not the thing the owner asked for. The
 * state directory has been keeping one `<uuid>.features.json`
 * per rip since 2026-07-26 — 26 of them on the tower the day
 * this shipped — so the older rips are already on disk. They
 * were simply never joined up.
 *
 * ## What a backfilled row can and cannot say
 *
 * It CAN say: which drive, when it started, how long it took,
 * how many bytes the disc held, whether it succeeded, why not if
 * it failed, and — through the normal join in
 * `api/historyEndpoint.ts` — its health verdict and read-error
 * count. Every one of those is measured and written down.
 *
 * It CANNOT say what the disc was called. ⚠️ **And no amount of
 * work will recover it.** Three routes were checked against the
 * real corpus on 2026-08-27 and all three are dead:
 *
 *  1. **The robot capture.** `makemkvcon backup` never prints
 *     the disc name. Its `DRV:` disc-name field is empty in all
 *     27 captures, and the name rip-deck uses comes from udev
 *     BEFORE makemkvcon runs
 *     ([decision](docs/decisions/2026-08-26-a-discs-name-comes-from-udev-before-makemkvcon.md)).
 *  2. **`MSG:5072`'s destination folder.** It names the
 *     `.rip-deck-incomplete-<uuid>` temporary, because the
 *     rename into the library is the LAST step — that is the
 *     whole design of `leftovers.ts`.
 *  3. **Matching a finished rip folder by timestamp.** Measured:
 *     the closest folder mtime in `/media/Disc-Rips` was over a
 *     DAY away from the job's end for every one of the 13
 *     successful jobs. The dataset does not preserve the times
 *     this join would need, and a name attached to the wrong rip
 *     is worse than no name at all.
 *
 * So the row is written with `discName: null` and
 * `source: "backfill"`, and the UI says *"name not recorded"*
 * rather than showing a blank. Those are different facts and the
 * reader is owed the difference.
 *
 * ## Why it is safe to run on every boot
 *
 * It is keyed on `jobUuid` against the rows already in the log,
 * so a job that has been written is never written twice — which
 * also means a LIVE row always wins: a rip that finished with
 * this daemon running is in the log before any later boot could
 * offer to backfill it, and the live row keeps its disc name.
 * A tower with nothing new to add does one `readdir` and one
 * read of the log, and appends nothing.
 */

/** `sampleStore.featureVectorPath`'s suffix, as a glob. */
const FEATURE_FILE_SUFFIX = ".features.json"

/**
 * The outcome sentence a reconstructed row carries.
 *
 * Composed here rather than left blank, because the card renders
 * this field and an empty one reads as "nothing went wrong". It
 * is deliberately SHORT and says where it came from: the rich
 * sentence a live row carries names the physical next step, and
 * this one cannot, because the next step was taken weeks ago.
 */
const backfilledDetail = (
  vector: JobFeatureVector,
): string =>
  vector.outcome.isSuccessful
    ? "Rebuilt from this rip's saved measurements. It finished."
    : "Rebuilt from this rip's saved measurements. It failed" +
      (vector.outcome.failureReason === null
        ? "."
        : ` — ${vector.outcome.failureReason}.`)

/**
 * `sizeSectors` from `discBytes`, in the same 512-byte unit
 * `/sys/block/srN/size` reports and `BayState.sizeSectors`
 * holds. The feature vector records bytes, so this is a unit
 * change and not an estimate.
 */
const sectorsOf = (discBytes: number): number | null =>
  discBytes > 0 ? Math.round(discBytes / 512) : null

const parseFeatureVector = (
  text: string,
): JobFeatureVector | null => {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null
  }

  const vector = parsed as Partial<JobFeatureVector>

  if (
    typeof vector.driveId !== "string" ||
    typeof vector.endedAtMs !== "number" ||
    !Number.isFinite(vector.endedAtMs) ||
    typeof vector.outcome !== "object" ||
    vector.outcome === null
  ) {
    return null
  }

  return parsed as JobFeatureVector
}

export type RipHistoryBackfillResult = {
  /** Feature vectors found in the state directory. */
  jobCount: number
  /** Rows appended by THIS run. Zero on every boot after the first. */
  addedCount: number
}

/**
 * Fold the state directory's job files into the history log.
 *
 * Never throws. A missing directory, an unreadable file and a
 * half-written JSON document all read as "that is not a rip we
 * can describe" — the same conservative direction
 * `health/corpus.ts` takes over the same files, and for the same
 * reason: this runs at startup, and nothing about it may stand
 * between the owner and a tower that rips discs.
 */
export const backfillRipHistory = async (input: {
  stateDir: string
  /**
   * The slot map, so an old row can name its bay.
   *
   * ⚠️ Resolved by the registry's CACHED `usbPortPath`, which is
   * a hint and not identity — and on this tower it has already
   * moved: the rips from July sit on `2-2.3.4.x` port paths and
   * the tower is on `2-1.1.2.x` today, because it was re-cabled.
   * A row whose drive id matches nothing gets `slot: null` and
   * its raw drive id as the label. That is honest; inventing a
   * slot from a port path that now belongs to a different bay
   * would not be.
   */
  registry?: DriveRegistry | null
}): Promise<RipHistoryBackfillResult> => {
  const path = ripHistoryPath(input.stateDir)

  const names = await readdir(input.stateDir).catch(
    () => [] as string[],
  )

  const featureFiles = names.filter((name) =>
    name.endsWith(FEATURE_FILE_SUFFIX),
  )

  if (featureFiles.length === 0) {
    return { jobCount: 0, addedCount: 0 }
  }

  const known = await readRipHistoryJobUuids({ path })

  const bySlot = new Map(
    (input.registry?.entries ?? []).map((entry) => [
      entry.usbPortPath,
      entry,
    ]),
  )

  const records: RipHistoryRecord[] = []

  for (const name of featureFiles) {
    const jobUuid = name.slice(
      0,
      name.length - FEATURE_FILE_SUFFIX.length,
    )

    if (known.has(jobUuid)) continue

    const text = await readFile(
      join(input.stateDir, name),
      "utf8",
    ).catch(() => null)

    if (text === null) continue

    const vector = parseFeatureVector(text)

    if (vector === null) continue

    const entry = bySlot.get(vector.driveId)

    records.push({
      v: RIP_HISTORY_VERSION,
      // The vector's own `jobId` where it has one, because that
      // is the value `/logs` looks a capture up by. The filename
      // is the fallback and they agree in every file on the
      // tower; a disagreement means a renamed file, and the
      // filename is then what the capture beside it is named for.
      jobUuid: vector.jobId ?? jobUuid,
      driveId: vector.driveId,
      slot: entry?.slot ?? null,
      bayName: entry?.name ?? null,
      // Not recoverable. See the header — all three routes were
      // measured and all three are dead.
      discName: null,
      discType: null,
      // A successful rip published somewhere, but the vector
      // does not record where and the folder cannot be matched
      // back. Null rather than a guess.
      destinationPath: null,
      sizeSectors: sectorsOf(vector.discBytes),
      startedAtMs: Number.isFinite(vector.startedAtMs)
        ? vector.startedAtMs
        : null,
      finishedAtMs: vector.endedAtMs,
      outcome: {
        kind: vector.outcome.isSuccessful
          ? "completed"
          : "failed",
        detail: backfilledDetail(vector),
      },
      source: "backfill",
    })
  }

  // Oldest first, so the file reads in the order the rips
  // happened. Nothing depends on it — the endpoint sorts — but a
  // log somebody may one day `tail` should be in time order.
  records.sort((a, b) => a.finishedAtMs - b.finishedAtMs)

  await appendRipHistoryBatch({ path, records })

  return {
    jobCount: featureFiles.length,
    addedCount: records.length,
  }
}

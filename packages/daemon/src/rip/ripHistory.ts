import {
  appendFile,
  mkdir,
  readFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import type { DiscType } from "@rip-deck/contracts"
import type { BayOutcome } from "./watcher.ts"

/**
 * Every rip this tower has ever finished, one line at a time.
 *
 * ## The hole this closes
 *
 * `bays.json` holds ONE record per bay and overwrites it. It is
 * bay memory — "this disc is already done, do not re-rip it" —
 * and by construction it forgets the disc before it the moment a
 * new one lands. The per-job files in `$RIP_DECK_STATE_DIR`
 * (`<uuid>.features.json`, `<uuid>.verdict.json`) DO survive
 * forever, and they carry the measurements. What they do not
 * carry is the only thing a human recognises: the disc's NAME.
 * That is read by `identifyDisc` from udev, lives on `BayState`,
 * is written to the bay ledger — and is then overwritten by the
 * next disc in that bay.
 *
 * So before this file, a rip from last week was unfindable. The
 * owner, 2026-08-27:
 *
 * > *"there's no way to view rips that were previously done
 * > since the last time the image restarted."*
 *
 * ## Why JSONL, and why append-only
 *
 * One rip is one line, written once, never edited. That makes
 * the write the cheapest and safest thing a finishing rip can do
 * — a single `appendFile` of a few hundred bytes — and it means
 * a crash mid-write costs the LAST line and nothing else.
 * `bays.json` cannot work this way: it is a whole-file rewrite
 * behind a fingerprint and an in-flight guard, because it holds
 * current state that changes. History does not change.
 *
 * A parse failure is dropped, per line. A truncated tail must
 * never make the other 300 rips unreadable.
 *
 * ## What is deliberately NOT in a record
 *
 * Bytes, duration, throughput, read-error counts and the health
 * verdict. All five are already written per job by
 * `health/sampleStore.ts`, keyed by the same `jobUuid` this
 * record carries, and `verdictStore.ts` states the rule this
 * follows: *"`<jobUuid>.verdict.json` is already the authority"*.
 * Copying them here would be a second copy to keep in step, and
 * the sampler seals its vector AFTER the outcome latches — so a
 * copy taken at write time would be a copy taken too early.
 * `api/historyEndpoint.ts` joins them back in, for the page
 * being looked at only.
 *
 * What IS here is everything the job files do not know: the
 * disc's name, its type, where the rip landed, which slot it was
 * in, and the one English sentence rip-deck wrote about how it
 * went.
 *
 * ## Retention
 *
 * None. A row is a few hundred bytes and this tower produces
 * about 26 rips a month, so a year is roughly 100 KB — beside
 * the 1–3 MB robot capture each of those rips already keeps
 * forever. Nothing prunes this file
 * ([decision](docs/decisions/2026-08-27-rip-history-is-an-append-only-log-beside-the-job-files.md)).
 */

/**
 * Bumped when the on-disk shape changes incompatibly.
 *
 * Per LINE rather than per file, which is the one real advantage
 * a JSONL log has over `bays.json`'s single `version` field: a
 * v2 writer appends v2 lines beside the v1 lines already there,
 * and the reader keeps both. There is no restart that costs the
 * history, so there is no reason to ever reject the old rows.
 */
export const RIP_HISTORY_VERSION = 1

export const RIP_HISTORY_FILENAME = "history.jsonl"

export const ripHistoryPath = (stateDir: string): string =>
  join(stateDir, RIP_HISTORY_FILENAME)

/** Where the row came from, because it changes what it can say. */
export type RipHistorySource =
  /** Appended by the daemon as the rip latched. Complete. */
  | "live"
  /**
   * Reconstructed from the job files by `ripHistoryBackfill.ts`.
   *
   * ⚠️ **A backfilled row has NO disc name, and none can be
   * recovered.** See that file — the name reaches rip-deck from
   * udev and never enters a robot capture, so there is nowhere
   * left to read it from. The UI says so rather than showing a
   * blank, because "we did not record it" and "the disc had no
   * label" are different facts.
   */
  | "backfill"

/** One finished rip, as the log holds it. */
export type RipHistoryRecord = {
  v: number
  /** The capture id. `<uuid>.robot.log` is named for it. */
  jobUuid: string
  /** Stable drive identity — the USB port path, never `srN`. */
  driveId: string
  slot: number | null
  /** The bay's house label, e.g. "Slot 4". */
  bayName: string | null
  /**
   * The disc's own name, as `identifyDisc` read it.
   *
   * Null for a rip that never got as far as being identified,
   * and for every backfilled row. `is_named` on the wire keeps
   * those two apart for the reader.
   */
  discName: string | null
  discType: DiscType | null
  /** Where the rip landed. Null unless one actually published. */
  destinationPath: string | null
  sizeSectors: number | null
  /**
   * When the rip was dispatched. Null when nothing recorded it —
   * a backfilled row takes it from the feature vector instead,
   * so this is null only for a live row that finished before it
   * started, which cannot happen.
   */
  startedAtMs: number | null
  finishedAtMs: number
  outcome: BayOutcome
  source: RipHistorySource
}

/**
 * Append one finished rip. Never throws, never blocks a bay.
 *
 * Same discipline as `eventLog.ts` and `sampleStore.ts`: losing a
 * history row is a nuisance and taking down the rip that produced
 * it is not, so every filesystem failure is swallowed. The caller
 * is the outcome latch, which has eight other bays to get back
 * to.
 *
 * `appendFile` rather than a held-open stream, deliberately.
 * Nine bays finishing at once is nine appends of a few hundred
 * bytes, hours apart in practice; a stream would buy nothing and
 * would need a lifecycle nobody has a reason to own.
 */
export const appendRipHistory = async (input: {
  path: string
  record: RipHistoryRecord
}): Promise<void> => {
  await mkdir(dirname(input.path), {
    recursive: true,
  }).catch(() => {})

  await appendFile(
    input.path,
    `${JSON.stringify(input.record)}\n`,
    "utf8",
  ).catch(() => {})
}

/** Append several at once, in the order given. */
export const appendRipHistoryBatch = async (input: {
  path: string
  records: RipHistoryRecord[]
}): Promise<void> => {
  if (input.records.length === 0) return

  await mkdir(dirname(input.path), {
    recursive: true,
  }).catch(() => {})

  await appendFile(
    input.path,
    input.records
      .map((record) => `${JSON.stringify(record)}\n`)
      .join(""),
    "utf8",
  ).catch(() => {})
}

/**
 * Is this parsed line a record, rather than a fragment of one?
 *
 * Field by field, and NOT by trusting `v`. A version number says
 * what a writer intended; it says nothing about whether the
 * process died halfway through the line. Only the fields a reader
 * cannot do without are required — a row missing `discType` is
 * still a rip that happened.
 */
const isRipHistoryRecord = (
  value: unknown,
): value is RipHistoryRecord => {
  if (typeof value !== "object" || value === null)
    return false

  const record = value as Partial<RipHistoryRecord>

  return (
    typeof record.jobUuid === "string" &&
    record.jobUuid !== "" &&
    typeof record.driveId === "string" &&
    typeof record.finishedAtMs === "number" &&
    Number.isFinite(record.finishedAtMs) &&
    typeof record.outcome === "object" &&
    record.outcome !== null &&
    typeof record.outcome.kind === "string"
  )
}

/**
 * Every row on disk, oldest first, bad lines dropped.
 *
 * A missing file is an empty history, not an error: it is what a
 * tower that has never finished a rip looks like, and what every
 * tower looked like before this shipped.
 *
 * ⚠️ **Reads the whole file.** That is right at this size — a
 * year is about 100 KB — and it is why the ENRICHMENT in
 * `historyEndpoint.ts` is per page instead: joining every row to
 * its feature vector would be one `readFile` per rip ever done,
 * on every request. If this file ever reaches a size where
 * parsing it hurts, the fix is an index, not a cap: the owner
 * asked for old rips and dropping them is the one thing this
 * feature must not do.
 */
export const readRipHistory = async (input: {
  path: string
  read?: (path: string) => Promise<string>
}): Promise<RipHistoryRecord[]> => {
  const read =
    input.read ?? ((path) => readFile(path, "utf8"))

  const text = await read(input.path).catch(() => "")

  const records: RipHistoryRecord[] = []

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue

    let parsed: unknown

    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (isRipHistoryRecord(parsed)) records.push(parsed)
  }

  return records
}

/** The job ids already written down, for an idempotent backfill. */
export const readRipHistoryJobUuids = async (input: {
  path: string
  read?: (path: string) => Promise<string>
}): Promise<Set<string>> =>
  new Set(
    (await readRipHistory(input)).map(
      (record) => record.jobUuid,
    ),
  )

import { readFile } from "node:fs/promises"
import type {
  DiscType,
  JobFeatureVector,
  VerdictKind,
} from "@rip-deck/contracts"
import {
  hedged,
  isHealthVerdictPublished,
} from "../health/publish.ts"
import {
  computedVerdictPath,
  featureVectorPath,
} from "../health/sampleStore.ts"
import {
  type RipHistoryRecord,
  type RipHistorySource,
  readRipHistory,
  ripHistoryPath,
} from "../rip/ripHistory.ts"
import { isSafeJobUuid } from "./logCapture.ts"

/**
 * `GET /api/history` — every rip this tower has finished.
 *
 * ## Why it is not on `/json`
 *
 * Same argument `leftoversEndpoint.ts` makes, one step further.
 * `/json` is a live snapshot of nine bays and every handler on it
 * is a synchronous memory read; this one reads a log off disk and
 * then opens two small files per row it is about to return.
 * Folding that into a five-second poll would put a filesystem
 * walk between the browser and the bay table twelve times a
 * minute, for a page that is open for a minute a week.
 *
 * ## The join, and why it is per PAGE
 *
 * A history row (`rip/ripHistory.ts`) holds only what the bay
 * knew: the disc's name and type, where the rip landed, the slot,
 * and the outcome sentence. Everything measured — bytes,
 * duration, read errors, the health verdict — is already written
 * per job by `health/sampleStore.ts` and is joined back in HERE,
 * keyed on the same `jobUuid`.
 *
 * ⚠️ **Only for the rows actually being returned.** Enriching the
 * whole log would be two `readFile`s per rip ever done, on every
 * request — 700 file opens to render 25 rows. So the order is:
 * read the log, filter, sort, SLICE, then enrich. That bound is
 * the reason `limit` exists at all, and it is why the default is
 * a page rather than everything.
 *
 * ## The verdict passes the same gate the dashboard's does
 *
 * `isHealthVerdictPublished()` and `hedged()`, exactly as
 * `towerFeed.buildVerdict` uses them. A verdict withheld on a bay
 * card and shown on a history card would be the same engine
 * answering two ways about the same rip, and the gate exists
 * because the thresholds behind it are still guesses
 * (`health/publish.ts`). With the gate shut, every row reports
 * `unknown` — which is what the dashboard reports today.
 */

/** How many rows one page holds when the caller does not say. */
const DEFAULT_LIMIT = 25

/**
 * The most one request may ask for.
 *
 * Each row costs two file opens in the join, so this is a bound
 * on I/O and not on bytes. 200 rows is eight pages at a sitting
 * and 400 file opens, which is a blink; 700 would be the whole
 * corpus and is what `?limit=` must not be able to ask for by
 * accident.
 */
const MAX_LIMIT = 200

/** What the caller may narrow the list to. */
export type HistoryOutcomeFilter =
  | "all"
  | "completed"
  | "failed"

/**
 * One finished rip, as the wire carries it.
 *
 * snake_case, because every other JSON this server emits is —
 * `TowerView` sets the convention and `LeftoverView` follows it.
 */
export type HistoryRipView = {
  job_uuid: string
  drive_id: string
  slot: number | null
  /** The bay's house label, or the raw drive id when unmapped. */
  bay_name: string
  disc_name: string | null
  /**
   * A name was RECORDED for this rip.
   *
   * Distinct from `disc_name !== null`, and the difference is the
   * whole reason this field exists: a backfilled row has no name
   * because nothing wrote one down, and a live row can have no
   * name because the disc was never identified. Both render as no
   * title; only one of them means "we could have known this".
   */
  is_named: boolean
  disctype: DiscType | null
  destination_path: string | null
  size_bytes: number | null
  started_at_ms: number | null
  finished_at_ms: number
  /** Null when nothing recorded a start. */
  duration_ms: number | null
  outcome_kind: RipHistoryRecord["outcome"]["kind"]
  /** rip-deck's own sentence. Rendered, never rewritten. */
  outcome_detail: string
  is_successful: boolean
  failure_reason: string | null
  verdict: VerdictKind
  verdict_message: string | null
  /**
   * ⚠️ Non-zero no longer blocks success — see the 2026-08-27
   * decision. It still must never render as healthy: the rip is
   * `completed_with_warnings`, and this count is why.
   */
  read_error_count: number | null
  /** Bytes per second over the whole rip, when both are known. */
  throughput_bytes_per_sec: number | null
  /** A `<uuid>.robot.log` exists, so the Logs button has a target. */
  has_log: boolean
  source: RipHistorySource
}

export type HistoryListPayload = {
  ok: true
  /** Rows matching the filters, BEFORE the page was sliced. */
  total: number
  /** Rows in the whole log, so an empty filter reads as a filter. */
  total_unfiltered: number
  offset: number
  limit: number
  /** Newest first. */
  rips: HistoryRipView[]
  /** The whole log's span, so a date picker can bound itself. */
  oldest_at_ms: number | null
  newest_at_ms: number | null
}

export type HistoryEndpointResult = {
  status: number
  payload: HistoryListPayload | { ok: false; msg: string }
}

/** The parsed query, or the sentence explaining why not. */
export type HistoryQuery = {
  limit: number
  offset: number
  fromMs: number | null
  toMs: number | null
  search: string
  outcome: HistoryOutcomeFilter
}

/**
 * A day boundary, as the DAEMON's clock reads it.
 *
 * `?from=2026-08-01` means "from the start of the 1st here",
 * which is what somebody typing a date into the page means. The
 * page sends epoch milliseconds precisely so it never has to
 * agree with the daemon about a time zone; this branch exists for
 * `curl`, and it resolves in the daemon's own zone because that
 * is the only zone a bare date on this server can mean.
 *
 * `isEndOfDay` pushes a `to=` to the last millisecond of the day
 * named, so `from=2026-08-01&to=2026-08-01` is that whole day
 * rather than an empty instant.
 */
const parseDayBoundary = (
  raw: string,
  isEndOfDay: boolean,
): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)

  if (match === null) return null

  const [, year, month, day] = match

  const at = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    ...(isEndOfDay
      ? ([23, 59, 59, 999] as const)
      : ([0, 0, 0, 0] as const)),
  )

  return Number.isNaN(at.getTime()) ? null : at.getTime()
}

const parseInstant = (
  raw: string,
  isEndOfDay: boolean,
): number | null => {
  const day = parseDayBoundary(raw, isEndOfDay)

  if (day !== null) return day

  const epochMs = Number.parseInt(raw, 10)

  return Number.isFinite(epochMs) ? epochMs : null
}

export const parseHistoryQuery = (
  params: URLSearchParams,
): HistoryQuery | string => {
  const rawLimit = params.get("limit")
  const rawOffset = params.get("offset")
  const rawFrom = params.get("from")
  const rawTo = params.get("to")
  const rawOutcome = params.get("outcome")

  let limit = DEFAULT_LIMIT

  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10)

    if (!Number.isFinite(parsed) || parsed < 1) {
      return `\`limit\` must be a positive integer, not "${rawLimit}".`
    }

    if (parsed > MAX_LIMIT) {
      return (
        "`limit` tops out at " +
        `${String(MAX_LIMIT)}. Every row costs two file reads ` +
        "to join, so page through with `offset` instead."
      )
    }

    limit = parsed
  }

  let offset = 0

  if (rawOffset !== null) {
    const parsed = Number.parseInt(rawOffset, 10)

    if (!Number.isFinite(parsed) || parsed < 0) {
      return `\`offset\` must be zero or more, not "${rawOffset}".`
    }

    offset = parsed
  }

  let fromMs: number | null = null

  if (rawFrom !== null && rawFrom !== "") {
    fromMs = parseInstant(rawFrom, false)

    if (fromMs === null) {
      return (
        "`from` is neither a `YYYY-MM-DD` date nor epoch " +
        `milliseconds: "${rawFrom}".`
      )
    }
  }

  let toMs: number | null = null

  if (rawTo !== null && rawTo !== "") {
    toMs = parseInstant(rawTo, true)

    if (toMs === null) {
      return (
        "`to` is neither a `YYYY-MM-DD` date nor epoch " +
        `milliseconds: "${rawTo}".`
      )
    }
  }

  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    return "`from` is after `to`, so nothing could match."
  }

  if (
    rawOutcome !== null &&
    rawOutcome !== "all" &&
    rawOutcome !== "completed" &&
    rawOutcome !== "failed"
  ) {
    return (
      `unknown \`outcome\` "${rawOutcome}". It is one of ` +
      "`all`, `completed`, `failed`."
    )
  }

  return {
    limit,
    offset,
    fromMs,
    toMs,
    search: (params.get("q") ?? "").trim().toLowerCase(),
    outcome: rawOutcome ?? "all",
  }
}

/**
 * Everything about a row a human might type into the box.
 *
 * The drive id and the job uuid are in here on purpose. They are
 * not what the owner searches for — but they ARE what a support
 * question quotes ("what happened on 2-1.1.2.4.2"), and matching
 * them costs a string concatenation.
 */
const searchTextOf = (record: RipHistoryRecord): string =>
  [
    record.discName ?? "",
    record.bayName ?? "",
    record.driveId,
    record.jobUuid,
    record.destinationPath ?? "",
    record.discType ?? "",
    record.outcome.kind,
  ]
    .join(" ")
    .toLowerCase()

/**
 * Did this rip work?
 *
 * `completed` and nothing else. `needs_attention` is a bay that
 * was flagged for a human, and calling it a success on a history
 * card is precisely the "silent success" this whole project was
 * built to stop reporting (`README.md`, ARM issue #1298).
 */
const isSuccessful = (record: RipHistoryRecord): boolean =>
  record.outcome.kind === "completed"

const matchesFilters = (input: {
  record: RipHistoryRecord
  query: HistoryQuery
}): boolean => {
  const { record, query } = input

  if (
    query.fromMs !== null &&
    record.finishedAtMs < query.fromMs
  ) {
    return false
  }

  if (
    query.toMs !== null &&
    record.finishedAtMs > query.toMs
  ) {
    return false
  }

  if (
    query.outcome === "completed" &&
    !isSuccessful(record)
  ) {
    return false
  }

  if (query.outcome === "failed" && isSuccessful(record)) {
    return false
  }

  if (
    query.search !== "" &&
    !searchTextOf(record).includes(query.search)
  ) {
    return false
  }

  return true
}

const readJson = async (path: string): Promise<unknown> => {
  const text = await readFile(path, "utf8").catch(
    () => null,
  )

  if (text === null) return null

  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The measurements for one job, or nulls when there are none. */
type JobJoin = {
  sizeBytes: number | null
  durationMs: number | null
  readErrorCount: number | null
  throughputBytesPerSec: number | null
  failureReason: string | null
  verdict: VerdictKind
  verdictMessage: string | null
  hasLog: boolean
}

const EMPTY_JOIN: JobJoin = {
  sizeBytes: null,
  durationMs: null,
  readErrorCount: null,
  throughputBytesPerSec: null,
  failureReason: null,
  verdict: "unknown",
  verdictMessage: null,
  hasLog: false,
}

/**
 * Join one row to its saved measurements.
 *
 * ⚠️ Both reads are allowed to come back empty, and that is a
 * normal state rather than a fault: a rip that never started
 * writing a vector, a capture deleted to reclaim space, a
 * backfilled row whose files were the only source in the first
 * place. Every field then stays null and the card renders what it
 * has.
 *
 * The `isSafeJobUuid` gate is the same traversal gate `/logs`
 * uses, and it is here for the same reason — this joins a path
 * from a value that came off disk, and a log line somebody
 * hand-edited must not be able to name a file outside the state
 * directory.
 */
const joinJob = async (input: {
  stateDir: string | null
  record: RipHistoryRecord
  readLogExists:
    | ((jobUuid: string) => Promise<boolean>)
    | null
}): Promise<JobJoin> => {
  const { stateDir, record } = input

  if (stateDir === null || !isSafeJobUuid(record.jobUuid)) {
    return EMPTY_JOIN
  }

  const [features, computed, hasLog] = await Promise.all([
    readJson(featureVectorPath(stateDir, record.jobUuid)),
    readJson(computedVerdictPath(stateDir, record.jobUuid)),
    input.readLogExists === null
      ? Promise.resolve(false)
      : input.readLogExists(record.jobUuid),
  ])

  const vector =
    features as Partial<JobFeatureVector> | null

  const sizeBytes =
    typeof vector?.discBytes === "number" &&
    vector.discBytes > 0
      ? vector.discBytes
      : null

  const durationMs =
    typeof vector?.durationMs === "number" &&
    vector.durationMs > 0
      ? vector.durationMs
      : record.startedAtMs === null
        ? null
        : record.finishedAtMs - record.startedAtMs

  const saved = (
    computed as {
      verdict?: {
        kind?: unknown
        confidence?: unknown
        message?: unknown
        action?: unknown
        subject?: unknown
        evidence?: unknown
        isKeepTryingSensible?: unknown
      }
    } | null
  )?.verdict

  // The same gate the bay card passes, and for the same reason —
  // see the header. `hedged` is applied for symmetry with
  // `towerFeed.buildVerdict`: what is read here is the RECORDED
  // verdict, which keeps whatever the engine said, and reporting
  // it is the boundary where confidence is forced down.
  const isVerdictShowable =
    saved !== undefined &&
    typeof saved.kind === "string" &&
    isHealthVerdictPublished()

  const reported = isVerdictShowable
    ? hedged({
        kind: saved.kind as VerdictKind,
        action: "none",
        confidence: "confirmed",
        subject: "disc",
        message:
          typeof saved.message === "string"
            ? saved.message
            : "",
        evidence: [],
        isKeepTryingSensible: true,
      })
    : null

  return {
    sizeBytes,
    durationMs,
    readErrorCount:
      typeof vector?.readErrorCount === "number"
        ? vector.readErrorCount
        : null,
    // ⚠️ The MEASURED rate, never `size / duration`.
    //
    // That division assumes the whole disc was read, and on a
    // rip that FAILED it is nonsense: the live page shipped
    // "2175.6 MB/s" on a 4-second failure and "77186.5 MB/s" on
    // a 1-second one, because it divided a 7.5 GB disc by the
    // time before the ripper gave up. A plausible wrong number
    // is worse than a blank — the same rule `format.etaText`
    // states for the ETA it refuses to extrapolate.
    //
    // `driveThroughputP50BytesPerSec` is the median rate the
    // KERNEL's own counters observed, which is the input the
    // whole health engine is built on rather than MakeMKV's
    // self-report. `ripThroughputP50BytesPerSec` was the other
    // candidate and is measured too, but it is derived from
    // MakeMKV's progress fraction and carries its own outlier:
    // 6992 MB/s on job 71f30886, an 18-second failure.
    //
    // Zero says nothing worth rendering — it is what a failed
    // rip that never got a read through records, and the
    // outcome sentence beside it already says what happened.
    throughputBytesPerSec:
      typeof vector?.driveThroughputP50BytesPerSec ===
        "number" && vector.driveThroughputP50BytesPerSec > 0
        ? Math.round(vector.driveThroughputP50BytesPerSec)
        : null,
    failureReason:
      typeof vector?.outcome?.failureReason === "string"
        ? vector.outcome.failureReason
        : null,
    verdict: reported?.kind ?? "unknown",
    verdictMessage:
      reported === null || reported.message === ""
        ? null
        : reported.message,
    hasLog,
  }
}

const buildRipView = (input: {
  record: RipHistoryRecord
  join: JobJoin
}): HistoryRipView => {
  const { record, join } = input

  return {
    job_uuid: record.jobUuid,
    drive_id: record.driveId,
    slot: record.slot,
    bay_name: record.bayName ?? record.driveId,
    disc_name: record.discName,
    // A backfilled row can never be named — nothing wrote one
    // down and nothing can recover it (`ripHistoryBackfill.ts`).
    // A live row without one is a disc rip-deck genuinely could
    // not identify, which is a fact about the DISC.
    is_named: record.source === "live",
    disctype: record.discType,
    destination_path: record.destinationPath,
    size_bytes:
      join.sizeBytes ??
      (record.sizeSectors === null
        ? null
        : record.sizeSectors * 512),
    started_at_ms: record.startedAtMs,
    finished_at_ms: record.finishedAtMs,
    duration_ms: join.durationMs,
    outcome_kind: record.outcome.kind,
    outcome_detail: record.outcome.detail,
    is_successful: isSuccessful(record),
    failure_reason: join.failureReason,
    verdict: join.verdict,
    verdict_message: join.verdictMessage,
    read_error_count: join.readErrorCount,
    throughput_bytes_per_sec: join.throughputBytesPerSec,
    has_log: join.hasLog,
    source: record.source,
  }
}

export const handleHistoryList = async (input: {
  stateDir: string | null
  params: URLSearchParams
  /**
   * Does a capture exist for this job?
   *
   * Injected rather than `stat`ed here so the endpoint keeps one
   * opinion about where captures live — `createLogCaptureReader`
   * already owns that, and a second path join would be the
   * second opinion this repo keeps paying for. Null means this
   * process serves no captures, and every row then reports
   * `has_log: false`, which is exactly true of it.
   */
  readLogExists:
    | ((jobUuid: string) => Promise<boolean>)
    | null
}): Promise<HistoryEndpointResult> => {
  if (input.stateDir === null) {
    return {
      status: 503,
      payload: {
        ok: false,
        msg:
          "this process keeps no history — it was started " +
          "without a state directory to read one from. That " +
          "needs `rip-deck watch`.",
      },
    }
  }

  const query = parseHistoryQuery(input.params)

  if (typeof query === "string") {
    return {
      status: 400,
      payload: { ok: false, msg: query },
    }
  }

  const records = await readRipHistory({
    path: ripHistoryPath(input.stateDir),
  })

  const matched = records.filter((record) =>
    matchesFilters({ record, query }),
  )

  // Newest first: the reason to open this page is almost always
  // the rip that just finished, and the one from July is a
  // deliberate scroll.
  matched.sort((a, b) => b.finishedAtMs - a.finishedAtMs)

  // ⚠️ SLICE BEFORE THE JOIN. See the header — enriching every
  // matched row would be two file opens per rip ever done.
  const page = matched.slice(
    query.offset,
    query.offset + query.limit,
  )

  const rips = await Promise.all(
    page.map(async (record) =>
      buildRipView({
        record,
        join: await joinJob({
          stateDir: input.stateDir,
          record,
          readLogExists: input.readLogExists,
        }),
      }),
    ),
  )

  const finishedTimes = records.map(
    (record) => record.finishedAtMs,
  )

  return {
    status: 200,
    payload: {
      ok: true,
      total: matched.length,
      total_unfiltered: records.length,
      offset: query.offset,
      limit: query.limit,
      rips,
      oldest_at_ms:
        finishedTimes.length === 0
          ? null
          : Math.min(...finishedTimes),
      newest_at_ms:
        finishedTimes.length === 0
          ? null
          : Math.max(...finishedTimes),
    },
  }
}

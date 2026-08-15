import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"

/**
 * What we have already asked about, across a restart.
 *
 * `CMD` is `rip-deck watch`, so the daemon restarts with its
 * container and the tower keeps its discs — the same nine
 * labels come back every time. Without this file every restart
 * re-queries OMDb for discs it already knows, which is both
 * rude and one bad afternoon away from a rate limit that would
 * make the feature look broken.
 *
 * Same shape and the same reasoning as `rip/bayLedger.ts`: a
 * versioned document, a parser that never throws, and an atomic
 * temp-file + `rename` write so a reader sees the old file or
 * the new one and never a prefix. Read that file before
 * changing anything here.
 *
 * ## The raw label is persisted, and that is the point
 *
 * A record keyed only on the normalised query would be the
 * fastest way to make a wrong poster unexplainable. Both are
 * written down, so when a card shows the wrong film the answer
 * to *"where did that come from"* is one `cat` away:
 * `TROY - BONUS DISC` -> `troy` -> `Troy (2004)`.
 *
 * ## Losing this file is free
 *
 * Every failure — no directory, read-only mount, truncated
 * JSON, a hand edit — costs at most one repeat lookup. Nothing
 * here may ever fail a rip, and nothing here is logged as an
 * error.
 */

/** Bumped when the on-disk shape changes incompatibly. */
export const POSTER_CACHE_VERSION = 1

export const POSTER_CACHE_FILENAME = "posters.json"

/** Which lookup answered. `null` when none was asked. */
export type PosterProvider = "omdb"

/** One volume label, and what became of it. */
export type PosterRecord = {
  /** Exactly what `identifyDisc` read off the media. */
  rawLabel: string
  /**
   * What we actually asked, or null when we asked nothing.
   *
   * Null is a real state and worth remembering: it means
   * `parseDiscLabel` found no title in the label at all
   * (`DVD_VIDEO`, `AUDIO_CD`), so no request was ever made.
   */
  query: string | null
  /** The provider's own spelling, when one matched. */
  matchedTitle: string | null
  matchedYear: number | null
  posterUrl: string | null
  provider: PosterProvider | null
  /**
   * A lookup answered, and the answer was about this disc.
   *
   * False covers both "OMDb has never heard of it" and "OMDb
   * answered about a different film", which is why it is a flag
   * and not `posterUrl !== null`.
   */
  isMatched: boolean
  /** When this record was written. Epoch milliseconds. */
  lookedUpAtMs: number
}

export type PosterCache = {
  version: number
  records: PosterRecord[]
}

export const EMPTY_POSTER_CACHE: PosterCache = {
  version: POSTER_CACHE_VERSION,
  records: [],
}

export const posterCachePath = (stateDir: string): string =>
  join(stateDir, POSTER_CACHE_FILENAME)

const isNullableString = (value: unknown): boolean =>
  value === null || typeof value === "string"

const isNullableNumber = (value: unknown): boolean =>
  value === null || typeof value === "number"

const isPosterRecord = (
  value: unknown,
): value is PosterRecord => {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Partial<PosterRecord>

  return (
    typeof record.rawLabel === "string" &&
    isNullableString(record.query) &&
    isNullableString(record.matchedTitle) &&
    isNullableNumber(record.matchedYear) &&
    isNullableString(record.posterUrl) &&
    (record.provider === null ||
      record.provider === "omdb") &&
    typeof record.isMatched === "boolean" &&
    typeof record.lookedUpAtMs === "number"
  )
}

/**
 * Parse the cache, and never throw.
 *
 * A file we cannot read means we ask again, which is the whole
 * consequence — so every doubtful case returns the empty cache
 * rather than half of one.
 */
export const parsePosterCache = (
  raw: string,
): PosterCache => {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_POSTER_CACHE
  }

  if (typeof parsed !== "object" || parsed === null) {
    return EMPTY_POSTER_CACHE
  }

  const candidate = parsed as Partial<PosterCache>

  if (candidate.version !== POSTER_CACHE_VERSION) {
    return EMPTY_POSTER_CACHE
  }

  return {
    version: POSTER_CACHE_VERSION,
    records: Array.isArray(candidate.records)
      ? candidate.records.filter(isPosterRecord)
      : [],
  }
}

export const readPosterCache = async (input: {
  path: string
}): Promise<PosterCache> => {
  try {
    return parsePosterCache(
      await readFile(input.path, "utf8"),
    )
  } catch {
    // No file yet is the normal first-run state, not an error.
    return EMPTY_POSTER_CACHE
  }
}

/** Temp file + `rename`, exactly as the bay ledger does it. */
export const writePosterCache = async (input: {
  path: string
  cache: PosterCache
}): Promise<void> => {
  await mkdir(dirname(input.path), { recursive: true })

  const tempPath = `${input.path}.tmp`

  await writeFile(
    tempPath,
    `${JSON.stringify(input.cache, null, 2)}\n`,
    "utf8",
  )

  await rename(tempPath, input.path)
}

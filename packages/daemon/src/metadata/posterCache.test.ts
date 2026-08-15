import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  POSTER_CACHE_VERSION,
  type PosterRecord,
  parsePosterCache,
  posterCachePath,
  readPosterCache,
  writePosterCache,
} from "./posterCache.ts"

/**
 * The cache file, and the one rule it lives by.
 *
 * Losing it is free — every failure costs one repeat lookup and
 * nothing else — so every doubtful input has to come back as
 * the empty cache rather than as half of one, and nothing here
 * may ever throw at a caller that is mid-poll.
 */

const record: PosterRecord = {
  rawLabel: "TROY - BONUS DISC",
  query: "troy",
  matchedTitle: "Troy",
  matchedYear: 2004,
  posterUrl: "https://example.invalid/troy.jpg",
  provider: "omdb",
  isMatched: true,
  lookedUpAtMs: 1_800_000_000_000,
}

const createStateDir = async (): Promise<string> =>
  await mkdtemp(join(tmpdir(), "rip-deck-posters-"))

describe("parsePosterCache", () => {
  it("reads back what it wrote", () => {
    expect(
      parsePosterCache(
        JSON.stringify({
          version: POSTER_CACHE_VERSION,
          records: [record],
        }),
      ).records,
    ).toEqual([record])
  })

  it.each([
    "",
    "{",
    "null",
    "[]",
    '{"version":999,"records":[]}',
  ])(
    "forgets everything rather than half-read %s",
    (raw) => {
      expect(parsePosterCache(raw).records).toEqual([])
    },
  )

  it("drops a record that is missing a field", () => {
    // Hand-edited, or written by a version that is not this
    // one. Dropping it costs one lookup; trusting half of it
    // could put a poster on a card with no provider.
    expect(
      parsePosterCache(
        JSON.stringify({
          version: POSTER_CACHE_VERSION,
          records: [record, { rawLabel: "TROY" }],
        }),
      ).records,
    ).toEqual([record])
  })
})

describe("readPosterCache", () => {
  it("treats a missing file as first run", async () => {
    expect(
      (
        await readPosterCache({
          path: "/nonexistent/posters.json",
        })
      ).records,
    ).toEqual([])
  })

  it("treats an unreadable file as first run", async () => {
    const stateDir = await createStateDir()
    const path = posterCachePath(stateDir)

    await writeFile(path, "not json at all", "utf8")

    expect(
      (await readPosterCache({ path })).records,
    ).toEqual([])
  })
})

describe("writePosterCache", () => {
  it("writes through a temp file and renames", async () => {
    // The bay ledger's pattern: a reader sees the old file or
    // the new one, never a prefix.
    const stateDir = await createStateDir()
    const path = posterCachePath(stateDir)

    await writePosterCache({
      path,
      cache: {
        version: POSTER_CACHE_VERSION,
        records: [record],
      },
    })

    expect(
      parsePosterCache(await readFile(path, "utf8"))
        .records,
    ).toEqual([record])

    await expect(
      readFile(`${path}.tmp`, "utf8"),
    ).rejects.toThrow()
  })

  it("creates the state directory if it is not there", async () => {
    const stateDir = join(
      await createStateDir(),
      "nested",
      "deeper",
    )

    await writePosterCache({
      path: posterCachePath(stateDir),
      cache: {
        version: POSTER_CACHE_VERSION,
        records: [],
      },
    })

    expect(
      (
        await readPosterCache({
          path: posterCachePath(stateDir),
        })
      ).records,
    ).toEqual([])
  })
})

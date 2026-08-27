import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  appendRipHistoryBatch,
  RIP_HISTORY_VERSION,
  type RipHistoryRecord,
  ripHistoryPath,
} from "../rip/ripHistory.ts"
import {
  handleHistoryList,
  type HistoryListPayload,
  parseHistoryQuery,
} from "./historyEndpoint.ts"

const tmpRoot = join(
  tmpdir(),
  `rip-deck-history-endpoint-${process.pid}`,
)

/**
 * A syntactically real job id.
 *
 * ⚠️ Not decoration. `joinJob` refuses to build a path from
 * anything that is not a UUID — the same traversal gate `/logs`
 * keeps — so a test that seeds `"job-a"` and then expects the
 * join to happen is testing the gate, not the join.
 */
const uuid = (tag: string): string =>
  `${tag.padEnd(8, "0").slice(0, 8)}-1111-4111-8111-111111111111`

const AUGUST_25 = new Date(2026, 7, 25, 13, 0, 0).getTime()
const AUGUST_26 = new Date(2026, 7, 26, 13, 0, 0).getTime()

const record = (
  overrides: Partial<RipHistoryRecord> = {},
): RipHistoryRecord => ({
  v: RIP_HISTORY_VERSION,
  jobUuid: "11111111-1111-4111-8111-111111111111",
  driveId: "2-1.1.2.4.2",
  slot: 5,
  bayName: "05 - Pioneer BDR-212U",
  discName: "THE MUMMY",
  discType: "bluray",
  destinationPath: "/media/Disc-Rips/The Mummy - Blu-ray",
  sizeSectors: 1_000,
  startedAtMs: AUGUST_25 - 60_000,
  finishedAtMs: AUGUST_25,
  outcome: { kind: "completed", detail: "Backup at …" },
  source: "live",
  ...overrides,
})

const seed = async (
  records: RipHistoryRecord[],
): Promise<void> => {
  await mkdir(tmpRoot, { recursive: true })
  await appendRipHistoryBatch({
    path: ripHistoryPath(tmpRoot),
    records,
  })
}

const list = async (
  query: Record<string, string> = {},
): Promise<HistoryListPayload> => {
  const result = await handleHistoryList({
    stateDir: tmpRoot,
    params: new URLSearchParams(query),
    readLogExists: async () => false,
  })

  if (!("rips" in result.payload)) {
    throw new Error(result.payload.msg)
  }

  return result.payload
}

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("reading a history query", () => {
  it("defaults to a page of the newest rips", () => {
    const query = parseHistoryQuery(new URLSearchParams())

    expect(query).toEqual({
      limit: 25,
      offset: 0,
      fromMs: null,
      toMs: null,
      search: "",
      outcome: "all",
    })
  })

  it("⚠️ refuses a limit above the cap, and says why", () => {
    // The cap is a bound on FILE OPENS, not on bytes: every row
    // costs two reads in the join.
    expect(
      parseHistoryQuery(
        new URLSearchParams({ limit: "5000" }),
      ),
    ).toContain("tops out at 200")
  })

  it("refuses a limit that is not a positive integer", () => {
    expect(
      parseHistoryQuery(new URLSearchParams({ limit: "0" })),
    ).toContain("positive integer")
  })

  it("takes a bare date as a whole local day", () => {
    const query = parseHistoryQuery(
      new URLSearchParams({
        from: "2026-08-25",
        to: "2026-08-25",
      }),
    )

    if (typeof query === "string") throw new Error(query)

    // `from=X&to=X` is that whole day, not an empty instant.
    expect(query.fromMs).toBe(
      new Date(2026, 7, 25, 0, 0, 0, 0).getTime(),
    )
    expect(query.toMs).toBe(
      new Date(2026, 7, 25, 23, 59, 59, 999).getTime(),
    )
  })

  it("takes epoch milliseconds too, which is what the page sends", () => {
    const query = parseHistoryQuery(
      new URLSearchParams({ from: String(AUGUST_25) }),
    )

    if (typeof query === "string") throw new Error(query)

    expect(query.fromMs).toBe(AUGUST_25)
  })

  it("refuses a range that could match nothing", () => {
    expect(
      parseHistoryQuery(
        new URLSearchParams({
          from: "2026-08-26",
          to: "2026-08-25",
        }),
      ),
    ).toContain("after")
  })

  it("refuses an outcome word it does not know", () => {
    expect(
      parseHistoryQuery(
        new URLSearchParams({ outcome: "maybe" }),
      ),
    ).toContain("unknown `outcome`")
  })
})

describe("listing the history over HTTP", () => {
  it("answers newest first", async () => {
    await seed([
      record({ jobUuid: "older", finishedAtMs: AUGUST_25 }),
      record({ jobUuid: "newer", finishedAtMs: AUGUST_26 }),
    ])

    expect(
      (await list()).rips.map((one) => one.job_uuid),
    ).toEqual(["newer", "older"])
  })

  it("reports the whole log's span, so a date picker can bound itself", async () => {
    await seed([
      record({ jobUuid: "older", finishedAtMs: AUGUST_25 }),
      record({ jobUuid: "newer", finishedAtMs: AUGUST_26 }),
    ])

    const page = await list()

    expect(page.oldest_at_ms).toBe(AUGUST_25)
    expect(page.newest_at_ms).toBe(AUGUST_26)
  })

  it("narrows to a day, inclusive at both ends", async () => {
    await seed([
      record({ jobUuid: "on-25", finishedAtMs: AUGUST_25 }),
      record({ jobUuid: "on-26", finishedAtMs: AUGUST_26 }),
    ])

    const page = await list({
      from: "2026-08-25",
      to: "2026-08-25",
    })

    expect(page.rips.map((one) => one.job_uuid)).toEqual([
      "on-25",
    ])
    // The unfiltered total rides along, so an empty list can be
    // read as "your filter" rather than "no history".
    expect(page.total_unfiltered).toBe(2)
  })

  it("narrows to failures", async () => {
    await seed([
      record({ jobUuid: "good" }),
      record({
        jobUuid: "bad",
        outcome: { kind: "failed", detail: "empty_output" },
      }),
    ])

    expect(
      (await list({ outcome: "failed" })).rips.map(
        (one) => one.job_uuid,
      ),
    ).toEqual(["bad"])
  })

  it("⚠️ counts a flagged bay as a failure, never a success", async () => {
    // The silent-success report is the whole reason this
    // project exists (README, ARM #1298). `needs_attention` is
    // a bay a human still has to look at.
    await seed([
      record({
        jobUuid: "flagged",
        outcome: {
          kind: "needs_attention",
          detail: "udev and sysfs disagree",
        },
      }),
    ])

    const [row] = (await list()).rips

    expect(row.is_successful).toBe(false)
    expect(
      (await list({ outcome: "completed" })).rips,
    ).toEqual([])
  })

  it("searches the disc name, the bay and the drive id", async () => {
    await seed([
      record({ jobUuid: "mummy", discName: "THE MUMMY" }),
      record({
        jobUuid: "other",
        discName: "EYES WIDE SHUT",
        driveId: "2-1.1.2.3",
        bayName: "07 - Pioneer BDR-211M",
        // Its own destination, because the search covers that
        // field too — sharing the default would make every
        // query match both rows.
        destinationPath: "/media/Disc-Rips/EYES WIDE SHUT",
      }),
    ])

    expect(
      (await list({ q: "mummy" })).rips.map(
        (one) => one.job_uuid,
      ),
    ).toEqual(["mummy"])

    expect(
      (await list({ q: "2-1.1.2.3" })).rips.map(
        (one) => one.job_uuid,
      ),
    ).toEqual(["other"])

    expect(
      (await list({ q: "bdr-211m" })).rips.map(
        (one) => one.job_uuid,
      ),
    ).toEqual(["other"])
  })

  it("pages with offset and limit", async () => {
    await seed(
      Array.from({ length: 5 }, (_unused, index) =>
        record({
          jobUuid: `job-${String(index)}`,
          finishedAtMs: AUGUST_25 + index,
        }),
      ),
    )

    const page = await list({ limit: "2", offset: "2" })

    expect(page.total).toBe(5)
    expect(page.rips.map((one) => one.job_uuid)).toEqual([
      "job-2",
      "job-1",
    ])
  })

  it("joins the saved measurements in for the page it returns", async () => {
    await seed([record({ jobUuid: uuid("aaaaaaaa") })])

    await writeFile(
      join(tmpRoot, `${uuid("aaaaaaaa")}.features.json`),
      JSON.stringify({
        discBytes: 45_000_000_000,
        durationMs: 1_800_000,
        readErrorCount: 3,
        outcome: {
          isSuccessful: false,
          failureReason: "read_errors",
        },
      }),
      "utf8",
    )

    const [row] = (await list()).rips

    expect(row.size_bytes).toBe(45_000_000_000)
    expect(row.duration_ms).toBe(1_800_000)
    expect(row.read_error_count).toBe(3)
    expect(row.failure_reason).toBe("read_errors")
    expect(row.throughput_bytes_per_sec).toBe(25_000_000)
  })

  it("renders a row whose job files are gone", async () => {
    // Normal, not a fault: a capture reclaimed for space, a rip
    // that never started writing a vector.
    await seed([record({ jobUuid: uuid("dddddddd") })])

    const [row] = (await list()).rips

    expect(row.read_error_count).toBeNull()
    expect(row.verdict).toBe("unknown")
    // The row still knows its own size, from the bay's reading.
    expect(row.size_bytes).toBe(1_000 * 512)
  })

  it("⚠️ withholds a verdict while the health gate is shut", async () => {
    // The same gate `towerFeed.buildVerdict` passes. A verdict
    // hidden on a bay card and shown on a history card would be
    // one engine answering two ways about one rip.
    await seed([record({ jobUuid: uuid("bbbbbbbb") })])

    await writeFile(
      join(tmpRoot, `${uuid("bbbbbbbb")}.verdict.json`),
      JSON.stringify({
        verdict: { kind: "very_slow", message: "Crawling." },
      }),
      "utf8",
    )

    expect((await list()).rips[0].verdict).toBe("unknown")
  })

  it("says whether a capture exists, so the Logs button has a target", async () => {
    await seed([record({ jobUuid: uuid("cccccccc") })])

    const found = await handleHistoryList({
      stateDir: tmpRoot,
      params: new URLSearchParams(),
      readLogExists: async () => true,
    })

    expect(
      "rips" in found.payload
        ? found.payload.rips[0].has_log
        : null,
    ).toBe(true)
  })

  it("⚠️ separates 'no name recorded' from 'the disc had none'", async () => {
    // Both render as no title. Only one of them means rip-deck
    // could have known and did not write it down.
    await seed([
      record({ jobUuid: "live-unnamed", discName: null }),
      record({
        jobUuid: "rebuilt",
        discName: null,
        source: "backfill",
      }),
    ])

    const byId = new Map(
      (await list()).rips.map((one) => [one.job_uuid, one]),
    )

    expect(byId.get("live-unnamed")?.is_named).toBe(true)
    expect(byId.get("rebuilt")?.is_named).toBe(false)
  })

  it("answers an empty history as an empty list, not an error", async () => {
    await mkdir(tmpRoot, { recursive: true })

    const page = await list()

    expect(page.rips).toEqual([])
    expect(page.total).toBe(0)
    expect(page.oldest_at_ms).toBeNull()
  })

  it("answers 503 when this process was told no state directory", async () => {
    const result = await handleHistoryList({
      stateDir: null,
      params: new URLSearchParams(),
      readLogExists: null,
    })

    expect(result.status).toBe(503)
    expect(
      "msg" in result.payload ? result.payload.msg : "",
    ).toContain("rip-deck watch")
  })

  it("answers 400 for a query it cannot read", async () => {
    await seed([record()])

    const result = await handleHistoryList({
      stateDir: tmpRoot,
      params: new URLSearchParams({ limit: "-1" }),
      readLogExists: null,
    })

    expect(result.status).toBe(400)
  })

  it("⚠️ never joins a path from a job id that is not one", async () => {
    // The same traversal gate `/logs` keeps. A hand-edited log
    // line must not be able to name a file outside the state
    // directory.
    await seed([
      record({ jobUuid: "../../etc/passwd" }),
    ])

    const [row] = (await list()).rips

    expect(row.job_uuid).toBe("../../etc/passwd")
    expect(row.read_error_count).toBeNull()
    expect(row.has_log).toBe(false)
  })
})

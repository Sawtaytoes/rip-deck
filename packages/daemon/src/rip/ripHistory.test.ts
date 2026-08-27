import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  appendRipHistory,
  appendRipHistoryBatch,
  readRipHistory,
  readRipHistoryJobUuids,
  RIP_HISTORY_VERSION,
  type RipHistoryRecord,
  ripHistoryPath,
} from "./ripHistory.ts"

const tmpRoot = join(
  tmpdir(),
  `rip-deck-history-${process.pid}`,
)

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
  sizeSectors: 40_000_000,
  startedAtMs: 1_000,
  finishedAtMs: 2_000,
  outcome: { kind: "completed", detail: "Backup at …" },
  source: "live",
  ...overrides,
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("the history log", () => {
  it("appends a row and reads it back whole", async () => {
    const path = ripHistoryPath(tmpRoot)

    await appendRipHistory({ path, record: record() })

    expect(await readRipHistory({ path })).toEqual([
      record(),
    ])
  })

  it("creates the state directory rather than failing", async () => {
    // The daemon's very first rip can finish before anything
    // else has had a reason to make this directory.
    const path = ripHistoryPath(join(tmpRoot, "deeper"))

    await appendRipHistory({ path, record: record() })

    expect(await readRipHistory({ path })).toHaveLength(1)
  })

  it("keeps rows in the order they were appended", async () => {
    const path = ripHistoryPath(tmpRoot)

    await appendRipHistory({
      path,
      record: record({ jobUuid: "first", finishedAtMs: 1 }),
    })
    await appendRipHistory({
      path,
      record: record({ jobUuid: "second", finishedAtMs: 2 }),
    })

    expect(
      (await readRipHistory({ path })).map(
        (one) => one.jobUuid,
      ),
    ).toEqual(["first", "second"])
  })

  it("reads an absent file as an empty history", async () => {
    // What a tower that has never finished a rip looks like,
    // and what every tower looked like before this shipped.
    expect(
      await readRipHistory({
        path: ripHistoryPath(join(tmpRoot, "nothing-here")),
      }),
    ).toEqual([])
  })

  it("⚠️ drops a truncated tail and keeps every row before it", async () => {
    // The whole reason this file is JSONL. A process killed
    // mid-append costs the LAST line; it must not cost the
    // other three hundred rips.
    const path = ripHistoryPath(tmpRoot)

    await mkdir(tmpRoot, { recursive: true })
    await writeFile(
      path,
      `${JSON.stringify(record({ jobUuid: "kept" }))}\n` +
        '{"jobUuid":"half-writ',
      "utf8",
    )

    expect(
      (await readRipHistory({ path })).map(
        (one) => one.jobUuid,
      ),
    ).toEqual(["kept"])
  })

  it("drops a line that parses but is not a record", async () => {
    const path = ripHistoryPath(tmpRoot)

    await mkdir(tmpRoot, { recursive: true })
    await writeFile(
      path,
      `${JSON.stringify({ hello: "world" })}\n` +
        `${JSON.stringify(record({ jobUuid: "kept" }))}\n`,
      "utf8",
    )

    expect(
      (await readRipHistory({ path })).map(
        (one) => one.jobUuid,
      ),
    ).toEqual(["kept"])
  })

  it("keeps a row from a FUTURE version rather than rejecting it", async () => {
    // Per-line versions are the point: a v2 writer appends
    // beside the v1 rows already there and the reader keeps
    // both. There is no restart that costs the history.
    const path = ripHistoryPath(tmpRoot)

    await appendRipHistory({
      path,
      record: record({ v: 99, jobUuid: "from-the-future" }),
    })

    expect(
      (await readRipHistory({ path })).map(
        (one) => one.jobUuid,
      ),
    ).toEqual(["from-the-future"])
  })

  it("swallows a write it cannot make", async () => {
    // A history row is a nuisance to lose and a rip is not, so
    // every filesystem failure is swallowed — the caller is the
    // outcome latch with eight other bays to get back to.
    await mkdir(tmpRoot, { recursive: true })
    await writeFile(join(tmpRoot, "a-file"), "", "utf8")

    await expect(
      appendRipHistory({
        // A path THROUGH a file, which cannot be created.
        path: join(tmpRoot, "a-file", "history.jsonl"),
        record: record(),
      }),
    ).resolves.toBeUndefined()
  })

  it("writes a batch as one append", async () => {
    const path = ripHistoryPath(tmpRoot)

    await appendRipHistoryBatch({
      path,
      records: [
        record({ jobUuid: "a" }),
        record({ jobUuid: "b" }),
      ],
    })

    expect(
      (await readFile(path, "utf8")).trimEnd().split("\n"),
    ).toHaveLength(2)
  })

  it("touches nothing for an empty batch", async () => {
    const path = ripHistoryPath(tmpRoot)

    await appendRipHistoryBatch({ path, records: [] })

    await expect(readFile(path, "utf8")).rejects.toThrow()
  })

  it("lists the job ids already written, for an idempotent backfill", async () => {
    const path = ripHistoryPath(tmpRoot)

    await appendRipHistoryBatch({
      path,
      records: [
        record({ jobUuid: "a" }),
        record({ jobUuid: "b" }),
      ],
    })

    expect(
      await readRipHistoryJobUuids({ path }),
    ).toEqual(new Set(["a", "b"]))
  })
})

import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  appendRipHistory,
  RIP_HISTORY_VERSION,
  readRipHistory,
  ripHistoryPath,
} from "./ripHistory.ts"
import { backfillRipHistory } from "./ripHistoryBackfill.ts"

const tmpRoot = join(
  tmpdir(),
  `rip-deck-history-backfill-${process.pid}`,
)

const writeVector = async (input: {
  jobUuid: string
  driveId?: string
  startedAtMs?: number
  endedAtMs?: number
  discBytes?: number
  isSuccessful?: boolean
  failureReason?: string | null
}): Promise<void> => {
  await mkdir(tmpRoot, { recursive: true })

  await writeFile(
    join(tmpRoot, `${input.jobUuid}.features.json`),
    JSON.stringify({
      schemaVersion: 1,
      jobId: input.jobUuid,
      driveId: input.driveId ?? "2-1.1.2.4.2",
      kernelName: "sr4",
      discBytes: input.discBytes ?? 45_000_000_000,
      startedAtMs: input.startedAtMs ?? 1_000,
      endedAtMs: input.endedAtMs ?? 2_000,
      durationMs: 1_000,
      readErrorCount: 0,
      outcome: {
        isSuccessful: input.isSuccessful ?? true,
        failureReason: input.failureReason ?? null,
        exitCode: 0,
        verdictKind: null,
      },
    }),
    "utf8",
  )
}

const registry = {
  towerRootPortPath: "2-1.1",
  entries: [
    {
      slot: 5,
      name: "05 - Pioneer BDR-212U",
      firmwareSerial: "SERIAL",
      trueModel: "BDR-212U",
      reportedModel: "BDR-212U",
      usbPortPath: "2-1.1.2.4.2",
      bridgeSerial: "",
      isUhdCapable: true,
      readOffsetSamples: null,
    },
  ],
}

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("rebuilding history from the job files", () => {
  it("makes a row out of every feature vector on disk", async () => {
    await writeVector({ jobUuid: "job-a" })
    await writeVector({ jobUuid: "job-b" })

    expect(
      await backfillRipHistory({
        stateDir: tmpRoot,
        registry,
      }),
    ).toEqual({ jobCount: 2, addedCount: 2 })

    expect(
      await readRipHistory({
        path: ripHistoryPath(tmpRoot),
      }),
    ).toHaveLength(2)
  })

  it("⚠️ adds nothing on a second run, so every boot is safe", async () => {
    await writeVector({ jobUuid: "job-a" })

    await backfillRipHistory({
      stateDir: tmpRoot,
      registry,
    })

    expect(
      await backfillRipHistory({
        stateDir: tmpRoot,
        registry,
      }),
    ).toEqual({ jobCount: 1, addedCount: 0 })
  })

  it("⚠️ never overwrites a LIVE row, so a real rip keeps its disc name", async () => {
    // The live row is written at the outcome latch, before any
    // later boot could offer to rebuild the same job — and it
    // is the only row that can carry a name.
    await writeVector({ jobUuid: "job-a" })

    await appendRipHistory({
      path: ripHistoryPath(tmpRoot),
      record: {
        v: RIP_HISTORY_VERSION,
        jobUuid: "job-a",
        driveId: "2-1.1.2.4.2",
        slot: 5,
        bayName: "05 - Pioneer BDR-212U",
        discName: "THE MUMMY",
        discType: "bluray",
        destinationPath: "/media/Disc-Rips/The Mummy",
        sizeSectors: 1,
        startedAtMs: 1,
        finishedAtMs: 2,
        outcome: {
          kind: "completed",
          detail: "Backup at …",
        },
        source: "live",
      },
    })

    await backfillRipHistory({
      stateDir: tmpRoot,
      registry,
    })

    const rows = await readRipHistory({
      path: ripHistoryPath(tmpRoot),
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].discName).toBe("THE MUMMY")
    expect(rows[0].source).toBe("live")
  })

  it("⚠️ leaves a rebuilt row's disc name NULL rather than guessing one", async () => {
    // Measured on the real corpus 2026-08-27: the name is not
    // in the robot capture, not in `MSG:5072`'s folder, and not
    // recoverable by matching a rip folder's mtime. See the
    // module header. A name on the wrong rip is worse than none.
    await writeVector({ jobUuid: "job-a" })

    await backfillRipHistory({
      stateDir: tmpRoot,
      registry,
    })

    const [row] = await readRipHistory({
      path: ripHistoryPath(tmpRoot),
    })

    expect(row.discName).toBeNull()
    expect(row.discType).toBeNull()
    expect(row.destinationPath).toBeNull()
    expect(row.source).toBe("backfill")
  })

  it("names the bay when the registry still knows that port path", async () => {
    await writeVector({ jobUuid: "job-a" })

    await backfillRipHistory({
      stateDir: tmpRoot,
      registry,
    })

    const [row] = await readRipHistory({
      path: ripHistoryPath(tmpRoot),
    })

    expect(row.slot).toBe(5)
    expect(row.bayName).toBe("05 - Pioneer BDR-212U")
  })

  it("⚠️ leaves the slot null for a port path the tower has moved off", async () => {
    // Not hypothetical: the July rips sit on `2-2.3.4.x` and
    // this tower is on `2-1.1.2.x` because it was re-cabled.
    // Claiming a slot from a port path that now belongs to a
    // different bay would be an invented fact.
    await writeVector({
      jobUuid: "job-a",
      driveId: "2-2.3.4.4.4",
    })

    await backfillRipHistory({
      stateDir: tmpRoot,
      registry,
    })

    const [row] = await readRipHistory({
      path: ripHistoryPath(tmpRoot),
    })

    expect(row.slot).toBeNull()
    expect(row.bayName).toBeNull()
    expect(row.driveId).toBe("2-2.3.4.4.4")
  })

  it("carries the failure reason into the row's sentence", async () => {
    await writeVector({
      jobUuid: "job-a",
      isSuccessful: false,
      failureReason: "empty_output",
    })

    await backfillRipHistory({
      stateDir: tmpRoot,
      registry,
    })

    const [row] = await readRipHistory({
      path: ripHistoryPath(tmpRoot),
    })

    expect(row.outcome.kind).toBe("failed")
    expect(row.outcome.detail).toContain("empty_output")
  })

  it("writes rows oldest first", async () => {
    await writeVector({
      jobUuid: "later",
      endedAtMs: 9_000,
    })
    await writeVector({
      jobUuid: "earlier",
      endedAtMs: 1_000,
    })

    await backfillRipHistory({
      stateDir: tmpRoot,
      registry,
    })

    expect(
      (
        await readRipHistory({
          path: ripHistoryPath(tmpRoot),
        })
      ).map((one) => one.jobUuid),
    ).toEqual(["earlier", "later"])
  })

  it("skips a half-written vector rather than failing the boot", async () => {
    await writeVector({ jobUuid: "good" })
    await mkdir(tmpRoot, { recursive: true })
    await writeFile(
      join(tmpRoot, "truncated.features.json"),
      '{"jobId":"trunc',
      "utf8",
    )

    expect(
      await backfillRipHistory({
        stateDir: tmpRoot,
        registry,
      }),
    ).toEqual({ jobCount: 2, addedCount: 1 })
  })

  it("reads a missing state directory as nothing to do", async () => {
    expect(
      await backfillRipHistory({
        stateDir: join(tmpRoot, "not-here"),
        registry,
      }),
    ).toEqual({ jobCount: 0, addedCount: 0 })
  })

  it("works with no registry at all", async () => {
    await writeVector({ jobUuid: "job-a" })

    expect(
      await backfillRipHistory({
        stateDir: tmpRoot,
        registry: null,
      }),
    ).toEqual({ jobCount: 1, addedCount: 1 })
  })
})

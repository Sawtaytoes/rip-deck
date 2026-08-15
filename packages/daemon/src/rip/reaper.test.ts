import {
  mkdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_MIN_AGE_MS,
  findIncompleteDirectories,
  findNewestMtimeMs,
  judgeIncompleteDirectory,
  parseIncompleteDirName,
  type ReaperDeps,
  readRunningArgvUuidsFromProc,
  reapIncompleteDirectories,
} from "./reaper.ts"

const NOW_MS = Date.UTC(2026, 6, 26, 12, 0, 0)
const DAY_MS = 24 * 60 * 60 * 1_000

const buildDirectory = (input: {
  jobUuid: string
  ageMs?: number
}) => ({
  path: `/dest/.rip-deck-incomplete-${input.jobUuid}`,
  name: `.rip-deck-incomplete-${input.jobUuid}`,
  jobUuid: input.jobUuid,
  newestMtimeMs: NOW_MS - (input.ageMs ?? 30 * DAY_MS),
})

const judge = (input: {
  jobUuid: string
  ageMs?: number
  liveJobUuids?: string[]
  keepJobUuids?: string[]
  hasCompleteJobIndex?: boolean
  runningArgvUuids?: string[]
}) =>
  judgeIncompleteDirectory({
    directory: buildDirectory(input),
    liveJobUuids: new Set(input.liveJobUuids ?? []),
    keepJobUuids: new Set(input.keepJobUuids ?? []),
    hasCompleteJobIndex: input.hasCompleteJobIndex ?? true,
    runningArgvUuids: new Set(input.runningArgvUuids ?? []),
    nowMs: NOW_MS,
    minAgeMs: DEFAULT_MIN_AGE_MS,
  })

describe("naming a candidate", () => {
  it("reads the job uuid back out", () => {
    expect(
      parseIncompleteDirName(
        ".rip-deck-incomplete-abc-123",
      ),
    ).toBe("abc-123")
  })

  it("ignores anything else in the library", () => {
    // The destination root is the media library. Everything else
    // in it is somebody's film.
    expect(
      parseIncompleteDirName("Ivanhoe (1952) - Blu-ray"),
    ).toBeNull()
    expect(
      parseIncompleteDirName(".rip-deck-incomplete"),
    ).toBeNull()
    expect(
      parseIncompleteDirName("my.rip-deck-incomplete-abc"),
    ).toBeNull()
  })

  it("refuses a directory that claims no job", () => {
    // Nothing can ever disown it, so it is unresolvable rather
    // than abandoned.
    expect(
      parseIncompleteDirName(".rip-deck-incomplete-"),
    ).toBeNull()
  })
})

describe("proving a directory is abandoned, not merely incomplete", () => {
  it("reaps one no job claims and nothing has touched", () => {
    expect(judge({ jobUuid: "old" }).isAbandoned).toBe(true)
  })

  it("spares all nine of a concurrent run", () => {
    // The tower runs nine drives at once, so nine live
    // .rip-deck-incomplete-* directories is the NORMAL state, not
    // a mess to tidy.
    const liveJobUuids = Array.from(
      { length: 9 },
      (_unused, index) => `slot-${index + 1}`,
    )

    for (const jobUuid of liveJobUuids) {
      const verdict = judge({
        jobUuid,
        ageMs: 0,
        liveJobUuids,
      })

      expect(verdict.isAbandoned).toBe(false)
      if (!verdict.isAbandoned) {
        expect(verdict.reason).toContain("is running")
      }
    }
  })

  it("spares partial output a failed rip is keeping (D4)", () => {
    // Cleanup is the operator's "give up", not ours — even when
    // the job has been dead for a month.
    const verdict = judge({
      jobUuid: "gave-up",
      ageMs: 365 * DAY_MS,
      keepJobUuids: ["gave-up"],
    })

    expect(verdict.isAbandoned).toBe(false)
    if (!verdict.isAbandoned) {
      expect(verdict.reason).toContain("D4")
    }
  })

  it("reaps nothing at all when the job index is unreadable", () => {
    // "No job claims this" and "we cannot tell which jobs exist"
    // are indistinguishable, and the second must never be read
    // as the first.
    const verdict = judge({
      jobUuid: "old",
      hasCompleteJobIndex: false,
    })

    expect(verdict.isAbandoned).toBe(false)
    if (!verdict.isAbandoned) {
      expect(verdict.reason).toContain("job index")
    }
  })

  it("spares one a live process still names, whatever the index says", () => {
    // The guard that survives a daemon restart which lost its
    // job table: it asks the kernel, not our bookkeeping.
    const verdict = judge({
      jobUuid: "orphaned-but-running",
      runningArgvUuids: ["orphaned-but-running"],
    })

    expect(verdict.isAbandoned).toBe(false)
    if (!verdict.isAbandoned) {
      expect(verdict.reason).toContain("argv")
    }
  })

  it("spares one touched inside the stale window", () => {
    expect(
      judge({ jobUuid: "recent", ageMs: DAY_MS })
        .isAbandoned,
    ).toBe(false)
  })

  it("uses a stale window far longer than any rip", () => {
    // Nine parallel rips is still hours, not days.
    expect(DEFAULT_MIN_AGE_MS).toBeGreaterThanOrEqual(
      7 * DAY_MS,
    )
  })

  it("spares one whose age is not a number it can trust", () => {
    // Infinity is what an unreadable entry reports, and a future
    // mtime means the clock is wrong. Neither is "old".
    for (const newestMtimeMs of [
      Number.POSITIVE_INFINITY,
      NOW_MS + DAY_MS,
    ]) {
      const verdict = judgeIncompleteDirectory({
        directory: {
          ...buildDirectory({ jobUuid: "weird" }),
          newestMtimeMs,
        },
        liveJobUuids: new Set(),
        keepJobUuids: new Set(),
        hasCompleteJobIndex: true,
        runningArgvUuids: new Set(),
        nowMs: NOW_MS,
        minAgeMs: DEFAULT_MIN_AGE_MS,
      })

      expect(verdict.isAbandoned).toBe(false)
    }
  })
})

describe("finding candidates on disk", () => {
  const tmpRoot = join(
    tmpdir(),
    `rip-deck-reaper-${process.pid}`,
  )

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const seed = async () => {
    await mkdir(join(tmpRoot, "Ivanhoe (1952) - Blu-ray"), {
      recursive: true,
    })
    await mkdir(
      join(tmpRoot, ".rip-deck-incomplete-old/BDMV/STREAM"),
      { recursive: true },
    )
    await writeFile(
      join(
        tmpRoot,
        ".rip-deck-incomplete-old/BDMV/STREAM/00000.m2ts",
      ),
      "bytes",
      "utf8",
    )
    await mkdir(
      join(tmpRoot, ".rip-deck-incomplete-live"),
      {
        recursive: true,
      },
    )
    // A file, not a directory — not a candidate.
    await writeFile(
      join(tmpRoot, ".rip-deck-incomplete-decoy"),
      "",
      "utf8",
    )

    // Every seeded entry is aged relative to NOW_MS, because
    // NOW_MS is a FIXED constant and these files are created with
    // the REAL clock. The reaper ages a candidate as
    // `nowMs - newestMtimeMs`, so a fixture left at real time
    // scores `NOW_MS - <real now>` — which turned negative the
    // instant real time passed 2026-07-26T12:00Z, and stays
    // negative forever after. A negative age is younger than any
    // `minAgeMs`, so `.rip-deck-incomplete-old` stopped reading as
    // abandoned and two tests here began failing permanently.
    // They were green only because the suite was first run on the
    // morning of that same day.
    for (const relativePath of [
      ".rip-deck-incomplete-old/BDMV/STREAM/00000.m2ts",
      ".rip-deck-incomplete-old/BDMV/STREAM",
      ".rip-deck-incomplete-old/BDMV",
      ".rip-deck-incomplete-old",
      ".rip-deck-incomplete-live",
      ".rip-deck-incomplete-decoy",
      "Ivanhoe (1952) - Blu-ray",
    ]) {
      await age(join(tmpRoot, relativePath), 30 * DAY_MS)
    }
  }

  const age = async (path: string, ms: number) => {
    const at = new Date(NOW_MS - ms)
    await utimes(path, at, at)
  }

  it("takes only directories we named, in the root itself", async () => {
    await seed()

    const found = await findIncompleteDirectories(tmpRoot)

    expect(
      found.map((entry) => entry.jobUuid).sort(),
    ).toEqual(["live", "old"])
  })

  it("reads the newest mtime in the tree, not the top one", async () => {
    // A rip spending two hours writing one enormous M2TS leaves
    // the directory's own mtime hours old, because a directory's
    // mtime only moves when entries are added or removed.
    await seed()
    const dir = join(tmpRoot, ".rip-deck-incomplete-old")
    const file = join(dir, "BDMV/STREAM/00000.m2ts")

    await age(file, 0)
    await age(join(dir, "BDMV/STREAM"), 30 * DAY_MS)
    await age(join(dir, "BDMV"), 30 * DAY_MS)
    await age(dir, 30 * DAY_MS)

    const topMtimeMs = (await stat(dir)).mtimeMs
    const newestMtimeMs = await findNewestMtimeMs(dir)

    expect(newestMtimeMs).toBeGreaterThan(topMtimeMs)
    expect(NOW_MS - newestMtimeMs).toBeLessThan(DAY_MS)
  })

  const deps: ReaperDeps = {
    readRunningArgvUuids: async () => new Set<string>(),
  }

  it("reports without deleting by default", async () => {
    await seed()

    const report = await reapIncompleteDirectories(
      {
        rootPath: tmpRoot,
        liveJobUuids: new Set(["live"]),
        keepJobUuids: new Set(),
        hasCompleteJobIndex: true,
        isDeleteEnabled: false,
        nowMs: NOW_MS,
        minAgeMs: 0,
      },
      deps,
    )

    expect(report.deletedPaths).toEqual([])
    expect(
      report.judgements.filter(
        (judgement) => judgement.verdict.isAbandoned,
      ),
    ).toHaveLength(1)

    // Still there. Reporting is not doing.
    await expect(
      stat(join(tmpRoot, ".rip-deck-incomplete-old")),
    ).resolves.toBeDefined()
  })

  it("unlinks only what it proved, and only when told to", async () => {
    await seed()

    const report = await reapIncompleteDirectories(
      {
        rootPath: tmpRoot,
        liveJobUuids: new Set(["live"]),
        keepJobUuids: new Set(),
        hasCompleteJobIndex: true,
        isDeleteEnabled: true,
        nowMs: NOW_MS,
        minAgeMs: 0,
      },
      deps,
    )

    expect(report.deletedPaths).toEqual([
      join(tmpRoot, ".rip-deck-incomplete-old"),
    ])
    expect(report.failures).toEqual([])

    // The live rip, the decoy file and the film are untouched.
    await expect(
      stat(join(tmpRoot, ".rip-deck-incomplete-live")),
    ).resolves.toBeDefined()
    await expect(
      stat(join(tmpRoot, ".rip-deck-incomplete-decoy")),
    ).resolves.toBeDefined()
    await expect(
      stat(join(tmpRoot, "Ivanhoe (1952) - Blu-ray")),
    ).resolves.toBeDefined()
  })

  it("deletes nothing when the job index is incomplete", async () => {
    await seed()

    const report = await reapIncompleteDirectories(
      {
        rootPath: tmpRoot,
        liveJobUuids: new Set(),
        keepJobUuids: new Set(),
        hasCompleteJobIndex: false,
        isDeleteEnabled: true,
        nowMs: NOW_MS,
        minAgeMs: 0,
      },
      deps,
    )

    expect(report.deletedPaths).toEqual([])
    await expect(
      stat(join(tmpRoot, ".rip-deck-incomplete-old")),
    ).resolves.toBeDefined()
  })

  it("does not walk /proc when there is nothing to consider", async () => {
    await mkdir(tmpRoot, { recursive: true })
    let callCount = 0

    const report = await reapIncompleteDirectories(
      {
        rootPath: tmpRoot,
        liveJobUuids: new Set(),
        keepJobUuids: new Set(),
        hasCompleteJobIndex: true,
        isDeleteEnabled: true,
        nowMs: NOW_MS,
      },
      {
        readRunningArgvUuids: async () => {
          callCount += 1
          return new Set<string>()
        },
      },
    )

    expect(callCount).toBe(0)
    expect(report.judgements).toEqual([])
  })
})

describe("liveness straight from /proc", () => {
  const tmpProc = join(
    tmpdir(),
    `rip-deck-proc-${process.pid}`,
  )

  afterEach(async () => {
    await rm(tmpProc, { recursive: true, force: true })
  })

  const writeCmdline = async (
    pid: string,
    argv: string[],
  ) => {
    await mkdir(join(tmpProc, pid), { recursive: true })
    await writeFile(
      join(tmpProc, pid, "cmdline"),
      `${argv.join("\0")}\0`,
      "utf8",
    )
  }

  it("finds the uuid inside makemkvcon's output argument", async () => {
    // makemkvcon is handed the CONTAINER-side path, which shares
    // only the directory name with ours — so the match has to be
    // on the segment, not on the whole path.
    await writeCmdline("101", [
      "makemkvcon",
      "-r",
      "backup",
      "--decrypt",
      "disc:0",
      "/home/arm/media/.rip-deck-incomplete-abc-123",
    ])
    await writeCmdline("102", ["sleep", "1000"])
    await mkdir(join(tmpProc, "self"), { recursive: true })

    const uuids =
      await readRunningArgvUuidsFromProc(tmpProc)

    expect([...uuids]).toEqual(["abc-123"])
  })

  it("ignores a process that exits mid-walk", async () => {
    // /proc entries vanish under a reader constantly. That is
    // normal, not an error.
    await mkdir(join(tmpProc, "103"), { recursive: true })

    await expect(
      readRunningArgvUuidsFromProc(tmpProc),
    ).resolves.toEqual(new Set())
  })

  it("propagates a failure to list /proc at all", async () => {
    // Returning an empty set there would look exactly like
    // "nothing is running", which is the one wrong answer this
    // can give.
    await expect(
      readRunningArgvUuidsFromProc(
        join(tmpProc, "does-not-exist"),
      ),
    ).rejects.toThrow()
  })
})

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createLogCaptureReader,
  isSafeJobUuid,
  LOG_CAPTURE_TUNING,
  logCaptureFilename,
  readStateDir,
} from "./logCapture.ts"

/**
 * The tail, against a real file on a real disk.
 *
 * Stubbed everywhere else, and deliberately not here: the whole
 * risk in this module is arithmetic on byte offsets — reading
 * backwards in growing windows, dropping the fragment at the cut,
 * keeping the file's own trailing newline. None of that is
 * provable against a fake `fs`, and all of it is the kind of
 * off-by-one that would silently drop the last line of a robot
 * log, which is the line the operator opened it for.
 */

const JOB_UUID = "6f1b2c3d-0000-4000-8000-000000000001"

let stateDir: string | null = null

const createStateDir = async (): Promise<string> => {
  stateDir = await mkdtemp(join(tmpdir(), "rip-deck-logs-"))

  return stateDir
}

afterEach(async () => {
  if (stateDir !== null) {
    await rm(stateDir, { recursive: true, force: true })
    stateDir = null
  }
})

const writeCapture = async (input: {
  stateDir: string
  jobUuid?: string
  text: string
}): Promise<void> => {
  await writeFile(
    join(
      input.stateDir,
      logCaptureFilename(input.jobUuid ?? JOB_UUID),
    ),
    input.text,
    "utf8",
  )
}

/** A capture long enough to need more than one read window. */
const buildRobotLog = (lineCount: number): string =>
  `${Array.from(
    { length: lineCount },
    (_unused, index) =>
      `PRGV:${String(index)},${String(index * 2)},65536`,
  ).join("\n")}\n`

describe("isSafeJobUuid", () => {
  it("takes a job id and nothing else", () => {
    expect(isSafeJobUuid(JOB_UUID)).toBe(true)
    // The placeholder `towerFeed` writes for a bay that never
    // got a job. It names no file, and must not be looked up.
    expect(isSafeJobUuid("usb-2-1-1-2@1800000000000")).toBe(
      false,
    )

    for (const attempt of [
      "../../etc/passwd",
      "/etc/passwd",
      `${JOB_UUID}/../../etc/passwd`,
      `${JOB_UUID}\u0000.png`,
      `${JOB_UUID} `,
      `${JOB_UUID}.robot.log`,
      "bays.json",
      "",
    ]) {
      expect(isSafeJobUuid(attempt)).toBe(false)
    }
  })
})

describe("the capture reader", () => {
  it("tails the LAST n lines, which is where the answer is", async () => {
    // A MakeMKV robot log ends with the outcome. Serving the
    // first 600 lines would serve the drive scan.
    const dir = await createStateDir()

    await writeCapture({
      stateDir: dir,
      text: buildRobotLog(5_000),
    })

    const result = await createLogCaptureReader({
      stateDir: dir,
    })({ jobUuid: JOB_UUID, lines: 600 })

    expect(result.isFound).toBe(true)

    if (!result.isFound) return

    const lines = result.text.trimEnd().split("\n")

    expect(lines).toHaveLength(600)
    expect(lines[0]).toBe("PRGV:4400,8800,65536")
    expect(lines[599]).toBe("PRGV:4999,9998,65536")
  })

  it("keeps growing the window until it has enough lines", async () => {
    // 128 KiB of 20-byte lines is ~6500 lines, so asking for
    // 40 000 forces the quadrupling path — the loop that would
    // otherwise never be exercised.
    const dir = await createStateDir()

    await writeCapture({
      stateDir: dir,
      text: buildRobotLog(60_000),
    })

    const result = await createLogCaptureReader({
      stateDir: dir,
    })({ jobUuid: JOB_UUID, lines: 40_000 })

    if (!result.isFound) throw new Error("no capture")

    const lines = result.text.trimEnd().split("\n")

    expect(lines).toHaveLength(40_000)
    expect(lines[0]).toBe("PRGV:20000,40000,65536")
    expect(lines[39_999]).toBe("PRGV:59999,119998,65536")
  })

  it("serves the whole file when it is shorter than asked", async () => {
    const dir = await createStateDir()
    const text = buildRobotLog(12)

    await writeCapture({ stateDir: dir, text })

    const result = await createLogCaptureReader({
      stateDir: dir,
    })({ jobUuid: JOB_UUID, lines: 600 })

    if (!result.isFound) throw new Error("no capture")

    // Byte-identical, trailing newline included: a robot log is
    // a parsed format and this is the only honest way to serve
    // one.
    expect(result.text).toBe(text)
  })

  it("does not invent a trailing newline the file lacks", async () => {
    const dir = await createStateDir()

    await writeCapture({
      stateDir: dir,
      text: "MSG:5072,0,1\nDRV:0,2,999",
    })

    const result = await createLogCaptureReader({
      stateDir: dir,
    })({ jobUuid: JOB_UUID, lines: 1 })

    if (!result.isFound) throw new Error("no capture")

    expect(result.text).toBe("DRV:0,2,999")
  })

  it("serves everything for an explicit all", async () => {
    const dir = await createStateDir()
    const text = buildRobotLog(20_000)

    await writeCapture({ stateDir: dir, text })

    const result = await createLogCaptureReader({
      stateDir: dir,
    })({ jobUuid: JOB_UUID, lines: "all" })

    if (!result.isFound) throw new Error("no capture")

    expect(result.text).toBe(text)
  })

  it("survives a capture that is empty", async () => {
    const dir = await createStateDir()

    await writeCapture({ stateDir: dir, text: "" })

    const result = await createLogCaptureReader({
      stateDir: dir,
    })({ jobUuid: JOB_UUID, lines: 600 })

    expect(result).toEqual({ isFound: true, text: "" })
  })

  it("reads a multi-byte disc title back whole", async () => {
    // Robot logs carry disc names, and a window boundary cuts
    // at a BYTE offset. The fragment at the cut is dropped, so
    // no line can ever come back with half a codepoint in it.
    const dir = await createStateDir()

    await writeCapture({
      stateDir: dir,
      text: `${buildRobotLog(4_000)}CINFO:2,0,"日本語のディスク"\n`,
    })

    const result = await createLogCaptureReader({
      stateDir: dir,
    })({ jobUuid: JOB_UUID, lines: 1 })

    if (!result.isFound) throw new Error("no capture")

    expect(result.text).toBe(
      'CINFO:2,0,"日本語のディスク"\n',
    )
    expect(result.text).not.toContain("�")
  })

  it("reports a job with no capture as an absence", async () => {
    const dir = await createStateDir()

    expect(
      await createLogCaptureReader({ stateDir: dir })({
        jobUuid: JOB_UUID,
        lines: 600,
      }),
    ).toEqual({ isFound: false })
  })

  it("refuses a traversal even when handed one directly", async () => {
    // The router checks this too. Both, because a check that
    // lives in only one of the two ways in is worthless.
    const dir = await createStateDir()

    await writeFile(join(dir, "bays.json"), "{}", "utf8")

    expect(
      await createLogCaptureReader({ stateDir: dir })({
        jobUuid: "../bays.json",
        lines: 600,
      }),
    ).toEqual({ isFound: false })

    expect(
      await createLogCaptureReader({ stateDir: dir })({
        jobUuid: "bays.json",
        lines: 600,
      }),
    ).toEqual({ isFound: false })
  })
})

describe("readStateDir", () => {
  it("matches the watcher's own default", () => {
    // Duplicated from `createWatcherConfig` rather than
    // imported, so this is the test that keeps the two honest.
    expect(readStateDir({})).toBe("/var/lib/rip-deck")
    expect(
      readStateDir({ RIP_DECK_STATE_DIR: "/srv/state" }),
    ).toBe("/srv/state")
  })
})

describe("the tuning", () => {
  it("defaults to the tail the dashboard asks for", () => {
    // `httpDataSource.fetchLog` sends `lines=600`; the default
    // here exists for everyone else and must agree with it.
    expect(LOG_CAPTURE_TUNING.defaultLines).toBe(600)
  })
})

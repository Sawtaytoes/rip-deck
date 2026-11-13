import { randomUUID } from "node:crypto"
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { JobProgress } from "@rip-deck/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createCyanripProgressState,
  observeCyanripSegment,
  parseCyanripProgress,
  parseCyanripTrackCount,
  runCyanripJob,
  splitCyanripSegments,
} from "./cyanripJob.ts"
import type { Liveness } from "./liveness.ts"
import {
  type BayRipInput,
  createWatcherConfig,
  ripAudioCd,
} from "./watcher.ts"

/**
 * The audio-CD path gets the video path's supervision: progress,
 * heartbeat, and the liveness watchdog. The status lines below are
 * cyanrip 0.9.3's own format, from `cyanrip_main.c`.
 */

describe("parsing cyanrip's status line", () => {
  it("reads the track, the fraction, and an ETA in minutes", () => {
    expect(
      parseCyanripProgress(
        "Ripping and encoding track 3, progress - 45.23%, ETA - 4m",
      ),
    ).toEqual({
      trackNumber: 3,
      trackFraction: 0.4523,
      etaSeconds: 240,
    })
  })

  it("reads hours, seconds, and an errors suffix", () => {
    expect(
      parseCyanripProgress(
        "Ripping and encoding track 1, progress - 0.10%, ETA - 1h 5m, errors - 2",
      )?.etaSeconds,
    ).toBe(3900)
    expect(
      parseCyanripProgress(
        "Ripping track 12, progress - 100.00%, ETA - 0s",
      ),
    ).toEqual({
      trackNumber: 12,
      trackFraction: 1,
      etaSeconds: 0,
    })
  })

  it("ignores everything that is not a status segment", () => {
    expect(
      parseCyanripProgress(
        "Track 3 ripped and encoded successfully!",
      ),
    ).toBeNull()
    expect(
      parseCyanripTrackCount("Disc tracks:    14"),
    ).toBe(14)
    expect(
      parseCyanripTrackCount("Tracks to rip:  all"),
    ).toBeNull()
  })

  it("splits on the bare carriage return cyanrip redraws with", () => {
    expect(
      splitCyanripSegments(
        "Disc tracks:    2\nRipping and encoding track 1, progress - 1.00%\rRipping and",
      ),
    ).toEqual({
      segments: [
        "Disc tracks:    2",
        "Ripping and encoding track 1, progress - 1.00%",
      ],
      rest: "Ripping and",
    })
  })
})

describe("the progress fold", () => {
  const fold = (segments: string[], atMs = 1_000) =>
    segments.reduce(
      (state, segment, index) =>
        observeCyanripSegment({
          state,
          segment,
          atMs: atMs + index,
        }),
      createCyanripProgressState(0),
    )

  it("turns track progress into whole-disc progress", () => {
    const state = fold([
      "Disc tracks:    4",
      "Ripping and encoding track 1, progress - 100.00%",
      "Ripping and encoding track 2, progress - 50.00%",
    ])

    expect(state.progress.totalFraction).toBeCloseTo(0.375)
    expect(state.progress.currentFraction).toBeCloseTo(0.5)
    expect(state.progress.fileIndex).toBe(2)
    expect(state.progress.fileCount).toBe(4)
  })

  it("does not count a repeated segment as forward progress", () => {
    // The same rule PRGV follows: a ripper repeating its last
    // position while the drive retries is not making progress.
    const state = fold([
      "Ripping and encoding track 1, progress - 10.00%",
      "Ripping and encoding track 1, progress - 10.00%",
      "Ripping and encoding track 1, progress - 10.00%",
    ])

    expect(state.lastForwardProgressAtMs).toBe(1_000)
  })

  it("counts a new track as forward progress", () => {
    const state = fold([
      "Ripping and encoding track 1, progress - 100.00%",
      "Ripping and encoding track 2, progress - 0.01%",
    ])

    expect(state.lastForwardProgressAtMs).toBe(1_001)
  })
})

describe("supervising a cyanrip run", () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  const fakeCyanrip = async (script: string) => {
    const root = await mkdtemp(
      join(tmpdir(), "cyanrip-job-"),
    )
    dirs.push(root)
    const tool = join(root, "cyanrip.cjs")
    await writeFile(tool, script)

    return {
      root,
      stateDir: join(root, "state"),
      cyanrip: {
        command: process.execPath,
        prefixArgs: [tool],
        wrapperArgs: null,
      },
    }
  }

  it("reports progress and writes the heartbeat", async () => {
    const fake = await fakeCyanrip(String.raw`
process.stdout.write('Disc tracks:    2\n');
for (const track of [1, 2]) {
  for (const percent of ['50.00', '100.00']) {
    process.stdout.write('\rRipping and encoding track ' + track + ', progress - ' + percent + '%, ETA - 0s');
  }
  process.stdout.write('\nTrack ' + track + ' ripped and encoded successfully!\n');
}
`)
    const progress: JobProgress[] = []
    const jobUuid = randomUUID()

    const result = await runCyanripJob({
      invocation: {
        command: fake.cyanrip.command,
        args: fake.cyanrip.prefixArgs,
        cwd: fake.root,
      },
      cyanrip: fake.cyanrip,
      devPath: "/dev/sr0",
      jobUuid,
      stateDir: fake.stateDir,
      signal: new AbortController().signal,
      log: { write: () => {} },
      onProgress: (value) => progress.push(value),
    })

    expect(result.exitCode).toBe(0)
    expect(result.termination).toBe("exited")
    expect(result.progress.totalFraction).toBe(1)
    expect(progress.length).toBeGreaterThan(0)
    expect(
      await readFile(
        join(fake.stateDir, `${jobUuid}.heartbeat`),
        "utf8",
      ),
    ).toMatch(/ line=\d+\n$/)
  })

  it("⚠️ abandons a stalled run and says why", async () => {
    // A drive that stops answering used to hold its bay until a
    // person pressed Cancel. The real thresholds are minutes
    // long, so the assessment is replaced; what is under test is
    // the wiring from an "abandon" verdict to a dead process.
    const fake = await fakeCyanrip(
      "setInterval(() => {}, 1000)",
    )
    const abandon: Liveness = {
      kind: "silent",
      action: "abandon",
      msSinceProgress: 0,
      msSinceEvent: 0,
      reason: "No output at all.",
    }
    const onLiveness = vi.fn()

    const result = await runCyanripJob({
      invocation: {
        command: fake.cyanrip.command,
        args: fake.cyanrip.prefixArgs,
        cwd: fake.root,
      },
      cyanrip: fake.cyanrip,
      devPath: "/dev/sr0",
      jobUuid: randomUUID(),
      stateDir: fake.stateDir,
      signal: new AbortController().signal,
      log: { write: () => {} },
      onLiveness,
      watchdog: { assess: () => abandon, intervalMs: 10 },
    })

    expect(result.termination).toBe("stall_timeout")
    expect(result.stallReason).toBe("No output at all.")
    expect(onLiveness).toHaveBeenCalledWith(abandon)
  })

  it("does not abandon a run the operator asked to keep trying", async () => {
    const fake = await fakeCyanrip(
      "setTimeout(() => process.exit(0), 300)",
    )

    const result = await runCyanripJob({
      invocation: {
        command: fake.cyanrip.command,
        args: fake.cyanrip.prefixArgs,
        cwd: fake.root,
      },
      cyanrip: fake.cyanrip,
      devPath: "/dev/sr0",
      jobUuid: randomUUID(),
      stateDir: fake.stateDir,
      signal: new AbortController().signal,
      log: { write: () => {} },
      isKeepTryingRequested: () => true,
      watchdog: {
        // The real assessment, with the clock pushed far past
        // every threshold, so only "keep trying" stops it.
        assess: (input) => ({
          kind: "silent",
          action: input.isKeepTryingRequested
            ? "alert"
            : "abandon",
          msSinceProgress: 0,
          msSinceEvent: 0,
          reason: "silent",
        }),
        intervalMs: 10,
      },
    })

    expect(result.termination).toBe("exited")
    expect(result.exitCode).toBe(0)
  })

  it("⚠️ does not start cyanrip when the cancel lands during setup", async () => {
    // The abort fires while the state directory is being
    // prepared, before any listener exists. It must still stop
    // the run before a process is spawned.
    const fake = await fakeCyanrip(
      "require('node:fs').writeFileSync('started', '')",
    )
    const controller = new AbortController()

    const running = runCyanripJob({
      invocation: {
        command: fake.cyanrip.command,
        args: fake.cyanrip.prefixArgs,
        cwd: fake.root,
      },
      cyanrip: fake.cyanrip,
      devPath: "/dev/sr0",
      jobUuid: randomUUID(),
      stateDir: fake.stateDir,
      signal: controller.signal,
      log: { write: () => {} },
    })

    controller.abort()

    expect((await running).termination).toBe(
      "cancelled_by_operator",
    )
    expect(await readdir(fake.root)).not.toContain(
      "started",
    )
  })

  it.each([{ slow: "-KILL" }, { slow: "-TERM" }])(
    "⚠️ holds a wrapped run until a slow $slow command finishes",
    {
      timeout: 45_000,
    },
    async ({ slow }) => {
      // A `docker exec` client exits on SIGTERM while the cyanrip
      // inside keeps the drive. The run must not report itself
      // over, which releases the bay, until the inner SIGKILL has
      // gone out. The fake is both the wrapper and its `pkill`.
      const fake = await fakeCyanrip(String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'pkill') {
  // A slow ssh or docker exec: one signal lands later than the
  // whole termination grace, which must not release the run.
  setTimeout(() => {
    fs.appendFileSync(__dirname + '/kills', args[1] + '\n');
    process.exit(0);
  }, args[1] === process.env.SLOW_SIGNAL ? 12000 : 0);
  return;
}
setInterval(() => {}, 1000);
`)
      const wrapper = fake.cyanrip.prefixArgs[0]
      const controller = new AbortController()

      vi.stubEnv("SLOW_SIGNAL", slow)
      setTimeout(() => controller.abort(), 100)

      const result = await runCyanripJob({
        invocation: {
          command: fake.cyanrip.command,
          args: [wrapper, "cyanrip"],
          cwd: fake.root,
        },
        cyanrip: {
          command: fake.cyanrip.command,
          prefixArgs: [wrapper, "cyanrip"],
          wrapperArgs: [wrapper],
        },
        devPath: "/dev/sr0",
        jobUuid: randomUUID(),
        stateDir: fake.stateDir,
        signal: controller.signal,
        log: { write: () => {} },
      })

      expect(result.termination).toBe(
        "cancelled_by_operator",
      )
      // Read at once, with no waiting: the run must not have
      // returned before both wrapper commands finished.
      expect(
        (await readFile(join(fake.root, "kills"), "utf8"))
          .trim()
          .split("\n")
          .sort(),
      ).toEqual(["-KILL", "-TERM"])
      vi.unstubAllEnvs()
    },
  )

  it("records an operator cancel as a cancel", async () => {
    const fake = await fakeCyanrip(
      "setInterval(() => {}, 1000)",
    )
    const controller = new AbortController()

    setTimeout(() => controller.abort(), 100)

    const result = await runCyanripJob({
      invocation: {
        command: fake.cyanrip.command,
        args: fake.cyanrip.prefixArgs,
        cwd: fake.root,
      },
      cyanrip: fake.cyanrip,
      devPath: "/dev/sr0",
      jobUuid: randomUUID(),
      stateDir: fake.stateDir,
      signal: controller.signal,
      log: { write: () => {} },
    })

    expect(result.termination).toBe("cancelled_by_operator")
  })
})

describe("the audio-CD path under supervision", () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  const setup = async (
    script: string,
    root?: string,
  ): Promise<BayRipInput> => {
    const destinationRoot =
      root ??
      (await mkdtemp(join(tmpdir(), "cyanrip-audio-")))
    if (root === undefined) dirs.push(destinationRoot)
    const tool = join(
      destinationRoot,
      `cyanrip-${randomUUID()}.cjs`,
    )
    await writeFile(tool, script)
    const config = createWatcherConfig({
      RIP_DECK_DEST: destinationRoot,
      RIP_DECK_STATE_DIR: join(destinationRoot, "state"),
    })
    config.cyanrip = {
      command: process.execPath,
      prefixArgs: [tool],
      wrapperArgs: null,
    }
    return {
      config,
      driveId: "test-drive",
      bay: 1,
      name: "Test drive",
      kernelName: "sr0",
      devPath: "/dev/sr0",
      jobUuid: randomUUID(),
      readOffsetSamples: null,
      signal: new AbortController().signal,
      note: vi.fn(),
      onRipStarted: vi.fn(),
      onIdentified: vi.fn(),
      onDestination: vi.fn(),
      onProgress: vi.fn(),
    }
  }

  it("fails a stalled CD as stall_timeout and keeps its output", async () => {
    const input = await setup("setInterval(() => {}, 1000)")

    const outcome = await ripAudioCd({
      input,
      capacityBytes: 65536,
      watchdog: {
        assess: () => ({
          kind: "hung",
          action: "abandon",
          msSinceProgress: 0,
          msSinceEvent: 0,
          reason: "No forward progress.",
        }),
        intervalMs: 10,
      },
    })

    expect(outcome.kind).toBe("failed")
    expect(outcome.failureReason).toBe("stall_timeout")
    expect(outcome.detail).toContain("No forward progress.")
    expect(outcome.detail).toContain("Partial output KEPT")
  })

  it("hands cyanrip's progress to the bay", async () => {
    const input = await setup(String.raw`
const fs = require('node:fs');
process.stdout.write('Disc tracks:    1\n');
process.stdout.write('\rRipping and encoding track 1, progress - 100.00%, ETA - 0s\n');
fs.mkdirSync('Album');
fs.writeFileSync('Album/01.flac', 'fixture');
`)

    const outcome = await ripAudioCd({
      input,
      capacityBytes: 65536,
    })

    expect(outcome.kind).toBe("completed")
    expect(input.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ totalFraction: 1 }),
    )
  })

  it("⚠️ lands two same-name albums finishing at once side by side", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cyanrip-audio-race-"),
    )
    dirs.push(root)
    const script = `
const fs = require('node:fs');
fs.mkdirSync('Same Album');
fs.writeFileSync('Same Album/01.flac', process.cwd());
`
    const inputs = await Promise.all([
      setup(script, root),
      setup(script, root),
    ])

    const outcomes = await Promise.all(
      inputs.map((input) =>
        ripAudioCd({ input, capacityBytes: 65536 }),
      ),
    )

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(
      ["completed", "completed"],
    )

    const albums = (await readdir(root)).filter((name) =>
      name.startsWith("Same Album"),
    )

    expect(albums).toHaveLength(2)

    const contents = await Promise.all(
      albums.map((album) =>
        readFile(join(root, album, "01.flac"), "utf8"),
      ),
    )

    // Each album still holds its OWN rip.
    expect(new Set(contents).size).toBe(2)
  })
})

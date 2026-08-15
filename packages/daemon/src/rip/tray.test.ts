import { describe, expect, it } from "vitest"
import {
  buildTrayArgs,
  resolveEjectCommand,
  runTrayCommand,
  TRAY_TUNING,
  type TrayDeps,
  type TrayProcessResult,
} from "./tray.ts"

/**
 * Moving a tray.
 *
 * The assertions that matter here are the failure ones. A tray
 * command that reports success it did not have is worse than one
 * that fails: the operator walks to the tower expecting an open
 * drawer, and the deployed image — which has no `eject` binary
 * until it is rebuilt — is exactly the case that would produce
 * that.
 */

const fakeDeps = (input: {
  result?: TrayProcessResult
  isNeverSettling?: boolean
  onKill?: () => void
  onSpawn?: (params: {
    command: string
    args: string[]
  }) => void
}): TrayDeps => ({
  startProcess: (params) => {
    input.onSpawn?.(params)

    return {
      kill: () => input.onKill?.(),
      settled:
        input.isNeverSettling === true
          ? new Promise<TrayProcessResult>(() => {})
          : Promise.resolve(
              input.result ?? {
                exitCode: 0,
                stderr: "",
                spawnErrorCode: null,
              },
            ),
    }
  },
})

describe("resolveEjectCommand", () => {
  it("defaults to the bare binary", () => {
    expect(resolveEjectCommand(undefined)).toEqual({
      command: "eject",
      prefixArgs: [],
    })
  })

  it("keeps a wrapper's args in front", () => {
    // The same seam `RIP_DECK_MAKEMKVCON` has, and for the same
    // reason: pointing this at another container must not need
    // a rebuild.
    expect(
      resolveEjectCommand("docker exec rip-deck eject"),
    ).toEqual({
      command: "docker",
      prefixArgs: ["exec", "rip-deck", "eject"],
    })
  })
})

describe("buildTrayArgs", () => {
  it("opens with --cdrom and closes with --trayclose", () => {
    expect(
      buildTrayArgs({
        action: "open",
        devPath: "/dev/sr3",
      }),
    ).toEqual(["--cdrom", "/dev/sr3"])

    expect(
      buildTrayArgs({
        action: "close",
        devPath: "/dev/sr3",
      }),
    ).toEqual(["--trayclose", "/dev/sr3"])
  })

  it("never passes -n, -T or -m", () => {
    // `-n` is --noop (moves nothing), `-T` is toggle (would
    // close a tray we were asked to open). Both are one
    // keystroke from the flags we do want.
    const args = [
      ...buildTrayArgs({
        action: "open",
        devPath: "/dev/sr0",
      }),
      ...buildTrayArgs({
        action: "close",
        devPath: "/dev/sr0",
      }),
    ]

    expect(args).not.toContain("-n")
    expect(args).not.toContain("-T")
    expect(args).not.toContain("-m")
  })
})

describe("runTrayCommand", () => {
  it("spawns the wrapper prefix before the tray args", async () => {
    const spawned: { command: string; args: string[] }[] =
      []

    await runTrayCommand(
      {
        action: "open",
        devPath: "/dev/sr3",
        eject: resolveEjectCommand(
          "docker exec rip-deck eject",
        ),
      },
      fakeDeps({
        onSpawn: (params) => {
          spawned.push(params)
        },
      }),
    )

    expect(spawned).toEqual([
      {
        command: "docker",
        args: [
          "exec",
          "rip-deck",
          "eject",
          "--cdrom",
          "/dev/sr3",
        ],
      },
    ])
  })

  it("names a missing eject binary as a DEPLOYMENT fault", async () => {
    // The whole point of `isCommandMissing`. No `node:24-*-slim`
    // base carries `eject`; the Dockerfile installs it, and the
    // deployed image has had it since 0.7.x. This is what any
    // image built WITHOUT that line does — and "eject: not
    // found" would send someone to the tower to look at a drive
    // that is fine.
    const result = await runTrayCommand(
      {
        action: "open",
        devPath: "/dev/sr3",
        eject: resolveEjectCommand(undefined),
      },
      fakeDeps({
        result: {
          exitCode: null,
          stderr: "spawn eject ENOENT",
          spawnErrorCode: "ENOENT",
        },
      }),
    )

    expect(result.isSuccessful).toBe(false)
    expect(result.isCommandMissing).toBe(true)
    expect(result.detail).toContain("rebuilding")
  })

  it("reports a non-zero exit with eject's own words", async () => {
    const result = await runTrayCommand(
      {
        action: "open",
        devPath: "/dev/sr3",
        eject: resolveEjectCommand(undefined),
      },
      fakeDeps({
        result: {
          exitCode: 1,
          stderr: "eject: /dev/sr3: unable to eject\n",
          spawnErrorCode: null,
        },
      }),
    )

    expect(result.isSuccessful).toBe(false)
    expect(result.isCommandMissing).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.detail).toContain("unable to eject")
  })

  it("gives up on a drive that never answers, and kills it", async () => {
    // A drive wedged in SCSI error recovery blocks for up to
    // 600 s. The operator gets an answer in twenty milliseconds
    // instead, which is the difference between a reported
    // failure and a button that appears to do nothing.
    let isKilled = false

    const result = await runTrayCommand(
      {
        action: "open",
        devPath: "/dev/sr3",
        eject: resolveEjectCommand(undefined),
        timeoutMs: 20,
      },
      fakeDeps({
        isNeverSettling: true,
        onKill: () => {
          isKilled = true
        },
      }),
    )

    expect(result.isTimedOut).toBe(true)
    expect(result.isSuccessful).toBe(false)
    expect(isKilled).toBe(true)
  })

  it("reports success only on exit 0", async () => {
    const result = await runTrayCommand(
      {
        action: "close",
        devPath: "/dev/sr3",
        eject: resolveEjectCommand(undefined),
      },
      fakeDeps({}),
    )

    expect(result).toEqual({
      isSuccessful: true,
      isCommandMissing: false,
      isTimedOut: false,
      exitCode: 0,
      detail: "closed",
    })
  })
})

describe("TRAY_TUNING", () => {
  it("bounds a tray command well under a rip's patience", () => {
    // Not a claim about trays (they take about a second) — a
    // bound on a drive that has stopped answering.
    expect(
      TRAY_TUNING.commandTimeoutMs,
    ).toBeLessThanOrEqual(30_000)
  })
})

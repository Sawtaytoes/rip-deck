import { spawn } from "node:child_process"
import { firstValueFrom, from, raceWith } from "rxjs"
import { unrefTimeout } from "./unrefTimers.ts"

/**
 * Open and close an optical tray, on an operator's command.
 *
 * ## Why this exists at all, given "rip-deck never ejects"
 *
 * It does not say that, and the claim that it did was a
 * documentation bug. The recorded rule is **"never eject-loop"**
 * ([decision](docs/decisions/2026-07-26-auto-rip-every-inserted-disc-concurrently.md)),
 * a ban on rip-deck ejecting *as part of the rip cycle* — because
 * an insert/eject flap-storm is the documented root cause that
 * killed valid rips in other bays. That rule was widened into
 * "rip-deck exposes no eject at all" across three documents and
 * one UI, and the owner never agreed to it: *"I was wanting it
 * to auto-eject after ripping."*
 * (`docs/HANDOFF-eject-and-open-questions.md` §1.)
 *
 * So: **nothing in `watcher.ts` calls this.** The only caller is
 * the MQTT command surface, i.e. a human pressing a button. An
 * operator command is not a loop; nothing re-inserts, so no
 * flap-storm is reachable from here.
 *
 * ## Why a spawned binary rather than an in-process ioctl
 *
 * Opening a tray is `ioctl(fd, CDROMEJECT)` (0x5309); closing it
 * is `CDROMCLOSETRAY` (0x5319). Two reasons not to reach for
 * them directly:
 *
 *  1. **Node cannot.** There is no `ioctl` in `node:fs` or
 *     anywhere else in core, so "issue the ioctl directly" means
 *     a native addon or an FFI shim — a compiler in the image
 *     and a binary artefact, to replace a 30 KB Debian package.
 *  2. **It would break a hard constraint even if it could.**
 *     `AGENTS.md`: *never block the parent process on a device
 *     call.* A `CDROMEJECT` on a drive wedged in SCSI error
 *     recovery blocks for up to 600 s, and the whole
 *     child-per-drive architecture exists so that one wedged
 *     drive costs one bay rather than all nine plus the API. An
 *     in-process ioctl in the watcher's own process is precisely
 *     the call that architecture forbids. A spawned child is
 *     already off the event loop, is killable, and takes its
 *     watchdog for free.
 *
 * ⚠️ **`eject` comes from the `Dockerfile`, not from the base.**
 * No `node:24-*-slim` carries one; the image installs it. That
 * used to say "`eject` is NOT in the deployed image", which was
 * true until the rebuild that shipped it — verified present in
 * the live `rip-deck:0.7.2` (util-linux 2.38.1) and in every
 * image since. The `isCommandMissing` path stays, because it is
 * the correct report for any image built without it: "eject
 * exited 127" would send someone to look at a drive that is
 * fine, and this says *deployment* instead.
 *
 * ## Where it runs
 *
 * In the **long-running** container, which has `/dev`
 * bind-mounted and the device cgroup rules for `/dev/srN`. NOT
 * under per-rip device isolation: that exists because
 * `makemkvcon backup` re-scans the whole bus, which has nothing
 * to do with a tray, and spinning up a container per tray press
 * would put a docker round-trip between the button and the
 * drive.
 */

export const TRAY_TUNING = {
  /**
   * How long one tray command gets before it is abandoned.
   *
   * A tray takes about a second. Twenty is not a guess about
   * trays, it is a bound on a drive that has stopped answering:
   * the operator gets a per-bay "timed out" line instead of a
   * button press that never reports anything, which is the
   * failure mode this whole command surface exists to avoid.
   */
  commandTimeoutMs: 20_000,
} as const

/** Which way the tray goes. */
export type TrayAction = "open" | "close"

/**
 * How to invoke `eject`.
 *
 * A command VECTOR rather than a path, for the same reason
 * `resolveMakemkvCommand` is one: it has to be possible to point
 * this at a wrapper (`docker exec rip-deck eject`) from an
 * environment variable without a rebuild. Splitting on
 * whitespace is intentionally dumb — a path with spaces would
 * need quoting rules that are a bigger footgun than the case
 * they solve.
 */
export type EjectCommand = {
  command: string
  prefixArgs: string[]
}

export const resolveEjectCommand = (
  raw: string | undefined,
): EjectCommand => {
  const parts = (raw ?? "eject").trim().split(/\s+/)

  return {
    command: parts[0],
    prefixArgs: parts.slice(1),
  }
}

/**
 * The `eject` args for one tray, in one place.
 *
 * `--cdrom` / `--trayclose` are spelled out rather than `-r` /
 * `-t` because `-t` and `-T` (toggle) differ by a shift key and
 * a toggle would close a tray the operator just asked to open.
 *
 * ⚠️ Deliberately NOT `-n`. In `eject(1)` that is `--noop`,
 * which prints the device it found and moves nothing — a flag
 * whose name reads like "no unmount" and does the opposite of
 * what it looks like. `--no-unmount` is `-m`, and it is not
 * passed either: MakeMKV reads the raw device and never mounts a
 * disc, so there is normally nothing to unmount, and on the rare
 * disc something else did mount, unmounting first is correct.
 */
export const buildTrayArgs = (input: {
  action: TrayAction
  devPath: string
}): string[] => [
  input.action === "open" ? "--cdrom" : "--trayclose",
  input.devPath,
]

/** What the child process did. */
export type TrayProcessResult = {
  exitCode: number | null
  /** `eject`'s own words, for the operator-facing detail. */
  stderr: string
  /**
   * `spawn` never produced a process — `ENOENT` when the image
   * has no `eject`, `EACCES` when it is not executable.
   */
  spawnErrorCode: string | null
}

/** A started child, plus the handle to give up on it. */
export type TrayProcess = {
  settled: Promise<TrayProcessResult>
  kill: () => void
}

export type TrayDeps = {
  startProcess: (input: {
    command: string
    args: string[]
  }) => TrayProcess
}

export const defaultTrayDeps: TrayDeps = {
  startProcess: ({ command, args }) => {
    const child = spawn(command, args, {
      // stdin CLOSED, matching every other spawn here: a tool
      // that decides to ask a question must fail fast rather
      // than sit holding the drive forever.
      stdio: ["ignore", "ignore", "pipe"],
    })

    let stderr = ""

    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded: a runaway child must not be able to grow the
      // daemon's heap through an error path.
      if (stderr.length < 4_000) stderr += chunk.toString()
    })

    return {
      kill: () => {
        child.kill("SIGKILL")
      },
      settled: new Promise<TrayProcessResult>((resolve) => {
        child.once(
          "error",
          (error: NodeJS.ErrnoException) =>
            resolve({
              exitCode: null,
              stderr: error.message,
              spawnErrorCode: error.code ?? "UNKNOWN",
            }),
        )

        child.once("close", (exitCode) =>
          resolve({
            exitCode,
            stderr,
            spawnErrorCode: null,
          }),
        )
      }),
    }
  },
}

export type TrayResult = {
  isSuccessful: boolean
  /**
   * The image has no `eject` binary — i.e. it predates the
   * `Dockerfile` change that added the package, so this is a
   * DEPLOYMENT fault and no drive was touched.
   */
  isCommandMissing: boolean
  isTimedOut: boolean
  exitCode: number | null
  /** Plain language, already fit to read out loud. */
  detail: string
}

const TIMED_OUT = Symbol("tray-timed-out")

/**
 * Move one tray, and never hang the caller.
 *
 * The watchdog is `unrefTimeout` rather than RxJS's own
 * `timeout`, for the reason `unrefTimers.ts` exists: RxJS
 * schedules through `asyncScheduler`, whose handles are ref'd,
 * and a ref'd timer here would stop `rip-deck rip` exiting.
 *
 * On a timeout the child is SIGKILLed and the result is reported
 * as timed out. A drive wedged in D-state will not die to
 * SIGKILL either — but by then we have already answered the
 * operator, which is the whole point.
 */
export const runTrayCommand = async (
  input: {
    action: TrayAction
    devPath: string
    eject: EjectCommand
    timeoutMs?: number
  },
  deps: TrayDeps = defaultTrayDeps,
): Promise<TrayResult> => {
  const process = deps.startProcess({
    command: input.eject.command,
    args: [
      ...input.eject.prefixArgs,
      ...buildTrayArgs({
        action: input.action,
        devPath: input.devPath,
      }),
    ],
  })

  const settled = await firstValueFrom(
    from(process.settled).pipe(
      raceWith(
        unrefTimeout<typeof TIMED_OUT>({
          delayMs:
            input.timeoutMs ?? TRAY_TUNING.commandTimeoutMs,
          value: TIMED_OUT,
        }),
      ),
    ),
  )

  if (settled === TIMED_OUT) {
    process.kill()

    return {
      isSuccessful: false,
      isCommandMissing: false,
      isTimedOut: true,
      exitCode: null,
      detail:
        `the drive did not answer within ` +
        `${String(
          input.timeoutMs ?? TRAY_TUNING.commandTimeoutMs,
        )}ms, so the tray command was abandoned`,
    }
  }

  if (settled.spawnErrorCode === "ENOENT") {
    // Said in these words on purpose. "eject: not found" would
    // read as a drive problem and send someone to the tower;
    // this is a container that has not been rebuilt.
    return {
      isSuccessful: false,
      isCommandMissing: true,
      isTimedOut: false,
      exitCode: null,
      detail:
        "this Rip-Deck image has no `eject` binary, so no tray " +
        "could be moved. The Dockerfile installs it — the " +
        "image needs rebuilding and redeploying.",
    }
  }

  if (settled.spawnErrorCode !== null) {
    return {
      isSuccessful: false,
      isCommandMissing: false,
      isTimedOut: false,
      exitCode: null,
      detail: `could not run eject (${settled.spawnErrorCode})`,
    }
  }

  if (settled.exitCode !== 0) {
    return {
      isSuccessful: false,
      isCommandMissing: false,
      isTimedOut: false,
      exitCode: settled.exitCode,
      detail:
        `eject exited ${String(settled.exitCode)}` +
        (settled.stderr.trim() === ""
          ? ""
          : `: ${settled.stderr.trim()}`),
    }
  }

  return {
    isSuccessful: true,
    isCommandMissing: false,
    isTimedOut: false,
    exitCode: 0,
    detail: input.action === "open" ? "opened" : "closed",
  }
}

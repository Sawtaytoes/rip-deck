import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { createInterface } from "node:readline"
import type {
  DrvEvent,
  JobProgress,
  MakemkvEvent,
} from "@rip-deck/contracts"
import { readScsiGenericPath } from "../drives/sysfs.ts"
import { evaluateJobHealth } from "../health/jobVerdict.ts"
import { refreshHealthGate } from "../health/publish.ts"
import { createSampleStore } from "../health/sampleStore.ts"
import { parseMakemkvLine } from "../makemkv/parseLine.ts"
import {
  checkFreeSpace,
  finaliseDestination,
  type PreparedDestination,
  pathExists,
  prepareDestination,
} from "./destination.ts"
import { verifyDiscIndex } from "./discIndex.ts"
import {
  createNullEventLog,
  type EventLog,
} from "./eventLog.ts"
import {
  countLine,
  createHeartbeat,
  ensureStateDir,
  flushHeartbeat,
} from "./heartbeat.ts"
import {
  assessLiveness,
  type Liveness,
} from "./liveness.ts"
import { parseProcStartTime } from "./orphan.ts"
import {
  createRipObservations,
  observeOutcomeEvent,
  type RipObservations,
  type RipSummary,
  type RipTermination,
  summariseRip,
} from "./outcome.ts"
import {
  createProgressTracker,
  observeEvent,
} from "./progress.ts"
import {
  buildInnerKillArgs,
  buildRipArgs,
  buildRipInvocation,
  hashArgv,
  type MakemkvCommand,
  type RipIsolation,
  resolveRipIsolation,
} from "./ripCommand.ts"
import { buildRipContext, startSampler } from "./sampler.ts"
import { verifyBackupStructure } from "./verifyBackup.ts"

/**
 * One rip, start to finish.
 *
 * This function IS the per-drive child's whole job. Everything
 * that touches the device happens here and nowhere else, which
 * is the architectural rule the project is built around: a drive
 * wedged in D-state must cost exactly one process, not the
 * monitoring of the other eight drives and the API along with it
 * (E2). One stray synchronous device call in the parent
 * reintroduces precisely the failure this design exists to
 * prevent, so it needs review discipline as much as code.
 */

/** How long a killed child gets to exit before SIGKILL. */
const TERMINATION_GRACE_MS = 10_000

/** How often liveness is re-assessed. */
const LIVENESS_INTERVAL_MS = 5_000

export type RipJobInput = {
  driveId: string
  /** Ephemeral, resolved immediately before the spawn. */
  devPath: string
  /**
   * MakeMKV's disc index for `devPath`, because `backup` takes
   * no device-scoped source. Checked against MakeMKV's own DRV
   * table once the rip starts — see `verifyDiscIndex`.
   *
   * Ignored when the rip is isolated: an index resolved against
   * the whole bus means nothing inside a container that can see
   * one drive.
   */
  discIndex: number
  /** Unique per job; also names the incomplete directory. */
  jobUuid: string
  /** Capacity of the disc, from sysfs. Drives ETA and preflight. */
  discBytes: number
  /** Dataset the finished rip lands in, as WE see it. */
  destinationRoot: string
  /**
   * The same dataset as makemkvcon sees it, when its filesystem
   * view differs from ours. Omit when they share one.
   */
  innerDestinationRoot?: string
  /** Final folder name, per requirement B2. */
  folderName: string
  /** Where heartbeats and job state live. */
  stateDir: string
  makemkv: MakemkvCommand
  /**
   * Run this rip in a container that can see only `devPath`.
   *
   * Optional, and resolved from the environment when omitted —
   * deliberately, so that turning isolation on is a deployment
   * change rather than a code change, and so the callers that
   * predate it keep working untouched. A daemon that grows real
   * config should pass it explicitly; the parameter is already
   * here for that.
   *
   * Pass `null` to force isolation off regardless of the
   * environment.
   */
  isolation?: RipIsolation | null
  /**
   * Raw robot-mode capture.
   *
   * Optional and off by default, but the first real rip proved
   * why it should usually be on: the answer to "why did this
   * fail" had gone to a closed pipe, and recovering it cost a
   * second 25-minute rip.
   */
  eventLog?: EventLog
  /** Operator has answered "keep trying" (D4). */
  isKeepTryingRequested?: boolean
  /** Cancels the rip cleanly (E5). */
  signal?: AbortSignal
}

export type RipJobHandlers = {
  onSpawn?: (claim: {
    pid: number
    startTimeTicks: number | null
    argvHash: string
    incompletePath: string
  }) => void
  onProgress?: (progress: JobProgress) => void
  onLiveness?: (liveness: Liveness) => void
  onEvent?: (event: MakemkvEvent) => void
}

export type RipJobResult = RipSummary & {
  termination: RipTermination
  exitCode: number | null
  observations: RipObservations
  progress: JobProgress
  /** Where the rip ended up, on success. */
  destinationPath: string | null
  /**
   * Partial output that was KEPT, on failure.
   *
   * Deliberately not deleted. A rip that failed at 90% is worth
   * far more than the disk space it occupies, and requirement D4
   * says to offer "keep trying" rather than only auto-abort —
   * which is impossible if we have already thrown the bytes
   * away. Cleanup is the operator's "give up", not ours.
   */
  incompletePath: string | null
  /** The intended name was taken; a human must reconcile. */
  hasCollision: boolean
  /**
   * The device MakeMKV actually opened, when it was not ours.
   *
   * Non-null only alongside `failureReason: "wrong_drive"`. Kept
   * because "the index moved" is unactionable on its own — what
   * the operator needs is which bay it moved to.
   */
  wrongDriveDevPath: string | null
  /**
   * Why the structural check failed, in plain language.
   *
   * Null when the check passed, or when it never ran (a
   * non-zero exit, a termination we caused).
   *
   * ⚠️ **This used to be computed and thrown away**, and the
   * cost was measured: `empty_output` on its own says a backup
   * produced nothing, which is the same sentence for "the
   * destination is not there", "the output is a file with no
   * ISO9660 signature in it" and "only 3.9 GB landed for a
   * 7.5 GB disc". Those want three different actions, and on
   * 2026-08-27 the bare reason cost a full investigation before
   * anybody could say which of them had happened.
   * `verifyBackupStructure` already writes the sentence.
   */
  verificationFailure: string | null
  /**
   * The child's stderr.
   *
   * Robot mode puts everything useful on stdout, so stderr is
   * usually empty — which is exactly why it is worth keeping.
   * When makemkvcon fails to start at all (missing key, missing
   * binary, no permission on the device) the reason appears
   * here and nowhere else.
   */
  stderr: string
}

export const runRipJob = async (
  input: RipJobInput,
  handlers: RipJobHandlers = {},
): Promise<RipJobResult> => {
  const observations = createRipObservations()

  // --- Preflight, before anything is spawned. --------------
  // Running out of room mid-rip wastes the entire read, and the
  // disc's size is known up front, so there is no excuse.
  const space = await checkFreeSpace({
    rootPath: input.destinationRoot,
    discBytes: input.discBytes,
  })

  if (!space.hasEnoughSpace) {
    return {
      ...summariseRip({
        observations,
        exitCode: null,
        termination: "insufficient_space",
      }),
      termination: "insufficient_space",
      exitCode: null,
      observations,
      progress: createProgressTracker({
        discBytes: input.discBytes,
        startedAtMs: Date.now(),
      }).progress,
      destinationPath: null,
      incompletePath: null,
      hasCollision: false,
      wrongDriveDevPath: null,
      verificationFailure: null,
      stderr: "",
    }
  }

  await ensureStateDir(input.stateDir)

  const prepared = prepareDestination({
    rootPath: input.destinationRoot,
    folderName: input.folderName,
    jobUuid: input.jobUuid,
    innerRootPath: input.innerDestinationRoot,
  })

  return await superviseChild(input, handlers, prepared)
}

const superviseChild = async (
  input: RipJobInput,
  handlers: RipJobHandlers,
  prepared: PreparedDestination,
): Promise<RipJobResult> => {
  const startedAtMs = Date.now()

  // Per-rip device isolation, when the deployment supplies it.
  // `backup` re-enumerates the whole bus no matter what we ask
  // of it, so the only way to stop a wedged sibling delaying this
  // rip is to make the sibling structurally invisible.
  // Resolved fresh, immediately before the spawn, for the same
  // reason the disc index is: sgN renumbers on USB
  // re-enumeration exactly like srN.
  const scsiGenericPath = await readScsiGenericPath(
    basename(input.devPath),
  )

  const invocation = buildRipInvocation({
    scsiGenericPath,
    makemkv: input.makemkv,
    isolation:
      input.isolation === undefined
        ? resolveRipIsolation(process.env)
        : input.isolation,
    devPath: input.devPath,
    jobUuid: input.jobUuid,
    discIndex: input.discIndex,
  })

  const ripArgs = buildRipArgs({
    discIndex: invocation.discIndex,
    outputPath: prepared.incompleteInnerPath,
  })

  const argv = [
    ...invocation.makemkv.prefixArgs,
    ...ripArgs,
  ]

  let tracker = createProgressTracker({
    discBytes: input.discBytes,
    startedAtMs,
  })
  let observations = createRipObservations()
  let heartbeat = createHeartbeat({
    stateDir: input.stateDir,
    jobUuid: input.jobUuid,
  })

  // Feed the health engine while the rip runs.
  //
  // On by default, for the same reason raw capture is (§5): two
  // real rips have completed and every HEALTH_THRESHOLDS value is
  // still invented, because nothing has ever produced the data
  // that would let anyone tune them. An opt-in corpus is a corpus
  // nobody has.
  //
  // `readRipContext` is a PULL closure over the `let tracker`
  // binding rather than a push from the progress path, so the rip
  // loop never has to know a sampler exists — and a sampler fault
  // cannot wedge the rip.
  const sampler = startSampler({
    driveId: input.driveId,
    kernelName: basename(input.devPath),
    jobId: input.jobUuid,
    discBytes: input.discBytes,
    startedAtMs,
    store: await createSampleStore({
      stateDir: input.stateDir,
      jobUuid: input.jobUuid,
    }),
    readRipContext: () =>
      buildRipContext({
        tracker,
        nowMs: Date.now(),
        readErrorCount: observations.readErrorCount,
      }),
  })

  // Set as soon as we decide to stop it ourselves, so the exit
  // is attributed to the real cause rather than the exit code
  // the kill produces.
  let termination: RipTermination = "exited"

  const child = spawn(invocation.makemkv.command, argv, {
    // stdin is CLOSED, not inherited. A makemkvcon that decides
    // to ask a question must fail fast rather than inherit a
    // terminal and block forever holding the drive.
    stdio: ["ignore", "pipe", "pipe"],
  })

  const argvHash = hashArgv([
    invocation.makemkv.command,
    ...argv,
  ])

  child.once("spawn", () => {
    void readStartTimeTicks(child.pid).then(
      (startTimeTicks) =>
        handlers.onSpawn?.({
          pid: child.pid ?? -1,
          startTimeTicks,
          argvHash,
          incompletePath: prepared.incompletePath,
        }),
    )
  })

  let isStopping = false

  /**
   * Stop the child once, attributing the real cause.
   *
   * `reason: "exited"` means "kill it, but let the event stream
   * explain why" — used for the interactive-prompt case, where
   * the prompt itself is a more precise failure than any
   * termination label.
   */
  const stop = (reason: RipTermination) => {
    if (isStopping) return
    isStopping = true

    if (reason !== "exited") termination = reason

    child.kill("SIGTERM")
    killInsideContainer(
      invocation.makemkv,
      input.jobUuid,
      "TERM",
    )

    // SIGTERM is the polite ask. A makemkvcon blocked in a
    // device read will not answer it, and E5 says no orphaned
    // processes — so the escalation is not optional.
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL")
      killInsideContainer(
        input.makemkv,
        input.jobUuid,
        "KILL",
      )
    }, TERMINATION_GRACE_MS)

    killTimer.unref()
  }

  const onAbort = () => stop("cancelled_by_operator")
  input.signal?.addEventListener("abort", onAbort, {
    once: true,
  })

  // --- Liveness, on wall clock, independent of messages. ---
  // Requirement D3: the `sr` layer retries long before MakeMKV's
  // error counter moves, so a timer is the only honest detector.
  const livenessTimer = setInterval(() => {
    const liveness = assessLiveness({
      startedAtMs,
      lastForwardProgressAtMs:
        tracker.lastForwardProgressAtMs,
      lastEventAtMs: tracker.lastEventAtMs,
      nowMs: Date.now(),
      isKeepTryingRequested:
        input.isKeepTryingRequested ?? false,
    })

    handlers.onLiveness?.(liveness)

    if (liveness.action === "abandon") stop("stall_timeout")
  }, LIVENESS_INTERVAL_MS)

  livenessTimer.unref()

  // --- Parse stdout. ---------------------------------------
  const stdout = createInterface({ input: child.stdout })

  // `backup` re-scans the bus and re-emits the whole DRV table
  // before reading a byte, so the drive it actually opened is
  // knowable while it is still free to abort. Collected here and
  // checked once, because a stale disc index would otherwise rip
  // the wrong bay silently.
  //
  // Under isolation the table has one row and the check is very
  // nearly tautological. **It stays anyway**, for three reasons:
  // it costs nothing on a stream we are already parsing; it is
  // the only thing that catches a wrong `--device` or an
  // enumeration that does not number a lone drive 0 (assumed, not
  // measured — see ISOLATED_DISC_INDEX); and the error it guards
  // against is unrecoverable by inspection. A rip of the wrong
  // bay into the right folder name looks exactly like a good rip
  // forever after.
  const drvRows: DrvEvent[] = []
  let isDriveVerified = false
  let wrongDriveDevPath: string | null = null

  const eventLog = input.eventLog ?? createNullEventLog()

  stdout.on("line", (line) => {
    if (line.trim() === "") return

    // Raw, before parsing — a capture that has already been
    // through our parser cannot prove our parser right.
    eventLog.write(line)

    const atMs = Date.now()
    const event = parseMakemkvLine(line)

    if (event.type === "DRV" && !isDriveVerified) {
      drvRows.push(event)

      const verdict = verifyDiscIndex({
        drives: drvRows,
        discIndex: invocation.discIndex,
        expectedDevPath: input.devPath,
      })

      if (verdict !== null) {
        isDriveVerified = true

        if (!verdict.isMatch) {
          wrongDriveDevPath = verdict.actualDevPath
          stop("wrong_drive")
        }
      }
    }

    tracker = observeEvent({ tracker, event, atMs })
    observations = observeOutcomeEvent({
      observations,
      event,
    })

    const counted = countLine({ heartbeat, atMs })
    heartbeat = counted.heartbeat

    if (counted.isFlushDue) {
      // Never let a diagnostic write abort a running rip.
      void flushHeartbeat(heartbeat, atMs).catch(() => {})
    }

    handlers.onEvent?.(event)
    handlers.onProgress?.(tracker.progress)

    // BOXYESNO: makemkvcon is waiting for an answer that a robot
    // pipe will never supply. It will sit there holding the
    // drive forever, so this is a hang by another name — kill it
    // and keep the question, which is the one piece of
    // information that explains an otherwise silent wedge.
    if (observations.interactivePrompt !== null)
      stop("exited")
  })

  const stderrChunks: string[] = []
  child.stderr?.on("data", (chunk: Buffer) => {
    // Bounded: a broken makemkvcon can emit stderr indefinitely
    // and this must not become the reason a long rip runs a host
    // out of memory.
    if (stderrChunks.length < 200) {
      stderrChunks.push(chunk.toString("utf8"))
    }
  })

  const exitCode = await new Promise<number | null>(
    (resolve) => {
      child.once("error", () => resolve(null))
      child.once("close", (code) => resolve(code))
    },
  )

  clearInterval(livenessTimer)
  input.signal?.removeEventListener("abort", onAbort)
  stdout.close()

  await flushHeartbeat(heartbeat, Date.now()).catch(
    () => {},
  )

  await eventLog.close()

  // Backup mode has no title count, so completion is proven by
  // the dataset rather than by anything makemkvcon said. Only
  // worth the tree walk when the run otherwise looks clean.
  const verification =
    termination === "exited" && exitCode === 0
      ? await verifyBackupStructure({
          path: prepared.incompletePath,
          discBytes: input.discBytes,
        }).catch(() => null)
      : null

  const summary = summariseRip({
    observations,
    exitCode,
    termination,
    mode: "backup",
    hasVerifiedStructure: verification?.isVerified ?? false,
  })

  // Only when the check ran AND said no. A `null` verification
  // means it never ran, and reporting "nothing was written" for
  // a rip we killed ourselves would be a claim about a dataset
  // nobody looked at.
  const verificationFailure =
    verification === null || verification.isVerified
      ? null
      : verification.reason

  // Close the feature vector BEFORE the success branch, so a
  // FAILED rip is sampled too. A rip that went badly is the more
  // valuable row of the two — every assertion in the current
  // corpus is about a healthy disc (§3).
  //
  // The engine runs here, on the real path, for every job. What
  // it does NOT do is decide anything: its answer is written to
  // `<uuid>.verdict.json` beside the vector it judged, and is
  // stamped onto `outcome.verdictKind` only once the gate in
  // `health/publish.ts` has counted enough corpus to open. That
  // gate counts `*.features.json` in the state directory, so it
  // needs no flag flipped by hand and cannot go stale. Running
  // the engine before it opens is the point: the wiring is
  // already proven on the day the corpus arrives, and every
  // historical job can be asked "what would the engine have
  // said" without a re-rip.
  //
  // `verdictKind: null` is the caller's own answer — `runRipJob`
  // computes no verdict of its own, and never one that could
  // upgrade a rip `isRipSuccessful` already failed.
  await sampler.stop(
    {
      isSuccessful: summary.isSuccessful,
      failureReason: summary.failureReason,
      exitCode,
      verdictKind: null,
    },
    (vector) =>
      evaluateJobHealth({
        vector,
        evidence: {
          // The one thing the vector cannot carry: it keeps a
          // read-error count, and scratch-vs-dirt is a question
          // about WHERE the errors were.
          errorLbas: observations.errorLbas,
          hasKeyExpired: observations.hasKeyExpired,
          usbPortPath: input.driveId,
        },
      }),
  )

  // This rip just added a row to the corpus, which is the only
  // event that can move the gate. Re-count now rather than on a
  // timer: the count changes once per rip and never otherwise,
  // and the dashboard reads the answer synchronously.
  //
  // Swallowed for the same reason every other write on this path
  // is. A `readdir` that fails must cost the gate one refresh,
  // never a finished rip its result.
  await refreshHealthGate({
    stateDir: input.stateDir,
  }).catch(() => null)

  // --- Land it, or keep the partial output. ----------------
  if (!summary.isSuccessful) {
    // Only claim partial output when there IS some. `makemkvcon`
    // owns the creation of this directory now, so a rip that
    // failed before the backup began leaves no trace — and D4's
    // promise ("a killed rip keeps what it wrote") must not turn
    // into a path the operator cannot find.
    const hasPartialOutput = await pathExists(
      prepared.incompletePath,
    )

    return {
      ...summary,
      termination,
      exitCode,
      observations,
      progress: tracker.progress,
      destinationPath: null,
      incompletePath: hasPartialOutput
        ? prepared.incompletePath
        : null,
      hasCollision: false,
      wrongDriveDevPath,
      verificationFailure,
      stderr: stderrChunks.join(""),
    }
  }

  const finalised = await finaliseDestination(prepared)

  return {
    ...summary,
    termination,
    exitCode,
    observations,
    progress: tracker.progress,
    destinationPath: finalised.path,
    incompletePath: null,
    hasCollision: finalised.hasCollision,
    wrongDriveDevPath: null,
    verificationFailure: null,
    stderr: stderrChunks.join(""),
  }
}

/**
 * Reach into the container and kill the real makemkvcon.
 *
 * A no-op unless makemkvcon is being run through `docker exec`,
 * which does not proxy signals — killing our child there kills
 * only the client and leaves a makemkvcon holding the drive
 * forever (E5). Verified on Tower 2026-07-25.
 *
 * Under per-rip isolation the outer `docker run` client *does*
 * proxy signals, and `--init` gives them somewhere to land, so
 * this becomes a backstop rather than the mechanism. It is still
 * worth sending: a `docker run` client that has already died
 * (OOM, restarted daemon) leaves a container ripping happily on
 * its own, and `docker exec … pkill -f <uuid>` reaches it.
 *
 * Fire-and-forget: this is a best-effort backstop on top of the
 * signal we already sent, and failing to spawn `docker` must not
 * throw out of a `stop()` that is already handling a problem.
 */
const killInsideContainer = (
  makemkv: MakemkvCommand,
  jobUuid: string,
  signal: "TERM" | "KILL",
): void => {
  if (makemkv.wrapperArgs === null) return

  try {
    spawn(
      makemkv.command,
      buildInnerKillArgs({
        wrapperArgs: makemkv.wrapperArgs,
        jobUuid,
        signal,
      }),
      { stdio: "ignore" },
    ).on("error", () => {})
  } catch {
    // Nothing useful to do — the outer signal has already gone.
  }
}

/**
 * Read the child's start time for the orphan-adoption record.
 *
 * Best effort by design: failing to read it only means this job
 * cannot be adopted after a restart, which is a far better
 * outcome than refusing to start the rip at all.
 */
const readStartTimeTicks = async (
  pid: number | undefined,
): Promise<number | null> => {
  if (pid === undefined) return null

  try {
    return parseProcStartTime(
      await readFile(`/proc/${pid}/stat`, "utf8"),
    )
  } catch {
    return null
  }
}

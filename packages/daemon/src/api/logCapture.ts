import { open } from "node:fs/promises"
import { join } from "node:path"

/**
 * `GET /logs` — the raw MakeMKV capture for one job.
 *
 * The owner's question was *"if something goes wrong, do you
 * wanna see the log?"* The captures have existed all along —
 * `$RIP_DECK_STATE_DIR/<job_uuid>.robot.log`, 1–3 MB each, written
 * because a diagnosis must not cost a second rip — and the only
 * missing piece was serving them.
 *
 * Three constraints shape everything below.
 *
 * ⚠️ **Never a synchronous read.** A 3 MB `readFileSync` on the
 * request path is exactly the thing the child-per-drive
 * architecture exists to prevent: the parent process supervises
 * nine bays, and anything that blocks it blocks all of them plus
 * `/json`. Every read here is `node:fs/promises`, and the default
 * reads only the TAIL — the interesting part of a robot log is
 * the end.
 *
 * ⚠️ **`job` arrives from a URL, so it is never trusted.** It is
 * matched against the UUID shape before it is allowed anywhere
 * near a path join. `join(stateDir, "../../etc/passwd")` is a
 * real file, and this is the one place in the daemon where a
 * caller picks a filename.
 *
 * ⚠️ **A robot-mode log is a parsed format, not prose.** It is
 * served raw and byte-for-byte. Do not string-match it into a
 * summary — mistaking `MSG:5072` for a failure line is the
 * original sin this repo keeps re-learning.
 */

/**
 * The only `job` this will look up: `randomUUID()`'s output.
 *
 * Every real capture is named for a `randomUUID()` job id
 * (`rip/watcher.ts`, `cli.ts`), so anything else is either a
 * typo or an attempt to read a file that is not a capture —
 * including `api/towerFeed.ts`'s `<driveId>@<ms>` placeholder,
 * which names a bay that never got a job and therefore has
 * nothing on disk. An allow-list of one shape, rather than a
 * deny-list of traversal spellings: `..`, a NUL, a URL-encoded
 * slash and an absolute path all fail the same test.
 */
const JOB_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isSafeJobUuid = (jobUuid: string): boolean =>
  JOB_UUID_PATTERN.test(jobUuid)

/** What the capture is called. `job_uuid` in `/json` names it. */
export const logCaptureFilename = (
  jobUuid: string,
): string => `${jobUuid}.robot.log`

export const LOG_CAPTURE_TUNING = {
  /** What `?lines=` means when nobody says. */
  defaultLines: 600,
  /**
   * The ceiling on `?lines=`, above which `?all=1` is the honest
   * request. Not a safety limit — the whole-file cap below is —
   * just a refusal to pretend a number is a tail.
   */
  maxLines: 100_000,
  /**
   * First read for a tail, quadrupling until enough lines are in
   * hand. 128 KiB covers ~1500 robot-log lines, so the default
   * 600 is one read of a 3 MB file rather than three.
   */
  initialTailBytes: 128 * 1024,
  tailGrowthFactor: 4,
  /**
   * The most `?all=1` will ever return, from the END of the file.
   *
   * Real captures are 1–3 MB, so this never fires in practice.
   * It exists because "read the whole file into a string" with
   * no bound is one runaway logger away from an OOM in the
   * process that is supervising nine rips.
   */
  maxAllBytes: 64 * 1024 * 1024,
} as const

export type LogCaptureRequest = {
  jobUuid: string
  /** A tail of N lines, or the whole capture. */
  lines: number | "all"
}

export type LogCaptureResult =
  | { isFound: true; text: string }
  | { isFound: false }

export type LogCaptureReader = (
  request: LogCaptureRequest,
) => Promise<LogCaptureResult>

/**
 * The last `lines` lines, read backwards in growing windows.
 *
 * A window that does not reach the start of the file almost
 * certainly begins mid-line, so that first fragment is DROPPED
 * rather than served as a truncated line. That also disposes of
 * the split-UTF-8-codepoint problem at the window boundary: a
 * disc title in a robot log can be multi-byte, and the only byte
 * offset we cut at is the one whose line we throw away.
 */
const readTail = async (input: {
  read: (input: {
    byteCount: number
    fromOffset: number
  }) => Promise<string>
  sizeBytes: number
  lines: number
}): Promise<string> => {
  let windowBytes = Math.min(
    input.sizeBytes,
    LOG_CAPTURE_TUNING.initialTailBytes,
  )

  for (;;) {
    const isWholeFile = windowBytes >= input.sizeBytes

    const raw = await input.read({
      byteCount: windowBytes,
      fromOffset: input.sizeBytes - windowBytes,
    })

    // Kept and re-appended so the tail ends exactly as the file
    // does, rather than gaining or losing its final newline.
    const hasTrailingNewline = raw.endsWith("\n")

    const lines = (
      hasTrailingNewline ? raw.slice(0, -1) : raw
    ).split("\n")

    const usable = isWholeFile ? lines : lines.slice(1)

    if (usable.length >= input.lines || isWholeFile) {
      return (
        usable.slice(-input.lines).join("\n") +
        (hasTrailingNewline ? "\n" : "")
      )
    }

    windowBytes = Math.min(
      input.sizeBytes,
      windowBytes * LOG_CAPTURE_TUNING.tailGrowthFactor,
    )
  }
}

/**
 * Bind a reader to one state directory.
 *
 * A factory rather than a bare function so the router can be
 * built in a test with a reader that has no disk behind it at
 * all — the routing question (which path wins, what 400s) is
 * answerable without writing 3 MB of fixture.
 */
export const createLogCaptureReader = ({
  stateDir,
}: {
  stateDir: string
}): LogCaptureReader => {
  return async (request) => {
    // Belt and braces: the router checks this too, but a reader
    // handed a bad id from anywhere must not join it into a
    // path. The check is worthless if it lives in only one of
    // the two places a caller could enter.
    if (!isSafeJobUuid(request.jobUuid)) {
      return { isFound: false }
    }

    const path = join(
      stateDir,
      logCaptureFilename(request.jobUuid),
    )

    let handle: Awaited<ReturnType<typeof open>>

    try {
      handle = await open(path, "r")
    } catch {
      // A job with no capture is a 404, not a 500: raw capture
      // can be off, and an adopted bay from a previous daemon
      // may predate the file entirely.
      return { isFound: false }
    }

    try {
      const { size } = await handle.stat()

      const read = async (input: {
        byteCount: number
        fromOffset: number
      }): Promise<string> => {
        const buffer = Buffer.alloc(input.byteCount)

        await handle.read(
          buffer,
          0,
          input.byteCount,
          input.fromOffset,
        )

        return buffer.toString("utf8")
      }

      if (request.lines === "all") {
        const byteCount = Math.min(
          size,
          LOG_CAPTURE_TUNING.maxAllBytes,
        )

        return {
          isFound: true,
          text: await read({
            byteCount,
            fromOffset: size - byteCount,
          }),
        }
      }

      return {
        isFound: true,
        text: await readTail({
          read,
          sizeBytes: size,
          lines: request.lines,
        }),
      }
    } finally {
      await handle.close()
    }
  }
}

/**
 * The daemon's state directory, from the environment.
 *
 * The default is duplicated from `rip/watcher.ts`'s
 * `createWatcherConfig` on purpose — importing the watcher into
 * the API for one string would drag the whole supervisor into
 * the module that must never touch a device. `main.ts` passes
 * the watcher's own `config.stateDir` explicitly, so the two
 * cannot disagree where it matters.
 */
export const readStateDir = (
  env: Record<string, string | undefined> = process.env,
): string => env.RIP_DECK_STATE_DIR ?? "/var/lib/rip-deck"

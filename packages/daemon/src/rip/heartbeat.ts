import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * The per-rip heartbeat file: `{timestamp} line={n}`.
 *
 * Five lines of behaviour borrowed from `-neu`, and worth far
 * more than its size. It is what separates *hung* from *dead*
 * from *slow-but-working* (D3) for anything outside this
 * process — a restarted daemon, a watchdog, or a human with
 * `cat` — because the two numbers answer different questions:
 * the timestamp says whether anything is happening at all, and
 * the line counter says whether what is happening is progress.
 *
 * It lives in the state directory rather than in the rip's own
 * output directory on purpose: the output directory gets
 * `rename()`d into the library on success, and a heartbeat file
 * riding along into the media library would be a permanent
 * little piece of litter in every folder.
 */

/**
 * Minimum gap between actual disk writes.
 *
 * The line counter stays exact — only the flushing is throttled.
 * makemkvcon emits progress several times a second, so writing
 * on literally every parsed line would mean six figures of
 * one-line writes over a three-hour rip to record something
 * nothing reads at sub-second resolution.
 */
export const HEARTBEAT_FLUSH_INTERVAL_MS = 1_000

export type Heartbeat = {
  path: string
  lineCount: number
  /** Null until the first flush, so the first line always writes. */
  lastFlushAtMs: number | null
}

export const heartbeatPath = (
  stateDir: string,
  jobUuid: string,
): string => join(stateDir, `${jobUuid}.heartbeat`)

export const createHeartbeat = (input: {
  stateDir: string
  jobUuid: string
}): Heartbeat => ({
  path: heartbeatPath(input.stateDir, input.jobUuid),
  lineCount: 0,
  lastFlushAtMs: null,
})

/** Format is deliberately greppable and human-readable. */
export const formatHeartbeat = (input: {
  atMs: number
  lineCount: number
}): string =>
  `${new Date(input.atMs).toISOString()} ` +
  `line=${input.lineCount}\n`

/**
 * Count a parsed line, flushing at most once per interval.
 *
 * Returns the new heartbeat state and whether a write is due, so
 * the decision stays pure and the caller owns the I/O.
 */
export const countLine = (input: {
  heartbeat: Heartbeat
  atMs: number
}): { heartbeat: Heartbeat; isFlushDue: boolean } => {
  const lineCount = input.heartbeat.lineCount + 1

  // The first line always writes: a rip that dies in its first
  // second must still leave evidence that it started at all.
  const isFlushDue =
    input.heartbeat.lastFlushAtMs === null ||
    input.atMs - input.heartbeat.lastFlushAtMs >=
      HEARTBEAT_FLUSH_INTERVAL_MS

  return {
    heartbeat: {
      ...input.heartbeat,
      lineCount,
      lastFlushAtMs: isFlushDue
        ? input.atMs
        : input.heartbeat.lastFlushAtMs,
    },
    isFlushDue,
  }
}

export const ensureStateDir = async (
  stateDir: string,
): Promise<void> => {
  await mkdir(stateDir, { recursive: true })
}

/**
 * Write the heartbeat.
 *
 * Failures are swallowed by the caller, never thrown: losing a
 * diagnostic file must never abort a three-hour rip that is
 * otherwise going fine.
 */
export const flushHeartbeat = async (
  heartbeat: Heartbeat,
  atMs: number,
): Promise<void> => {
  await writeFile(
    heartbeat.path,
    formatHeartbeat({
      atMs,
      lineCount: heartbeat.lineCount,
    }),
    "utf8",
  )
}

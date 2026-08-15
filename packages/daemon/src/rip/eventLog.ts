import {
  createWriteStream,
  type WriteStream,
} from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Append every raw robot-mode line to a file.
 *
 * Written after the first real rip, which cost us an answer we
 * should have had for free. The rip finished cleanly and
 * `rip-deck` called it a failure, and the evidence needed to say
 * WHY — which MSG code `backup` emits on completion — had gone
 * to a pipe that no longer existed. Diagnosing it meant a second
 * 25-minute rip.
 *
 * This is also the corpus the handoff has been asking for. ARM
 * cannot produce one: it parses stdout in-process and re-logs
 * only formatted text, so `MSG:`/`TINFO:` lines never reach
 * disk. `rip-deck parse` replays exactly this format, so every
 * captured rip becomes a regression test for the parser and for
 * the outcome logic.
 *
 * Deliberately raw and unparsed. A capture that has already been
 * through our parser cannot prove our parser right.
 */

export type EventLog = {
  write: (line: string) => void
  close: () => Promise<void>
}

/** A no-op log, so callers never branch on "is capture on". */
export const createNullEventLog = (): EventLog => ({
  write: () => {},
  close: async () => {},
})

export const createEventLog = async (input: {
  path: string
}): Promise<EventLog> => {
  await mkdir(dirname(input.path), { recursive: true })

  const stream: WriteStream = createWriteStream(
    input.path,
    {
      flags: "a",
    },
  )

  // A capture failing must never take down a rip that is
  // otherwise fine — this is diagnostics, not the job.
  stream.on("error", () => {})

  return {
    write: (line) => {
      stream.write(`${line}\n`)
    },
    close: () =>
      new Promise((resolve) => {
        stream.end(() => resolve())
      }),
  }
}

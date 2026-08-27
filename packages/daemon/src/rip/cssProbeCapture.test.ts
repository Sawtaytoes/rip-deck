import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseMakemkvLine } from "../makemkv/parseLine.ts"
import {
  createRipObservations,
  observeOutcomeEvent,
  summariseRip,
} from "./outcome.ts"

/**
 * The rip that made this change necessary, replayed.
 *
 * Slot 1 of the live tower, 2026-08-27: a CSS-protected DVD that
 * rode to `MSG:5070` / `MSG:5081` "Backup done" and left an
 * 8,070,922,240-byte ISO on the dataset. Rip Deck recorded
 * `fail`, reason `read_errors`, on the strength of ONE
 * `MSG:2003` — the scrambled-sector probe at offset 1 MB that
 * MakeMKV raises on every protected DVD before `mmgplsrv`
 * supplies the key.
 *
 * ## Why this capture is TRIMMED and the Blu-ray one is not
 *
 * The Blu-ray fixture beside it is 57k complete lines because
 * the claims made about it are about the whole stream — "no line
 * is malformed", "no read error anywhere". The claim here is
 * about the SHAPE at the two ends: what arrives before the
 * backup starts, and what arrives after it finishes. The 51,700
 * `PRGV:` lines in between prove nothing this file needs, so the
 * middle is dropped and the ends are byte-for-byte.
 *
 * The job uuid in `MSG:5072` is rewritten to a nil-ish one. It
 * is the only value in the capture that identifies a particular
 * run, and nothing here reads it.
 */

const capture = readFileSync(
  join(
    import.meta.dirname,
    "../makemkv/__fixtures__/real-dvd-backup-css-probe.robot.log",
  ),
  "utf8",
)

const observations = capture
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map(parseMakemkvLine)
  .reduce(
    (folded, event) =>
      observeOutcomeEvent({ observations: folded, event }),
    createRipObservations(),
  )

describe("the DVD backup that was badged failed", () => {
  it("saw exactly one MSG:2003, and counted it as zero read errors", () => {
    expect(observations.cssProbeErrorCount).toBe(1)
    expect(observations.readErrorCount).toBe(0)
  })

  it("saw the backup start and finish", () => {
    expect(observations.hasBackupStarted).toBe(true)
    expect(observations.hasBackupCompleted).toBe(true)
    expect(observations.hasFailureMessage).toBe(false)
  })

  it("is a clean success with nothing to warn about", () => {
    // The assertion this whole change exists for. Before it,
    // this same capture produced
    // `failureReason: "read_errors"`.
    const summary = summariseRip({
      observations,
      exitCode: 0,
      termination: "exited",
      mode: "backup",
      hasVerifiedStructure: true,
    })

    expect(summary.isSuccessful).toBe(true)
    expect(summary.failureReason).toBeNull()
    expect(summary.warnings).toEqual([])
  })
})

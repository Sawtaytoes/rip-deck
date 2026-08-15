import type { MakemkvEvent } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { parseMakemkvLine } from "../makemkv/parseLine.ts"
import {
  createRipObservations,
  observeOutcomeEvent,
  parseReadErrorLba,
  type RipObservations,
  summariseRip,
} from "./outcome.ts"

/**
 * These tests are the project's reason for existing. ARM reports
 * success on rips that had read errors and on rips that saved
 * zero titles, because `makemkvcon` exits 0 in both cases. Every
 * assertion below is a case where an exit-code check would say
 * "done" and be wrong.
 */

const fold = (lines: string[]): RipObservations =>
  lines
    .map(parseMakemkvLine)
    .reduce(
      (observations, event) =>
        observeOutcomeEvent({ observations, event }),
      createRipObservations(),
    )

const COPY_COMPLETE_ZERO =
  'MSG:5004,0,1,"Copy complete. 0 titles saved.",' +
  '"Copy complete. %1 titles saved.","0"'

const COPY_COMPLETE_THREE =
  'MSG:5004,0,1,"Copy complete. 3 titles saved.",' +
  '"Copy complete. %1 titles saved.","3"'

const READ_ERROR =
  "MSG:2003,16,3,\"Error 'Scsi error - MEDIUM ERROR:" +
  "UNRECOVERED READ ERROR' occurred while reading " +
  "'/BDMV/STREAM/00001.m2ts' at offset '2097152'\"," +
  "\"Error '%1' occurred while reading '%2' at offset " +
  '\'%3\'","Scsi error","/BDMV/STREAM/00001.m2ts",' +
  '"2097152"'

describe("the silent-success trap (ARM #1298)", () => {
  it("fails a rip that saved zero titles despite exit 0", () => {
    const summary = summariseRip({
      observations: fold([COPY_COMPLETE_ZERO]),
      exitCode: 0,
      termination: "exited",
    })

    expect(summary.isSuccessful).toBe(false)
    expect(summary.failureReason).toBe("no_titles_saved")
    expect(summary.titlesSaved).toBe(0)
  })

  it("fails a rip that had read errors despite exit 0", () => {
    const summary = summariseRip({
      observations: fold([READ_ERROR, COPY_COMPLETE_THREE]),
      exitCode: 0,
      termination: "exited",
    })

    expect(summary.isSuccessful).toBe(false)
    expect(summary.failureReason).toBe("read_errors")
    // The titles really were saved; that is what makes this
    // dangerous. Success is still false.
    expect(summary.titlesSaved).toBe(3)
  })

  it("passes only a clean rip", () => {
    const summary = summariseRip({
      observations: fold([COPY_COMPLETE_THREE]),
      exitCode: 0,
      termination: "exited",
      mode: "mkv",
    })

    expect(summary.isSuccessful).toBe(true)
    expect(summary.failureReason).toBeNull()
  })

  it("fails when makemkvcon never reported completion", () => {
    // No MSG:5004 at all — the process died before finishing.
    // Mode is explicit: 5004 is an mkv-mode message, and asking
    // for it in backup mode fails every good rip.
    const summary = summariseRip({
      observations: fold([]),
      exitCode: 0,
      termination: "exited",
      mode: "mkv",
    })

    expect(summary.isSuccessful).toBe(false)
    expect(summary.failureReason).toBe("unknown")
  })

  it("fails on a non-zero exit even with titles saved", () => {
    const summary = summariseRip({
      observations: fold([COPY_COMPLETE_THREE]),
      exitCode: 1,
      termination: "exited",
      mode: "mkv",
    })

    expect(summary.isSuccessful).toBe(false)
  })
})

describe("reason precedence", () => {
  it("blames the errors, not the symptom, when both", () => {
    // Read errors AND zero titles: the errors are the cause and
    // are what the owner can act on.
    const summary = summariseRip({
      observations: fold([READ_ERROR, COPY_COMPLETE_ZERO]),
      exitCode: 0,
      termination: "exited",
    })

    expect(summary.failureReason).toBe("read_errors")
  })

  it("puts key expiry above any disc verdict", () => {
    const keyExpired =
      'MSG:5021,0,0,"The MakeMKV trial period has expired.",' +
      '"%1","expired"'

    const summary = summariseRip({
      observations: fold([
        READ_ERROR,
        keyExpired,
        COPY_COMPLETE_ZERO,
      ]),
      exitCode: 0,
      termination: "exited",
    })

    // Reading this as a dirty disc would send the owner to clean
    // nine discs that are all perfectly fine (D8).
    expect(summary.failureReason).toBe("key_expired")
  })

  it("lets an external termination outrank the exit code", () => {
    const summary = summariseRip({
      observations: fold([COPY_COMPLETE_THREE]),
      exitCode: 0,
      termination: "cancelled_by_operator",
    })

    expect(summary.isSuccessful).toBe(false)
    expect(summary.failureReason).toBe(
      "cancelled_by_operator",
    )
  })
})

describe("BOXYESNO — a question is a hang", () => {
  // flags & 3854 === 776. makemkvcon is waiting for an answer
  // that a robot-mode pipe will never supply.
  const prompt =
    'MSG:5100,776,0,"The disc appears to be copy protected. ' +
    'Continue?","%1","x"'

  it("records the question rather than losing it", () => {
    const observations = fold([prompt])

    expect(observations.interactivePrompt).toContain(
      "copy protected",
    )
  })

  it("fails the rip even if it later exits 0", () => {
    const summary = summariseRip({
      observations: fold([prompt, COPY_COMPLETE_THREE]),
      exitCode: 0,
      termination: "exited",
    })

    expect(summary.isSuccessful).toBe(false)
    expect(summary.failureReason).toBe("interactive_prompt")
  })
})

describe("read-error LBAs", () => {
  it("converts a byte offset to a sector", () => {
    expect(
      parseReadErrorLba(["Scsi error", "file", "2097152"]),
    ).toBe(1024)
  })

  it("ignores small integers, which are codes not offsets", () => {
    expect(parseReadErrorLba(["3", "16"])).toBeNull()
  })

  it("rejects values with trailing junk", () => {
    // Truncating "123abc" to 123 would invent a disc offset out
    // of something that was never one.
    expect(parseReadErrorLba(["123abc"])).toBeNull()
  })

  it("accumulates LBAs for the scratch-vs-dirt classifier", () => {
    const observations = fold([READ_ERROR, READ_ERROR])

    expect(observations.readErrorCount).toBe(2)
    expect(observations.errorLbas).toEqual([1024, 1024])
  })
})

describe("parser health", () => {
  it("counts malformed lines without throwing", () => {
    const observations = fold([
      'DRV:0,2,999,12,"drive","disc"',
      COPY_COMPLETE_THREE,
    ])

    // A 6-field DRV is malformed, not a partial drive: accepting
    // it shifts the disc name into the device path.
    expect(observations.malformedLineCount).toBe(1)
    expect(observations.titlesSaved).toBe(3)
  })

  it("survives an event type it does not care about", () => {
    const event: MakemkvEvent = {
      type: "UNKNOWN",
      raw: "hi",
    }
    const observations = observeOutcomeEvent({
      observations: createRipObservations(),
      event,
    })

    expect(observations).toEqual(createRipObservations())
  })
})

describe("backup mode proves itself differently", () => {
  // The false negative that cost a real 33 GB rip, 2026-07-25.
  // `backup` writes a disc structure rather than titles, so it
  // never emits MSG:5004 — and the success test demanded one.
  // Result: 24m29s, exit 0, zero read errors, a complete BDMV on
  // the dataset, reported as FAILED.
  //
  // That is the mirror image of ARM's #1298, and just as
  // damaging: a tool that cries failure on good rips gets
  // ignored on the real ones.

  it("succeeds with no title count at all", () => {
    const summary = summariseRip({
      observations: fold([]),
      exitCode: 0,
      termination: "exited",
      mode: "backup",
      hasVerifiedStructure: true,
    })

    expect(summary.isSuccessful).toBe(true)
    expect(summary.failureReason).toBeNull()
    expect(summary.titlesSaved).toBeNull()
  })

  it("is the default mode, because it is the only one we drive", () => {
    // A2: backup-only is the default, not an override. If this
    // ever defaults to mkv again, every backup fails silently.
    const summary = summariseRip({
      observations: fold([]),
      exitCode: 0,
      termination: "exited",
      hasVerifiedStructure: true,
    })

    expect(summary.isSuccessful).toBe(true)
  })

  it("fails when nothing landed on the dataset", () => {
    // Exit 0, no complaints, no disc. The backup-mode
    // counterpart of no_titles_saved.
    const summary = summariseRip({
      observations: fold([]),
      exitCode: 0,
      termination: "exited",
      mode: "backup",
      hasVerifiedStructure: false,
    })

    expect(summary.isSuccessful).toBe(false)
    expect(summary.failureReason).toBe("empty_output")
  })

  it("still refuses a rip that had read errors", () => {
    // D1 is not weakened by any of this: a verified structure
    // does not excuse read errors.
    const summary = summariseRip({
      observations: fold([READ_ERROR]),
      exitCode: 0,
      termination: "exited",
      mode: "backup",
      hasVerifiedStructure: true,
    })

    expect(summary.isSuccessful).toBe(false)
    expect(summary.failureReason).toBe("read_errors")
  })
})

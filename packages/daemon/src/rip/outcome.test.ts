import type { MakemkvEvent } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { parseMakemkvLine } from "../makemkv/parseLine.ts"
import {
  buildRipWarnings,
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

/**
 * The lines below are TRANSCRIBED from real captures, not
 * invented. `CSS_PROBE_ERROR` is byte-for-byte the one MSG:2003
 * in slot 1's 51,811-line capture of 2026-08-27, drive name and
 * offset included.
 */
const BACKUP_STARTED =
  'MSG:5072,131072,1,"Backing up disc into folder ' +
  '\\"file:///media/Disc-Rips/.rip-deck-incomplete-abc\\"",' +
  '"Backing up disc into folder \\"%1\\"",' +
  '"file:///media/Disc-Rips/.rip-deck-incomplete-abc"'

const BACKUP_DONE =
  'MSG:5070,128,0,"Backup done","Backup done"'

const BACKUP_DONE_FINAL =
  'MSG:5081,260,0,"Backup done.","Backup done."'

const BACKUP_FAILED =
  'MSG:5069,128,0,"Backup failed","Backup failed"'

const BACKUP_FAILED_FINAL =
  'MSG:5080,516,0,"Backup failed.","Backup failed."'

const HASH_TABLE_LOADED =
  'MSG:5085,0,0,"Loaded content hash table, will verify ' +
  'integrity of M2TS files.","Loaded content hash table, ' +
  'will verify integrity of M2TS files."'

/**
 * ⚠️ The CODE here is a placeholder and the TEXT is not.
 *
 * No capture in this repo has ever failed a hash check, so
 * MakeMKV's code for it is unknown; the string is read out of
 * the `libmakemkv.so.1` the image ships. `isHashCheckFailureMessage`
 * matches the text for exactly that reason, so the code this
 * fixture carries is irrelevant to what it proves — see the
 * warning on that function.
 */
const HASH_CHECK_FAILED =
  'MSG:5086,0,1,"Backup done but 3 files failed hash check.",' +
  '"Backup done but %1 files failed hash check.","3"'

const CSS_PROBE_ERROR =
  "MSG:2003,0,3,\"Error 'Scsi error - ILLEGAL REQUEST:READ " +
  "OF SCRAMBLED SECTOR WITHOUT AUTHENTICATION' occurred " +
  "while reading 'BD-RE ASUS BW-16D1HT 3.02 KL7M29G4410' at " +
  "offset '1048576'\",\"Error '%1' occurred while reading " +
  "'%2' at offset '%3'\",\"Scsi error - ILLEGAL " +
  'REQUEST:READ OF SCRAMBLED SECTOR WITHOUT AUTHENTICATION",' +
  '"BD-RE ASUS BW-16D1HT 3.02 KL7M29G4410","1048576"'

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

  it("warns rather than fails when a verified backup had read errors", () => {
    // ⚠️ This assertion is INVERTED from the one it replaces,
    // and the inversion is the owner's call, not a relaxation
    // that crept in:
    //
    //   "This should be a warning. It didn't fail because it
    //    made the ISO, but the ISO is problematic, so I'd like
    //    to know that."
    //
    // Badging this `fail` says "there is no backup", which is
    // false — the ISO is on the pool and mountable. What D1
    // still forbids is reporting it SILENTLY, and the warning
    // below is what discharges that.
    const summary = summariseRip({
      observations: fold([BACKUP_STARTED, READ_ERROR]),
      exitCode: 0,
      termination: "exited",
      mode: "backup",
      hasVerifiedStructure: true,
    })

    expect(summary.isSuccessful).toBe(true)
    expect(summary.failureReason).toBeNull()
    expect(summary.readErrorCount).toBe(1)
    expect(summary.warnings).toHaveLength(1)
    expect(summary.warnings[0].kind).toBe("read_errors")
  })

  it("still fails read errors that produced NO verified output", () => {
    // The half of the old rule that stands unchanged. With
    // nothing on the dataset there is no copy to warn about,
    // and "read_errors" is the better reason than
    // "empty_output" because it names the cause.
    const summary = summariseRip({
      observations: fold([BACKUP_STARTED, READ_ERROR]),
      exitCode: 0,
      termination: "exited",
      mode: "backup",
      hasVerifiedStructure: false,
    })

    expect(summary.isSuccessful).toBe(false)
    expect(summary.failureReason).toBe("read_errors")
    // Carried on the failure too — the sentence explaining what
    // went wrong is worth as much here as on a success.
    expect(summary.warnings).toHaveLength(1)
  })

  it("fails a backup MakeMKV itself said failed, exit 0 and all", () => {
    // `MSG:5069` / `MSG:5080`. Four TMNT DVDs emitted this pair
    // on 2026-08-26, exited 0, and nothing in rip-deck read
    // either code — `isRipSuccessful`'s `hasFailureMessage`
    // input had no producer at all until now.
    const summary = summariseRip({
      observations: fold([
        BACKUP_STARTED,
        BACKUP_FAILED,
        BACKUP_FAILED_FINAL,
      ]),
      exitCode: 0,
      termination: "exited",
      mode: "backup",
      // Deliberately TRUE: an occupied destination leaves the
      // previous run's output sitting there, so the structural
      // check is not the thing that catches this.
      hasVerifiedStructure: true,
    })

    expect(summary.isSuccessful).toBe(false)
  })
})

describe("the CSS handshake probe is not a read error", () => {
  it("ignores a scrambled-sector error raised before the backup starts", () => {
    // The exact line off slot 1 on 2026-08-27, at offset 1 MB,
    // before MSG:5072. Every CSS DVD produces one. Counting it
    // badged a perfect 8 GB backup `fail`.
    const observations = fold([
      CSS_PROBE_ERROR,
      BACKUP_STARTED,
    ])

    expect(observations.readErrorCount).toBe(0)
    expect(observations.cssProbeErrorCount).toBe(1)
    expect(observations.errorLbas).toEqual([])

    const summary = summariseRip({
      observations,
      exitCode: 0,
      termination: "exited",
      mode: "backup",
      hasVerifiedStructure: true,
    })

    expect(summary.isSuccessful).toBe(true)
    expect(summary.warnings).toEqual([])
  })

  it("counts the SAME sense once the backup has started", () => {
    // The positional half of the discriminator, on its own. A
    // scrambled-sector error mid-copy is not a handshake — the
    // key is long since negotiated — so it counts.
    const observations = fold([
      BACKUP_STARTED,
      CSS_PROBE_ERROR,
    ])

    expect(observations.readErrorCount).toBe(1)
    expect(observations.cssProbeErrorCount).toBe(0)
  })

  it("counts a DIFFERENT sense raised before the backup starts", () => {
    // The textual half, on its own. A disc that cannot be read
    // during MakeMKV's structure pass is a real problem, and
    // waving through everything before MSG:5072 would hide it.
    const observations = fold([READ_ERROR])

    expect(observations.readErrorCount).toBe(1)
    expect(observations.cssProbeErrorCount).toBe(0)
  })

  it("reads the real slot-1 capture as one clean warning-free rip", () => {
    // End to end over the exact lines the live tower produced:
    // one CSS probe error, the backup, `Backup done` twice. The
    // daemon badged this `fail`.
    const observations = fold([
      CSS_PROBE_ERROR,
      BACKUP_STARTED,
      BACKUP_DONE,
      BACKUP_DONE_FINAL,
    ])

    expect(observations.hasBackupCompleted).toBe(true)
    expect(observations.hasFailureMessage).toBe(false)

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

describe("what a read-error warning actually says", () => {
  const warningOf = (lines: string[]): string => {
    const [warning] = buildRipWarnings(fold(lines))
    return warning.message
  }

  it("names the count and the offset", () => {
    const message = warningOf([BACKUP_STARTED, READ_ERROR])

    expect(message).toContain("1 read error")
    // 2097152 bytes / 2048 = LBA 1024 -> back to 2 MB.
    expect(message).toContain("2.0 MB")
  })

  it("refuses to claim MakeMKV recovered, and says why", () => {
    // The owner asked whether MakeMKV worked around the error.
    // Robot mode carries no retry, recovery or zero-fill
    // message — the whole 1.18.4 catalogue was read for one on
    // 2026-08-27 — so the sentence states the gap instead of
    // inventing a signal.
    const message = warningOf([BACKUP_STARTED, READ_ERROR])

    expect(message).toContain("cannot tell you which")
    expect(message).not.toContain("recovered")
  })

  it("reports MakeMKV's own hash check when there WAS one", () => {
    // `MSG:5085` is a real signal and the one honest answer
    // available: MakeMKV verified the copy against the disc's
    // own content hash table. Blu-ray only.
    const message = warningOf([
      HASH_TABLE_LOADED,
      BACKUP_STARTED,
      READ_ERROR,
    ])

    expect(message).toContain("hash table and it passed")
    expect(message).not.toContain("cannot tell you which")
  })

  it("says so when that hash check FAILED", () => {
    const message = warningOf([
      HASH_TABLE_LOADED,
      BACKUP_STARTED,
      READ_ERROR,
      HASH_CHECK_FAILED,
    ])

    expect(message).toContain("found corrupt files")
    expect(message).toContain("NOT recovered")
  })

  it("warns on a hash-check failure with no read error at all", () => {
    const warnings = buildRipWarnings(
      fold([
        HASH_TABLE_LOADED,
        BACKUP_STARTED,
        HASH_CHECK_FAILED,
      ]),
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe("hash_check_failed")
  })
})

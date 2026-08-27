import { describe, expect, it } from "vitest"
import {
  isBackupCompleteMessage,
  isBackupFailureMessage,
  isHashCheckFailureMessage,
  isScrambledSectorError,
  MakemkvMsgCode,
  type MsgEvent,
} from "./makemkv.ts"

/**
 * The message predicates, tested against the shapes real
 * captures carry — never a shape invented to make a predicate
 * pass.
 */

const message = (
  overrides: Partial<MsgEvent> = {},
): MsgEvent => ({
  type: "MSG",
  code: MakemkvMsgCode.READ_ERROR,
  flags: 0,
  count: 3,
  message: "",
  format: "",
  params: [],
  ...overrides,
})

describe("isScrambledSectorError", () => {
  it("matches the CSS handshake probe every protected DVD raises", () => {
    expect(
      isScrambledSectorError(
        message({
          message:
            "Error 'Scsi error - ILLEGAL REQUEST:READ OF " +
            "SCRAMBLED SECTOR WITHOUT AUTHENTICATION' " +
            "occurred while reading 'BD-RE ASUS BW-16D1HT' " +
            "at offset '1048576'",
          params: [
            "Scsi error - ILLEGAL REQUEST:READ OF SCRAMBLED " +
              "SECTOR WITHOUT AUTHENTICATION",
            "BD-RE ASUS BW-16D1HT",
            "1048576",
          ],
        }),
      ),
    ).toBe(true)
  })

  it("does NOT match an unrecovered medium error", () => {
    // The sense a genuinely bad sector reports. Waving this
    // through would be the ARM bug, not a fix for it.
    expect(
      isScrambledSectorError(
        message({
          message:
            "Error 'Scsi error - MEDIUM ERROR:UNRECOVERED " +
            "READ ERROR' occurred while reading " +
            "'/BDMV/STREAM/00001.m2ts' at offset '2097152'",
          params: ["Scsi error", "00001.m2ts", "2097152"],
        }),
      ),
    ).toBe(false)
  })

  it("does not match a message that merely quotes the words on another code", () => {
    // It is a READ_ERROR predicate. An informational line that
    // happened to contain the phrase is not a read error, and
    // dropping it would drop a message nothing else reads.
    expect(
      isScrambledSectorError(
        message({
          code: 1011,
          message:
            "READ OF SCRAMBLED SECTOR WITHOUT AUTHENTICATION",
        }),
      ),
    ).toBe(false)
  })
})

describe("the backup completion twins", () => {
  it("treats 5070 and 5081 as completion", () => {
    expect(
      isBackupCompleteMessage(message({ code: 5070 })),
    ).toBe(true)
    expect(
      isBackupCompleteMessage(message({ code: 5081 })),
    ).toBe(true)
  })

  it("treats 5069 and 5080 as failure", () => {
    // Both were in this repo's own captures for a fortnight
    // while `hasFailureMessage` had no producer at all.
    expect(
      isBackupFailureMessage(message({ code: 5069 })),
    ).toBe(true)
    expect(
      isBackupFailureMessage(message({ code: 5080 })),
    ).toBe(true)
  })

  it("keeps the two sets apart", () => {
    expect(
      isBackupFailureMessage(message({ code: 5070 })),
    ).toBe(false)
    expect(
      isBackupCompleteMessage(message({ code: 5069 })),
    ).toBe(false)
  })
})

describe("isHashCheckFailureMessage", () => {
  // The four strings below are read out of the `libmakemkv.so.1`
  // this repo's image ships (MakeMKV 1.18.4). Their CODES are
  // unknown, which is why the predicate matches text — see its
  // own warning.
  it.each([
    "Backup done but 3 files failed hash check",
    "Backup done but 3 files failed hash check.",
    "Hash check failed for file 00001.m2ts at offset 12, file is corrupt.",
    "Too many hash check errors in file 00001.m2ts.",
  ])("matches %s", (text) => {
    expect(
      isHashCheckFailureMessage(
        message({ code: 5086, message: text }),
      ),
    ).toBe(true)
  })

  it("does NOT match the hash table merely being loaded", () => {
    // MSG:5085 is the GOOD news — MakeMKV is about to verify
    // the copy. Reading it as a failure would turn every
    // hash-verified Blu-ray into a warning.
    expect(
      isHashCheckFailureMessage(
        message({
          code: MakemkvMsgCode.BACKUP_HASH_TABLE_LOADED,
          message:
            "Loaded content hash table, will verify " +
            "integrity of M2TS files.",
        }),
      ),
    ).toBe(false)
  })
})

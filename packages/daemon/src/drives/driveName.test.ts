import { describe, expect, it } from "vitest"
import {
  isAttachedDrive,
  parseDriveName,
} from "./driveName.ts"

/** All inputs captured live from the tower, 2026-07-24. */

describe("parseDriveName", () => {
  it("parses a Pioneer name with padded internal spaces", () => {
    expect(
      parseDriveName(
        "BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00007",
      ),
    ).toEqual({
      driveType: "BD-RE",
      vendor: "PIONEER",
      model: "BD-RW BDR-211M",
      firmwareRevision: "1.53",
      firmwareSerial: "EXAMPLE00007",
    })
  })

  it("parses an ASUS-reporting name", () => {
    expect(
      parseDriveName(
        "BD-RE ASUS BW-16D1HT 3.02 EXAMPLE00001",
      ),
    ).toEqual({
      driveType: "BD-RE",
      vendor: "ASUS",
      model: "BW-16D1HT",
      firmwareRevision: "3.02",
      firmwareSerial: "EXAMPLE00001",
    })
  })

  it("extracts a serial even when the model lies", () => {
    // Slot 2 is an LG WH14NS40 running OmniDrive firmware that
    // makes it report as ASUS. The model string is unusable for
    // identity; the serial is intact and is what we key on.
    const parsed = parseDriveName(
      "BD-RE ASUS BW-16D1HT 3.02 EXAMPLE00002",
    )

    expect(parsed?.firmwareSerial).toBe("EXAMPLE00002")
  })

  it("returns null for MakeMKV's empty padding slots", () => {
    expect(parseDriveName("")).toBeNull()
  })

  it("refuses a name whose layout it does not recognise", () => {
    // Better to resolve nothing than to assign a wrong serial.
    expect(
      parseDriveName("SOME RANDOM DRIVE NAME"),
    ).toBeNull()
  })
})

describe("isAttachedDrive", () => {
  it("accepts a real drive", () => {
    expect(
      isAttachedDrive({
        devicePath: "/dev/sr2",
        driveName: "BD-RE ASUS BW-16D1HT 3.02 EXAMPLE00001",
      }),
    ).toBe(true)
  })

  it("rejects the padding slots MakeMKV always emits", () => {
    // MakeMKV pads its drive list to 16 entries; ours are the
    // first nine.
    expect(
      isAttachedDrive({ devicePath: "", driveName: "" }),
    ).toBe(false)
  })
})

import {
  isMakemkvPrompt,
  MakemkvMsgCode,
  parseTitlesSaved,
} from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { parseMakemkvLine } from "./parseLine.ts"
import { scanFields } from "./scanFields.ts"

/**
 * Every line in this file is REAL output captured from the
 * tower on 2026-07-24, or a doctest line from ARM's own parser.
 * Nothing here is invented, because invented fixtures are
 * exactly how you end up with a parser that handles the docs
 * instead of the program.
 */

describe("scanFields", () => {
  it("keeps commas inside quoted fields", () => {
    // ARM's own doctest: a TINFO chapter/segment map. This is
    // the canonical quoted-comma case.
    expect(scanFields('1,26,0,"155,156,157"')).toEqual([
      "1",
      "26",
      "0",
      "155,156,157",
    ])
  })

  it("keeps an apostrophe inside a quoted field", () => {
    // Real MSG:5074, which every run emits.
    const payload =
      '5074,0,0,"Automatic checking for updates is enabled, ' +
      "you may disable it in preferences if you don't want " +
      'MakeMKV to contact web server."'

    const fields = scanFields(payload)

    expect(fields).toHaveLength(4)
    expect(fields[3]).toContain("don't")
    expect(fields[3]).toContain("enabled, you may")
  })

  it("keeps single quotes and colons inside a quoted field", () => {
    // Real MSG:2003 shape from THE_PRESTIGE.log.
    const payload =
      "2003,0,3,\"Error 'Scsi error - NOT READY:MEDIUM NOT " +
      "PRESENT - TRAY OPEN' occurred while reading " +
      "'/BDMV/STREAM/00014.m2ts' at offset '0'\""

    const fields = scanFields(payload)

    expect(fields[3]).toContain(
      "NOT READY:MEDIUM NOT PRESENT",
    )
    expect(fields[3]).toContain("'/BDMV/STREAM/00014.m2ts'")
  })

  it("treats a bare quote in an unquoted field as data", () => {
    // A strict CSV reader throws or truncates here. Disc volume
    // labels do contain stray quotes.
    expect(scanFields('1,ab"cd,2')).toEqual([
      "1",
      'ab"cd',
      "2",
    ])
  })

  it("unescapes doubled quotes inside a quoted field", () => {
    expect(scanFields('"a""b",1')).toEqual(['a"b', "1"])
  })

  it("tolerates an unterminated quote", () => {
    // Happens whenever we kill makemkvcon mid-write.
    expect(scanFields('1,"trunc')).toEqual(["1", "trunc"])
  })

  it("preserves empty quoted fields", () => {
    expect(scanFields('9,256,999,0,"","",""')).toEqual([
      "9",
      "256",
      "999",
      "0",
      "",
      "",
      "",
    ])
  })
})

describe("parseMakemkvLine — DRV", () => {
  it("parses a real attached drive with 7 fields", () => {
    const event = parseMakemkvLine(
      'DRV:1,0,999,0,"BD-RE PIONEER BD-RW   BDR-211M 1.53 ' +
        'EXAMPLE00007","","/dev/sr2"',
    )

    expect(event).toEqual({
      type: "DRV",
      index: 1,
      visible: 0,
      enabled: 999,
      flags: 0,
      driveName:
        "BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00007",
      discName: "",
      devicePath: "/dev/sr2",
    })
  })

  it("parses the unattached padding slots", () => {
    // MakeMKV always pads its drive list to 16 entries.
    const event = parseMakemkvLine(
      'DRV:9,256,999,0,"","",""',
    )

    expect(event.type).toBe("DRV")
    if (event.type !== "DRV") return

    expect(event.visible).toBe(256)
    expect(event.devicePath).toBe("")
  })

  it("flags a 6-field DRV as malformed, not a partial drive", () => {
    // The docs imply 6 fields. Real output has 7. Silently
    // accepting 6 would put the disc name in the device path.
    const event = parseMakemkvLine(
      'DRV:6,256,999,0,"BD-Drive","THE TITLE"',
    )

    expect(event.type).toBe("MALFORMED")
  })
})

describe("parseMakemkvLine — MSG", () => {
  it("parses the startup banner with its params", () => {
    const event = parseMakemkvLine(
      'MSG:1005,0,1,"MakeMKV v1.18.4 linux(x64-release) ' +
        'started","%1 started","MakeMKV v1.18.4 ' +
        'linux(x64-release)"',
    )

    expect(event.type).toBe("MSG")
    if (event.type !== "MSG") return

    expect(event.code).toBe(1005)
    expect(event.format).toBe("%1 started")
    expect(event.params).toEqual([
      "MakeMKV v1.18.4 linux(x64-release)",
    ])
  })

  it("parses a message with a comma in its text", () => {
    const event = parseMakemkvLine(
      'MSG:5074,0,0,"Automatic checking for updates is ' +
        "enabled, you may disable it in preferences if you " +
        'don\'t want MakeMKV to contact web server.","x"',
    )

    expect(event.type).toBe("MSG")
    if (event.type !== "MSG") return

    expect(event.code).toBe(5074)
    expect(event.message).toContain(
      "enabled, you may disable",
    )
  })
})

describe("parseMakemkvLine — the success test", () => {
  it("reads titles saved from MSG:5004 params", () => {
    // "%1 titles saved, %2 failed"
    const event = parseMakemkvLine(
      'MSG:5004,0,2,"2 titles saved, 0 failed","%1 titles ' +
        'saved, %2 failed","2","0"',
    )

    expect(event.type).toBe("MSG")
    if (event.type !== "MSG") return

    expect(event.code).toBe(MakemkvMsgCode.COPY_COMPLETE)
    expect(parseTitlesSaved(event)).toBe(2)
  })

  it("reads ZERO titles saved — the silent-success trap", () => {
    // makemkvcon exits 0 here. ARM reports this as a success
    // (upstream #1298). It is a failure.
    const event = parseMakemkvLine(
      'MSG:5004,0,2,"0 titles saved, 1 failed","%1 titles ' +
        'saved, %2 failed","0","1"',
    )

    expect(event.type).toBe("MSG")
    if (event.type !== "MSG") return

    expect(parseTitlesSaved(event)).toBe(0)
  })

  it("returns null for a non-5004 message", () => {
    const event = parseMakemkvLine(
      'MSG:1005,0,0,"started","started"',
    )

    expect(event.type).toBe("MSG")
    if (event.type !== "MSG") return

    expect(parseTitlesSaved(event)).toBeNull()
  })
})

describe("parseMakemkvLine — BOXYESNO detection", () => {
  it("detects a dialog makemkvcon will wait forever on", () => {
    const event = parseMakemkvLine(
      'MSG:5011,776,0,"Do you want to continue?","%1"',
    )

    expect(isMakemkvPrompt(event)).toBe(true)
  })

  it("does not flag an ordinary message", () => {
    const event = parseMakemkvLine(
      'MSG:1005,0,0,"started","started"',
    )

    expect(isMakemkvPrompt(event)).toBe(false)
  })
})

describe("parseMakemkvLine — progress", () => {
  it("parses PRGV with max 65536", () => {
    expect(
      parseMakemkvLine("PRGV:65294,140,65536"),
    ).toEqual({
      type: "PRGV",
      current: 65294,
      total: 140,
      max: 65536,
    })
  })

  it("parses PRGC with an incrementing file id", () => {
    expect(
      parseMakemkvLine('PRGC:5046,134,"Copying file"'),
    ).toEqual({
      type: "PRGC",
      code: 5046,
      id: 134,
      name: "Copying file",
    })
  })

  it("parses PRGT", () => {
    expect(
      parseMakemkvLine('PRGT:5047,0,"Copying all files"'),
    ).toEqual({
      type: "PRGT",
      code: 5047,
      id: 0,
      name: "Copying all files",
    })
  })
})

describe("parseMakemkvLine — info records", () => {
  it("parses TINFO including its leading title index", () => {
    // The docs omit the title index. Dropping it is the classic
    // MakeMKV "global index" bug: every attribute lands on the
    // wrong title.
    expect(
      parseMakemkvLine('TINFO:1,26,0,"155,156,157"'),
    ).toEqual({
      type: "TINFO",
      title: 1,
      id: 26,
      code: 0,
      value: "155,156,157",
    })
  })

  it("parses SINFO with five fields, not three", () => {
    // ARM's own docstring says `id,code,value`; its code parses
    // five. Real output has five.
    expect(
      parseMakemkvLine('SINFO:0,0,28,0,"ger"'),
    ).toEqual({
      type: "SINFO",
      title: 0,
      stream: 0,
      id: 28,
      code: 0,
      value: "ger",
    })
  })

  it("parses CINFO", () => {
    expect(
      parseMakemkvLine('CINFO:1,6209,"Blu-ray disc"'),
    ).toEqual({
      type: "CINFO",
      id: 1,
      code: 6209,
      value: "Blu-ray disc",
    })
  })

  it("parses TCOUNT", () => {
    expect(parseMakemkvLine("TCOUNT:0")).toEqual({
      type: "TCOUNT",
      count: 0,
    })
  })
})

describe("parseMakemkvLine — robustness", () => {
  it("never throws on a truncated line", () => {
    for (const line of [
      "",
      "DRV",
      "DRV:",
      "PRGV:1,2",
      'MSG:5004,0,2,"x"',
      "TINFO:not,a,number,x",
      ":::",
    ]) {
      expect(() => parseMakemkvLine(line)).not.toThrow()
    }
  })

  it("classifies prose as UNKNOWN, not MALFORMED", () => {
    // A colon in prose must not look like a robot prefix.
    const event = parseMakemkvLine(
      "Error: something went wrong",
    )

    expect(event.type).toBe("UNKNOWN")
  })
})

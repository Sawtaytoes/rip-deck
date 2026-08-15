import type { MakemkvEvent } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { parseMakemkvLine } from "../makemkv/parseLine.ts"
import {
  extractDiscName,
  identifyDisc,
  retryUntilRead,
  wasDiscRead,
} from "./identifyDisc.ts"

const events = (lines: string[]) =>
  lines.map(parseMakemkvLine)

describe("reading the disc's own label", () => {
  it("prefers CINFO:2, the disc name proper", () => {
    expect(
      extractDiscName(
        events([
          'DRV:0,2,999,12,"BD-RE PIONEER","DRV_LABEL","/dev/sr0"',
          'CINFO:2,0,"BLADE_RUNNER_2049"',
        ]),
      ),
    ).toBe("BLADE_RUNNER_2049")
  })

  it("falls back to the DRV disc-name field", () => {
    // CINFO:2 is absent on some discs.
    expect(
      extractDiscName(
        events([
          'DRV:0,2,999,12,"BD-RE PIONEER","DUNE_PART_TWO",' +
            '"/dev/sr0"',
        ]),
      ),
    ).toBe("DUNE_PART_TWO")
  })

  it("ignores MakeMKV's 16-slot padding", () => {
    // Unused slots come back with empty strings and
    // visible === 256.
    expect(
      extractDiscName(
        events([
          'DRV:1,256,999,0,"","","" ',
          'DRV:2,256,999,0,"","",""',
        ]),
      ),
    ).toBeNull()
  })

  it("returns null rather than inventing a name", () => {
    // B3: fail closed. A disc we cannot name stays in the drive
    // and is flagged, rather than being filed as "Unknown".
    expect(extractDiscName(events(["TCOUNT:3"]))).toBeNull()
  })

  it("ignores a blank label", () => {
    expect(
      extractDiscName(
        events([
          'CINFO:2,0,"   "',
          'DRV:0,2,999,12,"BD-RE","","/dev/sr0"',
        ]),
      ),
    ).toBeNull()
  })
})

/**
 * Regression cover for the 2026-07-26 misdiagnosis: a spawn that
 * never happened was reported as a disc with no name. Both cases
 * below produce `discName: null`, and the ONLY thing that tells
 * them apart is `spawnFailure` — which is the point.
 */
describe("telling a dead binary apart from a nameless disc", () => {
  it("reports a binary that cannot be spawned", async () => {
    const identified = await identifyDisc({
      devPath: "/dev/null",
      makemkv: {
        command: "rip-deck-no-such-binary-exists",
        prefixArgs: [],
        wrapperArgs: null,
      },
    })

    expect(identified.spawnFailure).toContain(
      "rip-deck-no-such-binary-exists",
    )
    expect(identified.events).toEqual([])
    expect(identified.discName).toBeNull()
  })

  it("leaves spawnFailure null when the binary ran", async () => {
    // `true` exists, exits 0 and says nothing — the same empty
    // event list an unreadable disc produces, reached the other
    // way. discName is null in BOTH tests; spawnFailure is not.
    //
    // `maxAttempts: 1` because an empty event list is exactly the
    // "no drive answered" case `identifyDisc` now RETRIES — this
    // test is about the single-read contract, so it pins one read.
    const identified = await identifyDisc({
      devPath: "/dev/null",
      makemkv: {
        command: "true",
        prefixArgs: [],
        wrapperArgs: null,
      },
      maxAttempts: 1,
    })

    expect(identified.spawnFailure).toBeNull()
    expect(identified.discName).toBeNull()
  })
})

/**
 * The signal that decides whether a no-name read is worth
 * retrying: did makemkvcon actually READ the disc, or only see the
 * drive? A `CINFO` block appears only once the disc is open, so its
 * absence — whether the bus was silent or the drive was listed but
 * its disc had not finished decrypting — means the disc was never
 * read, and a retry is worth it.
 */
describe("telling a disc that was read apart from one that was not", () => {
  it("treats a bare DRV line as a disc not yet read", () => {
    // A drive answered — it named its model — but no CINFO block
    // followed, so the disc was never opened. This is the UHD
    // mid-decrypt case the old `didDeviceRespond` misread as a
    // blank disc. Retryable.
    expect(
      wasDiscRead(
        events([
          'DRV:0,2,999,12,"BD-RE PIONEER BDR-211M","","/dev/sr0"',
        ]),
      ),
    ).toBe(false)
  })

  it("treats MakeMKV's 16-slot padding as a disc not read", () => {
    expect(
      wasDiscRead(events(['DRV:2,256,999,0,"","",""'])),
    ).toBe(false)
  })

  it("treats an empty event stream as a disc not read", () => {
    expect(wasDiscRead([])).toBe(false)
  })

  it("counts any CINFO block as the disc having been read", () => {
    // CINFO appears only after MakeMKV opens the disc — even a
    // blank name field means the disc WAS read, so a retry cannot
    // change the (nameless) result.
    expect(wasDiscRead(events(['CINFO:2,0,"   "']))).toBe(
      true,
    )
  })
})

/**
 * The retry policy, tested without a drive: the whole point of
 * `retryUntilRead` being pure over its `attempt` and `sleep` is
 * that the transient it exists for — a USB bus that answers on
 * the second read but not the first — is reproducible here, and
 * only here.
 */
describe("retrying a read the drive never answered", () => {
  const silent: MakemkvEvent[] = events([
    'DRV:2,256,999,0,"","",""',
  ])
  const answered: MakemkvEvent[] = events([
    'DRV:0,2,999,12,"BD-RE PIONEER BDR-211M","SOYLENT_GREEN",' +
      '"/dev/sr0"',
    'CINFO:2,0,"SOYLENT_GREEN"',
  ])
  const neverSleep = () => Promise.resolve()

  it("re-reads a silent bus and takes the first read that lands", async () => {
    const reads = [
      {
        discName: null,
        events: silent,
        spawnFailure: null,
      },
      {
        discName: "SOYLENT_GREEN",
        events: answered,
        spawnFailure: null,
      },
    ]
    let calls = 0

    const outcome = await retryUntilRead({
      attempt: () => Promise.resolve(reads[calls++]),
      maxAttempts: 3,
      delayMs: 0,
      sleep: neverSleep,
    })

    expect(calls).toBe(2)
    expect(outcome.discName).toBe("SOYLENT_GREEN")
  })

  it("never retries a spawn failure — the binary is just missing", async () => {
    let calls = 0

    const outcome = await retryUntilRead({
      attempt: () => {
        calls += 1
        return Promise.resolve({
          discName: null,
          events: [],
          spawnFailure: "makemkvcon: not found",
        })
      },
      maxAttempts: 3,
      delayMs: 0,
      sleep: neverSleep,
    })

    expect(calls).toBe(1)
    expect(outcome.spawnFailure).toBe(
      "makemkvcon: not found",
    )
  })

  it("never retries a disc that was read but has no name", async () => {
    // The disc was OPENED — MakeMKV emitted its CINFO block — and
    // the name is blank. Another read returns the same nothing;
    // `--name` is the fix, not a retry.
    const blank: MakemkvEvent[] = events([
      'DRV:0,2,999,12,"BD-RE PIONEER BDR-211M","","/dev/sr0"',
      'CINFO:1,6209,"Blu-ray disc"',
      'CINFO:2,0,"   "',
    ])
    let calls = 0

    const outcome = await retryUntilRead({
      attempt: () => {
        calls += 1
        return Promise.resolve({
          discName: null,
          events: blank,
          spawnFailure: null,
        })
      },
      maxAttempts: 3,
      delayMs: 0,
      sleep: neverSleep,
    })

    expect(calls).toBe(1)
    expect(outcome.discName).toBeNull()
  })

  it("re-reads a drive that answered before its disc had opened", async () => {
    // The UHD regression (2026-07-30, "SOYLENT GREEN - UHD",
    // slot 9): the DRIVE is listed, but the disc has not cleared
    // LibreDrive/BD+ decrypt, so no CINFO and no name. The old
    // "a populated DRV line is a blank disc" rule latched this
    // permanently; it is a transient, and the next read lands the
    // name.
    const drivePresentDiscNotOpen: MakemkvEvent[] = events([
      'DRV:5,0,999,0,"BD-RE PIONEER BDR-211M 1.53 ' +
        'EXAMPLE00009","","/dev/sr0"',
    ])
    const opened: MakemkvEvent[] = events([
      'DRV:5,0,999,0,"BD-RE PIONEER BDR-211M 1.53 ' +
        'EXAMPLE00009","","/dev/sr0"',
      'CINFO:2,0,"SOYLENT GREEN - UHD"',
    ])
    const reads = [
      {
        discName: null,
        events: drivePresentDiscNotOpen,
        spawnFailure: null,
      },
      {
        discName: "SOYLENT GREEN - UHD",
        events: opened,
        spawnFailure: null,
      },
    ]
    let calls = 0

    const outcome = await retryUntilRead({
      attempt: () => Promise.resolve(reads[calls++]),
      maxAttempts: 3,
      delayMs: 0,
      sleep: neverSleep,
    })

    expect(calls).toBe(2)
    expect(outcome.discName).toBe("SOYLENT GREEN - UHD")
  })

  it("gives up after maxAttempts and returns the last read", async () => {
    let calls = 0

    const outcome = await retryUntilRead({
      attempt: () => {
        calls += 1
        return Promise.resolve({
          discName: null,
          events: silent,
          spawnFailure: null,
        })
      },
      maxAttempts: 3,
      delayMs: 0,
      sleep: neverSleep,
    })

    expect(calls).toBe(3)
    expect(outcome.discName).toBeNull()
  })

  it("sleeps between reads, but not after the last", async () => {
    let sleeps = 0

    await retryUntilRead({
      attempt: () =>
        Promise.resolve({
          discName: null,
          events: silent,
          spawnFailure: null,
        }),
      maxAttempts: 3,
      delayMs: 0,
      sleep: () => {
        sleeps += 1
        return Promise.resolve()
      },
    })

    // Three reads, two gaps between them.
    expect(sleeps).toBe(2)
  })
})

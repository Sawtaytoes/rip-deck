import type { DrvEvent } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import { parseMakemkvLine } from "../makemkv/parseLine.ts"
import {
  buildIndexByDevPath,
  verifyDiscIndex,
} from "./discIndex.ts"

/**
 * Real DRV output from this rig, 2026-07-25.
 *
 * Kept verbatim because it is the evidence for the claim that
 * the disc index, the slot and the `srN` number are three
 * different sequences: slot 9 is /dev/sr0 is disc:5.
 */
const REAL_DRV_LINES = [
  'DRV:0,0,999,0,"BD-RE ASUS BW-16D1HT 3.02 EXAMPLE00001","","/dev/sr8"',
  'DRV:1,0,999,0,"BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00007","","/dev/sr2"',
  'DRV:2,0,999,0,"BD-RE ASUS BW-16D1HT 3.02 EXAMPLE00003","","/dev/sr6"',
  'DRV:3,0,999,0,"BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00006","","/dev/sr3"',
  'DRV:4,0,999,0,"BD-RE ASUS BW-16D1HT 3.02 EXAMPLE00002","","/dev/sr7"',
  'DRV:5,0,999,0,"BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00009","","/dev/sr0"',
  'DRV:6,0,999,0,"BD-RE PIONEER BD-RW   BDR-212U 1.01 EXAMPLE00005","","/dev/sr4"',
  'DRV:7,0,999,0,"BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00008","","/dev/sr1"',
  'DRV:8,0,999,0,"BD-RE ASUS BW-16D1HT 3.02 EXAMPLE00004","","/dev/sr5"',
  // MakeMKV pads to 16 slots with visible=256 and empty strings.
  'DRV:9,256,999,0,"","",""',
  'DRV:10,256,999,0,"","",""',
]

const realDrives = (): DrvEvent[] =>
  REAL_DRV_LINES.map(parseMakemkvLine).filter(
    (event): event is DrvEvent => event.type === "DRV",
  )

describe("mapping a device to MakeMKV's disc index", () => {
  const index = buildIndexByDevPath(realDrives())

  it("resolves the real rig's slot 9", () => {
    // The whole reason this module exists: `backup` will not
    // take dev:/dev/sr0, so the rip has to say disc:5.
    expect(index.get("/dev/sr0")).toBe(5)
  })

  it("agrees with neither the slot nor the srN order", () => {
    // Three independent numberings. Assuming any two match is
    // how a rip ends up pointed at the wrong bay.
    expect(index.get("/dev/sr8")).toBe(0)
    expect(index.get("/dev/sr0")).not.toBe(0)
  })

  it("ignores the 16-slot padding", () => {
    // Mapping "" to an index would make every unmatched lookup
    // resolve to a real drive — the worst failure available
    // here, since it rips the wrong disc rather than erroring.
    expect(index.has("")).toBe(false)
    expect(index.size).toBe(9)
  })
})

describe("verifying the index before writing", () => {
  const drives = realDrives()

  it("accepts the drive it was told to expect", () => {
    expect(
      verifyDiscIndex({
        drives,
        discIndex: 5,
        expectedDevPath: "/dev/sr0",
      }),
    ).toEqual({ isMatch: true, actualDevPath: "/dev/sr0" })
  })

  it("catches a bus that renumbered under us", () => {
    // The failure this exists to prevent: the index is derived
    // from enumeration order, so a drive appearing between our
    // enumeration and the rip shifts every index after it. The
    // rip would not error — it would rip another bay's disc into
    // a folder named after this one.
    expect(
      verifyDiscIndex({
        drives,
        discIndex: 5,
        expectedDevPath: "/dev/sr4",
      }),
    ).toEqual({ isMatch: false, actualDevPath: "/dev/sr0" })
  })

  it("withholds a verdict until the row has arrived", () => {
    // The DRV table streams in a few lines at a time. Absence of
    // our row is not evidence of a mismatch, and treating it as
    // one would abort every rip on its first DRV line.
    expect(
      verifyDiscIndex({
        drives: drives.slice(0, 3),
        discIndex: 5,
        expectedDevPath: "/dev/sr0",
      }),
    ).toBeNull()
  })

  it("never renders a verdict from a padding row", () => {
    expect(
      verifyDiscIndex({
        drives,
        discIndex: 9,
        expectedDevPath: "/dev/sr0",
      }),
    ).toBeNull()
  })
})

/**
 * What the table looks like inside an isolated rip container.
 *
 * NOT captured from hardware — the tower has been off since
 * per-rip isolation was written. It is the table a container
 * holding a single `--device /dev/sr3` is expected to produce:
 * one real row at index 0, then MakeMKV's usual padding.
 */
const ISOLATED_DRV_LINES = [
  'DRV:0,0,999,0,"BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00006","","/dev/sr3"',
  'DRV:1,256,999,0,"","",""',
  'DRV:2,256,999,0,"","",""',
]

describe("verifying an isolated rip", () => {
  const drives = ISOLATED_DRV_LINES.map(
    parseMakemkvLine,
  ).filter(
    (event): event is DrvEvent => event.type === "DRV",
  )

  it("finds one drive, and it is disc:0", () => {
    // The whole win: the bus scan `backup` insists on runs inside
    // a container that can see one device, so the third numbering
    // collapses to a constant.
    expect(buildIndexByDevPath(drives)).toEqual(
      new Map([["/dev/sr3", 0]]),
    )
  })

  it("keeps checking anyway, and would catch a bad --device", () => {
    // Near-tautological under isolation, and kept deliberately.
    // The container is handed a `/dev/srN` resolved from sysfs,
    // and `srN` reshuffles on every USB re-enumeration — so a
    // stale path maps a SIBLING in, with total confidence, and
    // rips it into this bay's folder name. Nothing downstream can
    // untangle that, and here it costs a find over sixteen rows.
    expect(
      verifyDiscIndex({
        drives,
        discIndex: 0,
        expectedDevPath: "/dev/sr4",
      }),
    ).toEqual({ isMatch: false, actualDevPath: "/dev/sr3" })

    expect(
      verifyDiscIndex({
        drives,
        discIndex: 0,
        expectedDevPath: "/dev/sr3",
      }),
    ).toEqual({ isMatch: true, actualDevPath: "/dev/sr3" })
  })

  it("withholds a verdict if a lone drive is not index 0", () => {
    // ISOLATED_DISC_INDEX is assumed, not measured. If MakeMKV
    // numbers a lone drive by something other than scan position,
    // index 0 is a padding row — and a padding row must never
    // produce a verdict, or every isolated rip would abort as
    // `wrong_drive` for the wrong reason.
    const shifted = [
      'DRV:0,256,999,0,"","",""',
      'DRV:1,0,999,0,"BD-RE PIONEER BD-RW   BDR-211M 1.53 EXAMPLE00006","","/dev/sr3"',
    ]
      .map(parseMakemkvLine)
      .filter(
        (event): event is DrvEvent => event.type === "DRV",
      )

    expect(
      verifyDiscIndex({
        drives: shifted,
        discIndex: 0,
        expectedDevPath: "/dev/sr3",
      }),
    ).toBeNull()
  })
})

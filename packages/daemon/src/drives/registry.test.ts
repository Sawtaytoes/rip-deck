import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_READ_OFFSET_SAMPLES } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  type DriveRegistry,
  drivesSharingHub,
  loadDriveRegistry,
  parseTrueModel,
  resolveDrive,
} from "./registry.ts"

/**
 * The real tower, as correlated on 2026-07-24 from three
 * independent sources: the operator's physical slot callout,
 * MakeMKV's DRV lines, and sysfs.
 */
const registry: DriveRegistry = {
  towerRootPortPath: "2-1.1.2",
  entries: [
    {
      slot: 1,
      name: "01 - ASUS BW-16D1HT",
      firmwareSerial: "EXAMPLE00001",
      trueModel: "ASUS BW-16D1HT",
      reportedModel: "BW-16D1HT",
      usbPortPath: "2-1.1.2.4.4.4",
      bridgeSerial: "123456789254",
      isUhdCapable: true,
      readOffsetSamples: null,
    },
    {
      slot: 5,
      name: "05 - Pioneer BDR-212U",
      firmwareSerial: "EXAMPLE00005",
      trueModel: "Pioneer BDR-212U",
      reportedModel: "BD-RW BDR-212U",
      usbPortPath: "2-1.1.2.4.2",
      bridgeSerial: "1234567891BA",
      isUhdCapable: true,
      readOffsetSamples: null,
    },
    {
      slot: 9,
      name: "09 - Pioneer BDR-211M",
      firmwareSerial: "EXAMPLE00009",
      trueModel: "Pioneer BDR-211M",
      reportedModel: "BD-RW BDR-211M",
      usbPortPath: "2-1.1.2.1",
      bridgeSerial: "1234567892BB",
      isUhdCapable: true,
      readOffsetSamples: null,
    },
  ],
}

describe("resolveDrive", () => {
  it("resolves by USB port path with no device access", () => {
    // The 2-second sampler takes this path. It must never need
    // a makemkvcon call.
    const resolved = resolveDrive(registry, {
      usbPortPath: "2-1.1.2.4.2",
      bridgeSerial: "1234567891BA",
    })

    expect(resolved.placement?.slot).toBe(5)
    expect(resolved.matchedBy).toBe("usb_port_path")
  })

  it("prefers the firmware serial over the port path", () => {
    const resolved = resolveDrive(registry, {
      usbPortPath: "2-1.1.2.4.2",
      bridgeSerial: "1234567891BA",
      firmwareSerial: "EXAMPLE00009",
    })

    expect(resolved.placement?.slot).toBe(9)
    expect(resolved.matchedBy).toBe("firmware_serial")
  })

  it("repairs identity across a re-cable", () => {
    // Slot 9's drive now answers on slot 1's old port. Keying
    // on the port path would silently attribute slot 9's rip
    // history and health baseline to the wrong physical unit.
    const resolved = resolveDrive(registry, {
      usbPortPath: "2-1.1.2.4.4.4",
      bridgeSerial: "1234567892BB",
      firmwareSerial: "EXAMPLE00009",
    })

    expect(resolved.placement?.slot).toBe(9)
    expect(resolved.isPortPathStale).toBe(true)
  })

  it("falls back to the bridge serial when unique", () => {
    const resolved = resolveDrive(registry, {
      usbPortPath: "2-9.9.9",
      bridgeSerial: "1234567892BB",
    })

    expect(resolved.placement?.slot).toBe(9)
    expect(resolved.matchedBy).toBe("bridge_serial")
  })

  it("refuses to guess when bridge serials collide", () => {
    // The ASMedia adapters share a `123456789` vendor prefix.
    // Ours happen to differ in the trailing hex, but a
    // replacement could collide — and a wrong slot is worse
    // than an unknown one, because the owner would walk to the
    // wrong bay.
    const colliding: DriveRegistry = {
      ...registry,
      entries: registry.entries.map((entry) => ({
        ...entry,
        bridgeSerial: "123456789000",
      })),
    }

    const resolved = resolveDrive(colliding, {
      usbPortPath: "2-9.9.9",
      bridgeSerial: "123456789000",
    })

    expect(resolved.placement).toBeNull()
    expect(resolved.matchedBy).toBe("none")
  })

  it("returns no placement for an unknown drive", () => {
    // Fail closed: an unrecognised drive is a needs-attention
    // condition, never a guess.
    const resolved = resolveDrive(registry, {
      usbPortPath: "2-5.5.5",
      bridgeSerial: "deadbeef",
      firmwareSerial: "NOTAREALSERIAL",
    })

    expect(resolved.placement).toBeNull()
  })
})

describe("drivesSharingHub", () => {
  it("groups the drives behind one internal hub chip", () => {
    const shared = drivesSharingHub(registry, "2-1.1.2.4.4")

    expect(shared.map((entry) => entry.slot)).toEqual([1])
  })

  it("groups every drive at the tower root", () => {
    // All nine share one long active USB extension into one
    // physical hub, so a fault here — most likely the aux power
    // on that extension — takes out the whole bank rather than
    // one subtree. The correlation detector must be able to say
    // "the tower", not "nine bad discs".
    const shared = drivesSharingHub(
      registry,
      registry.towerRootPortPath,
    )

    expect(shared).toHaveLength(3)
  })
})

describe("parseTrueModel", () => {
  it("splits the operator's one string into two columns", () => {
    // `config/drives.json` writes `Pioneer BDR-211M` because
    // that is how the owner says it; the dashboard has a maker
    // column and a model column.
    expect(parseTrueModel("Pioneer BDR-211M")).toEqual({
      vendor: "Pioneer",
      model: "BDR-211M",
    })
  })

  it("is the only honest source for a reflashed drive", () => {
    // Slot 2 is an LG whose OmniDrive firmware reports it as
    // ASUS BW-16D1HT, so sysfs cannot answer this and the
    // operator's file is the truth.
    expect(parseTrueModel("LG WH14NS40")).toEqual({
      vendor: "LG",
      model: "WH14NS40",
    })
  })

  it("invents no maker out of half a model number", () => {
    expect(parseTrueModel("BDR-211M")).toEqual({
      vendor: null,
      model: "BDR-211M",
    })

    expect(parseTrueModel("")).toEqual({
      vendor: null,
      model: null,
    })
  })
})

/* ------------------------------------------------------------ *
 * Reading the operator's file.
 * ------------------------------------------------------------ */

/**
 * The shipped slot map, read from disk exactly as the daemon
 * reads it.
 *
 * Not a fixture on purpose. A fixture would prove the parser
 * matches the parser's own idea of the file, which is the shape
 * of bug this repo has already shipped five times — a function
 * written, unit-tested and reached by nothing real.
 */
const SHIPPED_REGISTRY_PATH = fileURLToPath(
  new URL(
    "../../../../config/drives.json",
    import.meta.url,
  ),
)

/** One drive's entry, in the shape `drives.json` writes. */
const driveEntry = (
  readOffsetSamples: unknown,
): Record<string, unknown> => ({
  slot: 3,
  name: "03 - LG WH14NS40",
  firmwareSerial: "EXAMPLE00003",
  trueModel: "LG WH14NS40",
  reportedModel: "BW-16D1HT",
  usbPortPath: "2-1.1.2.4.4.2",
  bridgeSerial: "123456789283",
  isUhdCapable: true,
  readOffsetSamples,
})

const loadWithOffset = async (
  readOffsetSamples: unknown,
): Promise<number | null> => {
  const dir = await mkdtemp(
    join(tmpdir(), "rip-deck-registry-"),
  )
  const path = join(dir, "drives.json")

  await writeFile(
    path,
    JSON.stringify({
      towerRootPortPath: "2-1.1.2",
      drives: [driveEntry(readOffsetSamples)],
    }),
  )

  try {
    const registry = await loadDriveRegistry(path)
    return registry.entries[0].readOffsetSamples
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("loadDriveRegistry read offsets", () => {
  it("carries a measured offset off the file", async () => {
    // The value cyanrip's `-f` prints for a drive, negative
    // because plenty of real drives read early. Nothing else on
    // this tower may derive it — it is keyed on the serial in
    // the file and read back verbatim.
    expect(await loadWithOffset(-472)).toBe(-472)
  })

  it("keeps a measured zero, which is not the same as none", async () => {
    // A drive whose offset really is 0 has been measured; a
    // drive with no entry has not. Collapsing the two would
    // make `-s 0` look like a measurement.
    expect(await loadWithOffset(0)).toBe(0)
  })

  it("treats an absent offset as unmeasured, not an error", async () => {
    // The state every drive on this tower is in today. It must
    // load exactly like a missing `RIP_DECK_MQTT_URL` does:
    // supported, silent, and no flag.
    expect(await loadWithOffset(undefined)).toBeNull()
    expect(await loadWithOffset(null)).toBeNull()
  })

  it("refuses a value that is not a whole sample count", async () => {
    // An offset is a signed INTEGER count of samples. A
    // fraction, a string and a NaN-from-JSON all mean somebody
    // typed something else.
    expect(await loadWithOffset(6.5)).toBeNull()
    expect(await loadWithOffset("6")).toBeNull()
    expect(await loadWithOffset(true)).toBeNull()
  })

  it("refuses an offset no drive could have", async () => {
    // The bound is ten CD-DA sectors. It exists to catch the
    // realistic mistakes — a number pasted in bytes or
    // milliseconds, or a stray extra digit — rather than to be
    // a physical law.
    expect(
      await loadWithOffset(MAX_READ_OFFSET_SAMPLES + 1),
    ).toBeNull()

    expect(
      await loadWithOffset(-MAX_READ_OFFSET_SAMPLES - 1),
    ).toBeNull()

    // And the boundary itself is accepted, so the check cannot
    // quietly become off-by-one.
    expect(
      await loadWithOffset(MAX_READ_OFFSET_SAMPLES),
    ).toBe(MAX_READ_OFFSET_SAMPLES)
  })

  it("parses the shipped drives.json, offsets and all", async () => {
    const registry = await loadDriveRegistry(
      SHIPPED_REGISTRY_PATH,
    )

    expect(registry.entries).toHaveLength(9)

    // ⚠️ These are MEASURED values, not a requirement, and the
    // instruction from the version of this test that asserted
    // nine nulls still stands: when a bay is measured, change
    // this — do not delete it. It is what proves the number in
    // the file reached the parser.
    //
    // Measured 2026-07-27 with `cyanrip -f` against the live
    // tower, one real audio CD per bay. Slots 1-4 are the ASUS
    // BW-16D1HT group — which INCLUDES the three LG drives
    // running OmniDrive firmware that report as ASUS — and all
    // four returned +6 independently, which is the strongest
    // evidence in this file that a model string cannot be
    // trusted here but the behaviour is still per-family.
    // Slot 6 is a Pioneer BDR-211M at +667, confidence 87.
    //
    // The four nulls are honest gaps, not defaults: slot 5 is a
    // BDR-212U (a DIFFERENT model, so +667 may not carry) whose
    // disc had no AccurateRip entry, and every Pioneer -- the 212U in
    // slot 5 as well as the four 211Ms -- returned +667, from
    // five different discs.
    //
    // ⚠️ SLOT 7 (EXAMPLE00007) IS INFERRED, NOT MEASURED. That
    // drive would not accept a tray-close command and reported
    // no medium whatever was put in it, and it carries 77 I/O
    // errors against a 26-38 baseline across its eight siblings
    // -- the one drive on the tower showing a hardware signal.
    // +667 is recorded because the alternative is null, which
    // emits no `-s` at all and therefore rips at offset 0, and
    // 0 is KNOWN wrong for a Pioneer. A marked inference beats a
    // known-wrong default. Re-measure it if that drive is ever
    // repaired or replaced.
    expect(
      Object.fromEntries(
        registry.entries.map((entry) => [
          entry.firmwareSerial,
          entry.readOffsetSamples,
        ]),
      ),
    ).toEqual({
      EXAMPLE00001: 6,
      EXAMPLE00002: 6,
      EXAMPLE00003: 6,
      EXAMPLE00004: 6,
      EXAMPLE00005: 667,
      EXAMPLE00006: 667,
      EXAMPLE00007: 667,
      EXAMPLE00008: 667,
      EXAMPLE00009: 667,
    })

    // Every entry keys on its own serial, which is the whole
    // reason an offset may live in this file at all.
    expect(
      new Set(
        registry.entries.map(
          (entry) => entry.firmwareSerial,
        ),
      ).size,
    ).toBe(9)
  })
})

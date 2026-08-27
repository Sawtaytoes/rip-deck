import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  classifyLeftover,
  deleteLeftover,
  describeLeftover,
  refusalToDeleteLeftover,
  scanLeftovers,
} from "./leftovers.ts"

describe("telling a leftover from a finished rip", () => {
  it("reads an unfinished rip's job uuid out of its name", () => {
    expect(
      classifyLeftover(
        ".rip-deck-incomplete-71f30886-ede6-4b11-9c60-995210bb0588",
      ),
    ).toEqual({
      kind: "incomplete",
      jobUuid: "71f30886-ede6-4b11-9c60-995210bb0588",
    })
  })

  it("reads a duplicate landing's occupied name", () => {
    // `finaliseDestination` never clobbers: the new rip lands
    // beside the old one under this marker.
    expect(
      classifyLeftover(
        "[BACKUP] Ivanhoe (1952) - Blu-ray (rip-deck-duplicate-01234567)",
      ),
    ).toEqual({
      kind: "duplicate",
      occupiedName: "[BACKUP] Ivanhoe (1952) - Blu-ray",
    })
  })

  it("⚠️ claims NOTHING that is a finished rip", () => {
    // The delete endpoint's safety rests on this. The
    // destination dataset holds 700+ finished rips beside the
    // leftovers, and a false positive here is a deletable one.
    for (const name of [
      "[BACKUP] Ivanhoe (1952) - Blu-ray",
      "Soylent Green (1973) - UHD",
      "Teenage Mutant Ninja Turtles (1987) - DVD",
      "rip-deck-duplicate-01234567",
      ".rip-deck-incomplete-",
      "some folder (rip-deck-duplicate-01234567",
      ".hidden",
      "",
    ]) {
      expect(classifyLeftover(name)).toBeNull()
    }
  })
})

describe("saying whether a rip finished", () => {
  it("⚠️ names the EMPTY folder as the safe one to clear", () => {
    // The MSG:5068 signature: makemkvcon refused a destination
    // Rip Deck had pre-created, exited 0 and wrote nothing. Four
    // of these appeared on 2026-08-26.
    const described = describeLeftover({
      kind: "incomplete",
      occupiedName: null,
      sizeBytes: 0,
      discStructure: null,
    })

    expect(described.isSafeToDelete).toBe(true)
    expect(described.detail).toContain("EMPTY")
  })

  it("refuses to bless a partial rip that has real content", () => {
    // D4: a killed rip keeps what it wrote. Half a disc might
    // still be worth something, and the operator decides.
    const described = describeLeftover({
      kind: "incomplete",
      occupiedName: null,
      sizeBytes: 4_000_000_000,
      discStructure: "VIDEO_TS",
    })

    expect(described.isSafeToDelete).toBe(false)
    expect(described.detail).toContain("UNFINISHED")
    expect(described.detail).toContain("4.0 GB")
    expect(described.detail).toContain("VIDEO_TS directory")
  })

  it("⚠️ describes a DVD image as an image, not a directory", () => {
    // A DVD backup is a FILE — `makemkvcon` writes one ISO, not
    // a folder — and calling it "a directory" on the card would
    // send the operator looking for something that is not there.
    const described = describeLeftover({
      kind: "incomplete",
      occupiedName: null,
      sizeBytes: 8_203_894_784,
      discStructure: "ISO",
    })

    expect(described.isSafeToDelete).toBe(false)
    expect(described.detail).toContain("ISO disc image")
    expect(described.detail).not.toContain("directory")
  })

  it("says a partial rip with no structure is unreadable", () => {
    // Bytes on disk, but no VIDEO_TS/BDMV — no player or scanner
    // can open it, so the size alone would mislead.
    const described = describeLeftover({
      kind: "incomplete",
      occupiedName: null,
      sizeBytes: 600_000_000,
      discStructure: null,
    })

    expect(described.isSafeToDelete).toBe(true)
    expect(described.detail).toContain("600 MB")
    expect(described.detail).toContain("no VIDEO_TS")
    expect(described.detail).toContain(
      "no ISO9660 signature",
    )
  })

  it("⚠️ never blesses a duplicate — it is a FINISHED rip", () => {
    const described = describeLeftover({
      kind: "duplicate",
      occupiedName: "Ivanhoe (1952) - Blu-ray",
      sizeBytes: 22_000_000_000,
      discStructure: "BDMV",
    })

    expect(described.isSafeToDelete).toBe(false)
    expect(described.detail).toContain("FINISHED")
    expect(described.detail).toContain(
      "Ivanhoe (1952) - Blu-ray",
    )
  })
})

describe("refusing a dangerous delete", () => {
  const root = "/media/Disc-Rips"

  it("allows a leftover in the destination root", () => {
    expect(
      refusalToDeleteLeftover({
        rootPath: root,
        path: `${root}/.rip-deck-incomplete-abc-123`,
      }),
    ).toBeNull()
  })

  it("⚠️ refuses a FINISHED rip", () => {
    // The endpoint clears leftovers. It is not a library manager,
    // and it must never become one by accident.
    expect(
      refusalToDeleteLeftover({
        rootPath: root,
        path: `${root}/[BACKUP] Ivanhoe (1952) - Blu-ray`,
      }),
    ).toContain("not a Rip Deck leftover")
  })

  it("⚠️ refuses a path that climbs out of the root", () => {
    expect(
      refusalToDeleteLeftover({
        rootPath: root,
        path: `${root}/../../etc/.rip-deck-incomplete-x`,
      }),
    ).toContain("is not inside")
  })

  it("⚠️ refuses the destination root itself", () => {
    expect(
      refusalToDeleteLeftover({
        rootPath: root,
        path: root,
      }),
    ).toContain("destination root itself")
  })

  it("⚠️ refuses a nested path even when the name looks right", () => {
    // Only a DIRECT child is clearable. A leftover is never
    // nested, so a nested one is somebody else's directory.
    expect(
      refusalToDeleteLeftover({
        rootPath: root,
        path: `${root}/Some Film/.rip-deck-incomplete-abc`,
      }),
    ).toContain("direct child")
  })
})

describe("scanning and clearing, on a real filesystem", () => {
  const tmpRoot = join(
    tmpdir(),
    `rip-deck-leftovers-${process.pid}`,
  )

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it("finds the leftovers and leaves the library alone", async () => {
    const empty = join(
      tmpRoot,
      ".rip-deck-incomplete-empty-1",
    )
    const partial = join(
      tmpRoot,
      ".rip-deck-incomplete-partial-2",
    )
    const finished = join(
      tmpRoot,
      "[BACKUP] Real Rip - DVD",
    )

    await mkdir(join(partial, "VIDEO_TS"), {
      recursive: true,
    })
    await writeFile(
      join(partial, "VIDEO_TS", "VTS_01_1.VOB"),
      "x".repeat(1024),
      "utf8",
    )
    await mkdir(empty, { recursive: true })
    await mkdir(join(finished, "VIDEO_TS"), {
      recursive: true,
    })

    const found = await scanLeftovers({ rootPath: tmpRoot })

    expect(found.map((one) => one.name).sort()).toEqual([
      ".rip-deck-incomplete-empty-1",
      ".rip-deck-incomplete-partial-2",
    ])

    const partialFound = found.find(
      (one) =>
        one.name === ".rip-deck-incomplete-partial-2",
    )
    expect(partialFound?.discStructure).toBe("VIDEO_TS")
    expect(partialFound?.sizeBytes).toBe(1024)
    expect(partialFound?.isSafeToDelete).toBe(false)

    const emptyFound = found.find(
      (one) => one.name === ".rip-deck-incomplete-empty-1",
    )
    expect(emptyFound?.sizeBytes).toBe(0)
    expect(emptyFound?.isSafeToDelete).toBe(true)
  })

  it("⚠️ lists a leftover DVD image, which is a FILE", async () => {
    // `scanLeftovers` used to skip anything that was not a
    // directory, which made every leftover DVD invisible to the
    // one panel that exists to clear them.
    const image = join(
      tmpRoot,
      ".rip-deck-incomplete-image-3",
    )
    const bytes = Buffer.alloc(40_000)
    bytes.write("CD001", 32_769, "latin1")
    await writeFile(image, bytes)

    const found = await scanLeftovers({ rootPath: tmpRoot })
    const listed = found.find(
      (one) => one.name === ".rip-deck-incomplete-image-3",
    )

    expect(listed?.discStructure).toBe("ISO")
    expect(listed?.sizeBytes).toBe(40_000)
    expect(listed?.detail).toContain("ISO disc image")

    await rm(image, { force: true })
  })

  it("clears one, and refuses the finished rip beside it", async () => {
    const cleared = await deleteLeftover({
      rootPath: tmpRoot,
      path: join(tmpRoot, ".rip-deck-incomplete-empty-1"),
    })
    expect(cleared.isDeleted).toBe(true)

    const refused = await deleteLeftover({
      rootPath: tmpRoot,
      path: join(tmpRoot, "[BACKUP] Real Rip - DVD"),
    })
    expect(refused.isDeleted).toBe(false)
    expect(refused.message).toContain(
      "not a Rip Deck leftover",
    )

    const remaining = await scanLeftovers({
      rootPath: tmpRoot,
    })
    expect(remaining.map((one) => one.name)).toEqual([
      ".rip-deck-incomplete-partial-2",
    ])
  })
})

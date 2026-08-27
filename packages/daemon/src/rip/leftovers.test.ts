import {
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  classifyLeftover,
  deleteLeftover,
  describeLeftover,
  refusalToDeleteLeftover,
  refusalToRenameLeftover,
  renamedLeftoverName,
  renameLeftover,
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

  it("⚠️ claims a duplicate DVD, whose name ends in .iso", () => {
    // `finaliseDestination` puts the marker BEFORE the extension,
    // so a collided DVD image is `… (rip-deck-duplicate-x).iso`.
    // The first version of this tested `endsWith(")")` and
    // therefore saw every Blu-ray collision and no DVD one —
    // which hid the exact folder the rename control exists for.
    expect(
      classifyLeftover(
        "Teenage Mutant Ninja Turtles - DVD (rip-deck-duplicate-68fa9004).iso",
      ),
    ).toEqual({
      kind: "duplicate",
      // The name it collided with keeps the extension, because
      // the occupied file is an ISO too.
      occupiedName:
        "Teenage Mutant Ninja Turtles - DVD.iso",
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

/**
 * ⚠️ **Every one of these is a way to lose 8 GB.** The rename
 * control exists because a Ninja Turtles box set carries wrong
 * and inconsistent UDF volume labels, and two discs share one
 * label outright — so the operator retypes a name by hand, into
 * a directory holding 700-odd finished rips. Each refusal below
 * is one keystroke away from being pressed for real.
 */
describe("refusing a rename", () => {
  const root = "/media/Disc-Rips"
  const leftover = `${root}/[BACKUP] TMNT - DVD (rip-deck-duplicate-68fa9004).iso`

  it("allows a plain new name for a leftover in the root", () => {
    expect(
      refusalToRenameLeftover({
        newName: "[BACKUP] TMNT Season 4 Disc 2 - DVD.iso",
        path: leftover,
        rootPath: root,
      }),
    ).toBeNull()
  })

  it("⚠️ allows a name that is NOT a leftover — that is the point", () => {
    // Removing the `(rip-deck-duplicate-…)` marker is the main
    // reason to rename at all. A rename whose result still had
    // to look like a leftover could never do it.
    expect(
      refusalToRenameLeftover({
        newName: "[BACKUP] TMNT Season 4 Disc 2 - DVD",
        path: leftover,
        rootPath: root,
      }),
    ).toBeNull()
  })

  it("⚠️ refuses a new name holding a path separator", () => {
    // A rename renames in place. A name with a slash in it is a
    // caller asking to MOVE, which this endpoint does not do —
    // and `../../etc/passwd` is the same request spelled worse.
    expect(
      refusalToRenameLeftover({
        newName: "../../etc/passwd",
        path: leftover,
        rootPath: root,
      }),
    ).toContain("is a path, not a name")
  })

  it("⚠️ refuses a Windows-style separator too", () => {
    expect(
      refusalToRenameLeftover({
        newName: "sub\\folder",
        path: leftover,
        rootPath: root,
      }),
    ).toContain("is a path, not a name")
  })

  it("⚠️ refuses `..` as the whole new name", () => {
    // `rename(x, "..")` is a question with no good answer.
    expect(
      refusalToRenameLeftover({
        newName: "..",
        path: leftover,
        rootPath: root,
      }),
    ).toContain("directory traversal")
  })

  it("⚠️ refuses `.` as the whole new name", () => {
    expect(
      refusalToRenameLeftover({
        newName: ".",
        path: leftover,
        rootPath: root,
      }),
    ).toContain("directory traversal")
  })

  it("refuses an empty new name", () => {
    expect(
      refusalToRenameLeftover({
        newName: "",
        path: leftover,
        rootPath: root,
      }),
    ).toContain("empty")
  })

  it("refuses a new name that is only whitespace", () => {
    expect(
      refusalToRenameLeftover({
        newName: "   \t  ",
        path: leftover,
        rootPath: root,
      }),
    ).toContain("empty")
  })

  it("refuses a new name with a control character in it", () => {
    expect(
      refusalToRenameLeftover({
        newName: "TMNT\u0000Disc 2",
        path: leftover,
        rootPath: root,
      }),
    ).toContain("control character")
  })

  it("⚠️ refuses a SOURCE that climbs out of the root", () => {
    expect(
      refusalToRenameLeftover({
        newName: "anything",
        path: `${root}/../../etc/.rip-deck-incomplete-x`,
        rootPath: root,
      }),
    ).toContain("is not inside")
  })

  it("⚠️ refuses the destination root itself as the source", () => {
    expect(
      refusalToRenameLeftover({
        newName: "anything",
        path: root,
        rootPath: root,
      }),
    ).toContain("destination root itself")
  })

  it("⚠️ refuses a FINISHED rip as the source", () => {
    // The panel resolves leftovers. It is not a library
    // renamer, and it must never become one by accident.
    expect(
      refusalToRenameLeftover({
        newName: "Ivanhoe (1952)",
        path: `${root}/[BACKUP] Ivanhoe (1952) - Blu-ray`,
        rootPath: root,
      }),
    ).toContain("not a Rip Deck leftover")
  })

  it("⚠️ refuses a nested source even when the name looks right", () => {
    expect(
      refusalToRenameLeftover({
        newName: "anything",
        path: `${root}/Some Film/.rip-deck-incomplete-abc`,
        rootPath: root,
      }),
    ).toContain("direct child")
  })

  it("says a rename may be REFUSED rather than deleted", () => {
    // The two verbs share four rules and must not share their
    // sentences: "not deletable from here" is the wrong thing to
    // show somebody who pressed Rename.
    expect(
      refusalToRenameLeftover({
        newName: "x",
        path: `${root}/[BACKUP] Ivanhoe (1952) - Blu-ray`,
        rootPath: root,
      }),
    ).toContain("not renamable from here")
  })
})

describe("keeping the .iso suffix on a renamed DVD", () => {
  it("⚠️ appends .iso when the rip is a FILE and the name omits it", () => {
    // A DVD backup is one ISO file. An extension-less 8 GB image
    // is what Windows offers to open in a text editor and what
    // no scanner recognises.
    expect(
      renamedLeftoverName({
        isFile: true,
        newName: "[BACKUP] TMNT Season 4 Disc 2 - DVD",
      }),
    ).toBe("[BACKUP] TMNT Season 4 Disc 2 - DVD.iso")
  })

  it("does not double the suffix when the name already has it", () => {
    expect(
      renamedLeftoverName({
        isFile: true,
        newName: "[BACKUP] TMNT - DVD.iso",
      }),
    ).toBe("[BACKUP] TMNT - DVD.iso")
  })

  it("accepts an upper-case .ISO as already suffixed", () => {
    expect(
      renamedLeftoverName({
        isFile: true,
        newName: "[BACKUP] TMNT - DVD.ISO",
      }),
    ).toBe("[BACKUP] TMNT - DVD.ISO")
  })

  it("⚠️ leaves a DIRECTORY alone — a Blu-ray takes no suffix", () => {
    expect(
      renamedLeftoverName({
        isFile: false,
        newName: "[BACKUP] Ivanhoe (1952) - Blu-ray",
      }),
    ).toBe("[BACKUP] Ivanhoe (1952) - Blu-ray")
  })

  it("trims the operator's stray spaces", () => {
    expect(
      renamedLeftoverName({
        isFile: false,
        newName: "  Ivanhoe  ",
      }),
    ).toBe("Ivanhoe")
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

/**
 * ⚠️ **The clobber test is the one that matters.** The reason to
 * rename is a name collision, so resolving one by overwriting an
 * 8 GB ISO with another 8 GB ISO would be the worst thing this
 * code could do. It cannot be a pure test: "is something already
 * there" is a filesystem fact.
 */
describe("renaming, on a real filesystem", () => {
  const tmpRoot = join(
    tmpdir(),
    `rip-deck-rename-${process.pid}`,
  )

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it("renames a duplicate landing out of its marker", async () => {
    const marked = join(
      tmpRoot,
      "[BACKUP] TMNT - DVD (rip-deck-duplicate-68fa9004)",
    )
    await mkdir(join(marked, "VIDEO_TS"), {
      recursive: true,
    })

    const renamed = await renameLeftover({
      newName: "[BACKUP] TMNT Season 4 Disc 2 - DVD",
      path: marked,
      rootPath: tmpRoot,
    })

    expect(renamed.isRenamed).toBe(true)
    expect(renamed.path).toBe(
      join(tmpRoot, "[BACKUP] TMNT Season 4 Disc 2 - DVD"),
    )

    // It is out of the panel now, because the new name is not a
    // leftover's — which is the whole point of the control.
    const remaining = await scanLeftovers({
      rootPath: tmpRoot,
    })
    expect(remaining.map((one) => one.name)).toEqual([])
  })

  it("⚠️ REFUSES rather than clobbering an existing name", async () => {
    const occupied = join(tmpRoot, "[BACKUP] Kept - DVD")
    const marked = join(
      tmpRoot,
      "[BACKUP] Kept - DVD (rip-deck-duplicate-01234567)",
    )
    await mkdir(occupied, { recursive: true })
    await writeFile(
      join(occupied, "keep-me"),
      "the good copy",
      "utf8",
    )
    await mkdir(marked, { recursive: true })

    const refused = await renameLeftover({
      newName: "[BACKUP] Kept - DVD",
      path: marked,
      rootPath: tmpRoot,
    })

    expect(refused.isRenamed).toBe(false)
    expect(refused.message).toContain("already taken")

    // Both are still there, and the good copy is untouched.
    expect(await readdir(occupied)).toEqual(["keep-me"])
    expect(
      (await scanLeftovers({ rootPath: tmpRoot })).map(
        (one) => one.name,
      ),
    ).toEqual([
      "[BACKUP] Kept - DVD (rip-deck-duplicate-01234567)",
    ])

    await rm(marked, { recursive: true, force: true })
    await rm(occupied, { recursive: true, force: true })
  })

  it("⚠️ appends .iso when the leftover is a FILE", async () => {
    // The shape that produced the whole DVD bug: MakeMKV writes
    // a decrypted image with no extension at all.
    const image = join(
      tmpRoot,
      ".rip-deck-incomplete-image-iso",
    )
    const bytes = Buffer.alloc(40_000)
    bytes.write("CD001", 32_769, "latin1")
    await writeFile(image, bytes)

    const renamed = await renameLeftover({
      newName: "[BACKUP] TMNT Season 4 Disc 1 - DVD",
      path: image,
      rootPath: tmpRoot,
    })

    expect(renamed.isRenamed).toBe(true)
    expect(renamed.path).toBe(
      join(
        tmpRoot,
        "[BACKUP] TMNT Season 4 Disc 1 - DVD.iso",
      ),
    )

    await rm(renamed.path ?? "", { force: true })
  })

  it("⚠️ refuses to rename a FINISHED rip", async () => {
    const finished = join(tmpRoot, "[BACKUP] Real - DVD")
    await mkdir(finished, { recursive: true })

    const refused = await renameLeftover({
      newName: "Something Else",
      path: finished,
      rootPath: tmpRoot,
    })

    expect(refused.isRenamed).toBe(false)
    expect(refused.message).toContain(
      "not a Rip Deck leftover",
    )
    expect(refused.path).toBeNull()

    await rm(finished, { recursive: true, force: true })
  })

  it("⚠️ refuses to escape the root through the new name", async () => {
    const marked = join(
      tmpRoot,
      ".rip-deck-incomplete-escape-1",
    )
    await mkdir(marked, { recursive: true })

    const refused = await renameLeftover({
      newName: "../escaped",
      path: marked,
      rootPath: tmpRoot,
    })

    expect(refused.isRenamed).toBe(false)
    expect(refused.message).toContain(
      "is a path, not a name",
    )

    await rm(marked, { recursive: true, force: true })
  })

  it("says so rather than renaming a leftover that is gone", async () => {
    const refused = await renameLeftover({
      newName: "Anything",
      path: join(tmpRoot, ".rip-deck-incomplete-vanished"),
      rootPath: tmpRoot,
    })

    expect(refused.isRenamed).toBe(false)
    expect(refused.message).toContain("no longer there")
  })

  it("refuses the name it already has", async () => {
    const marked = join(
      tmpRoot,
      ".rip-deck-incomplete-same-1",
    )
    await mkdir(marked, { recursive: true })

    const refused = await renameLeftover({
      newName: ".rip-deck-incomplete-same-1",
      path: marked,
      rootPath: tmpRoot,
    })

    expect(refused.isRenamed).toBe(false)
    expect(refused.message).toContain(
      "the name it already has",
    )

    await rm(marked, { recursive: true, force: true })
  })
})

import {
  mkdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  applyOutputOwnership,
  buildFolderName,
  createOutputOwnership,
  DEFAULT_OUTPUT_GID,
  DEFAULT_OUTPUT_UID,
  finaliseDestination,
  incompleteDirName,
  prepareDestination,
  SPACE_HEADROOM_FRACTION,
  sanitiseFolderName,
} from "./destination.ts"

describe("folder naming (B2)", () => {
  it("uses {title} ({year}) - {type}", () => {
    expect(
      buildFolderName({
        title: "Blade Runner",
        year: 1982,
        discType: "bluray",
        isDiscBackup: false,
      }),
    ).toBe("Blade Runner (1982) - Blu-ray")
  })

  it("labels UHD as 4K", () => {
    expect(
      buildFolderName({
        title: "Dune",
        year: 2021,
        discType: "uhd",
        isDiscBackup: false,
      }),
    ).toBe("Dune (2021) - 4K")
  })

  it("omits the year when it is unknown", () => {
    // Inventing one would bury the only fact that makes the disc
    // findable again.
    expect(
      buildFolderName({
        title: "Home Video",
        year: null,
        discType: "dvd",
        isDiscBackup: false,
      }),
    ).toBe("Home Video - DVD")
  })

  it("omits the suffix for a type with no label", () => {
    expect(
      buildFolderName({
        title: "Some Album",
        year: null,
        discType: "cd",
        isDiscBackup: false,
      }),
    ).toBe("Some Album")
  })

  it("marks a disc backup so it is findable as one", () => {
    // 723 of ARM's finished rips share this dataset. Telling a
    // whole-disc backup apart from a finished rip by looking
    // inside is the manual work this prefix removes.
    expect(
      buildFolderName({
        title: "Ivanhoe",
        year: 1952,
        discType: "bluray",
        isDiscBackup: true,
      }),
    ).toBe("[BACKUP] Ivanhoe (1952) - Blu-ray")
  })

  it("does NOT mark an audio CD as a backup", () => {
    // cyanrip emits a finished, tagged FLAC album with nothing
    // left to extract, so claiming it needs post-processing
    // would be a lie.
    expect(
      buildFolderName({
        title: "Kind of Blue",
        year: 1959,
        discType: "cd",
        isDiscBackup: false,
      }),
    ).toBe("Kind of Blue (1959)")
  })

  it("keeps the marker when a hostile title is truncated", () => {
    // The body is sanitised and cut BEFORE the prefix goes on,
    // so the marker can never be the part that falls off the end.
    const name = buildFolderName({
      title: "A".repeat(400),
      year: null,
      discType: "bluray",
      isDiscBackup: true,
    })

    expect(name.startsWith("[BACKUP] ")).toBe(true)
    expect(name.length).toBeLessThanOrEqual(200)
  })

  it("keeps the marker intact when the title contains one", () => {
    const name = buildFolderName({
      title: "[BACKUP] Not Really",
      year: null,
      discType: "dvd",
      isDiscBackup: false,
    })

    expect(name).toBe("[BACKUP] Not Really - DVD")
  })
})

describe("sanitising for an SMB-served library", () => {
  it("strips Windows-illegal characters", () => {
    // A folder Linux accepts but Windows cannot open is a folder
    // the owner cannot reach.
    expect(sanitiseFolderName('A:B*C?D"E<F>G|H/I\\J')).toBe(
      "ABCDEFGHIJ",
    )
  })

  it("keeps spaces, hyphens and dots inside the name", () => {
    expect(
      sanitiseFolderName("Mission - Impossible Vol. 2"),
    ).toBe("Mission - Impossible Vol. 2")
  })

  it("strips control characters", () => {
    expect(sanitiseFolderName("A\u0000B\u001fC")).toBe(
      "ABC",
    )
  })

  it("collapses runs of whitespace", () => {
    expect(sanitiseFolderName("A    B")).toBe("A B")
  })

  it("drops a trailing dot or space", () => {
    // Windows silently drops these, which turns "Vol. 2." into a
    // name that never matches on lookup.
    expect(sanitiseFolderName("Movie Vol. 2.")).toBe(
      "Movie Vol. 2",
    )
    expect(sanitiseFolderName("Movie ")).toBe("Movie")
  })

  it("bounds the length", () => {
    expect(
      sanitiseFolderName("x".repeat(500)).length,
    ).toBeLessThanOrEqual(200)
  })
})

describe("the incomplete directory", () => {
  it("is hidden and carries the job uuid", () => {
    // Hidden so partial output is invisible to library scanners;
    // UUID-suffixed so orphan adoption can pin a running process
    // to exactly one job.
    expect(incompleteDirName("abc-123")).toBe(
      ".rip-deck-incomplete-abc-123",
    )
  })
})

describe("space preflight", () => {
  it("requires headroom over the disc size", () => {
    expect(SPACE_HEADROOM_FRACTION).toBeGreaterThan(1)
  })
})

describe("addressing the output from two filesystem views", () => {
  const tmpRoot = join(
    tmpdir(),
    `rip-deck-test-${process.pid}`,
  )

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it("uses one path for us and another for makemkvcon", async () => {
    // Measured on Tower: the destination dataset is
    // /media/Disc-Rips to us and /home/arm/media
    // inside the arm container. Handing our path to a
    // container-side makemkvcon addresses a directory that does
    // not exist there, so the rip fails before it starts.
    const prepared = await prepareDestination({
      rootPath: tmpRoot,
      folderName: "Some Film (2001) - Blu-ray",
      jobUuid: "uuid-1",
      innerRootPath: "/home/arm/media",
    })

    expect(prepared.incompletePath).toBe(
      join(tmpRoot, ".rip-deck-incomplete-uuid-1"),
    )
    expect(prepared.incompleteInnerPath).toBe(
      "/home/arm/media/.rip-deck-incomplete-uuid-1",
    )

    // The rename target stays entirely in OUR view — only the
    // argument makemkvcon receives is translated.
    expect(prepared.finalPath).toBe(
      join(tmpRoot, "Some Film (2001) - Blu-ray"),
    )
  })

  it("keeps both identical when views agree", async () => {
    // The normal case, and what Stage 6 should aim for.
    const prepared = await prepareDestination({
      rootPath: tmpRoot,
      folderName: "X",
      jobUuid: "uuid-2",
    })

    expect(prepared.incompleteInnerPath).toBe(
      prepared.incompletePath,
    )
  })
})

describe("output ownership (§2.7)", () => {
  it("defaults to the uid/gid the library already uses", () => {
    // Counted read-only on Tower 2026-07-26: 591 of the 724
    // folders under /media/Disc-Rips are 568:568.
    // rip-deck runs as root, so without this the output is
    // root:root and Plex cannot read it.
    expect(DEFAULT_OUTPUT_UID).toBe(568)
    expect(DEFAULT_OUTPUT_GID).toBe(568)

    expect(createOutputOwnership({})).toEqual({
      uid: 568,
      gid: 568,
    })
  })

  it("takes an override from the environment", () => {
    expect(
      createOutputOwnership({
        RIP_DECK_OUTPUT_UID: "1000",
        RIP_DECK_OUTPUT_GID: "1001",
      }),
    ).toEqual({ uid: 1000, gid: 1001 })
  })

  it("ignores an unparseable id rather than becoming root", () => {
    // Falling back to 0 on a typo would reintroduce exactly the
    // root:root bug this exists to fix.
    expect(
      createOutputOwnership({
        RIP_DECK_OUTPUT_UID: "apps",
        RIP_DECK_OUTPUT_GID: "-1",
      }),
    ).toEqual({ uid: 568, gid: 568 })
  })

  it("can be switched off entirely", () => {
    // A supported state, for running somewhere that is not this
    // pool or is not root.
    expect(
      createOutputOwnership({
        RIP_DECK_OUTPUT_CHOWN: "false",
      }),
    ).toBeNull()
  })
})

describe("finalising a rip", () => {
  const tmpRoot = join(
    tmpdir(),
    `rip-deck-finalise-${process.pid}`,
  )

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const prepare = async (input: {
    jobUuid: string
    folderName: string
  }) => {
    const prepared = await prepareDestination({
      rootPath: tmpRoot,
      folderName: input.folderName,
      jobUuid: input.jobUuid,
    })

    await writeFile(
      join(prepared.incompletePath, "title_t00.mkv"),
      "bytes",
      "utf8",
    )

    return prepared
  }

  // chown to the ids we already have always succeeds, root or
  // not, so the walk is exercised without needing privilege.
  const ownSelf = {
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  }

  it("chowns the whole tree before publishing it", async () => {
    const prepared = await prepare({
      jobUuid: "own-1",
      folderName: "Ivanhoe (1952) - Blu-ray",
    })

    const finalised = await finaliseDestination(
      prepared,
      ownSelf,
    )

    expect(finalised.ownershipError).toBeNull()

    const stats = await stat(
      join(finalised.path, "title_t00.mkv"),
    )
    expect(stats.uid).toBe(ownSelf.uid)
    expect(stats.gid).toBe(ownSelf.gid)
  })

  it("recurses into subdirectories", async () => {
    const prepared = await prepare({
      jobUuid: "own-2",
      folderName: "Nested",
    })
    await mkdir(
      join(prepared.incompletePath, "BDMV/STREAM"),
      {
        recursive: true,
      },
    )
    await writeFile(
      join(
        prepared.incompletePath,
        "BDMV/STREAM/00000.m2ts",
      ),
      "bytes",
      "utf8",
    )

    await applyOutputOwnership({
      path: prepared.incompletePath,
      ownership: ownSelf,
    })

    const stats = await stat(
      join(
        prepared.incompletePath,
        "BDMV/STREAM/00000.m2ts",
      ),
    )
    expect(stats.uid).toBe(ownSelf.uid)
  })

  it("leaves ownership alone when it is switched off", async () => {
    const prepared = await prepare({
      jobUuid: "own-3",
      folderName: "Untouched",
    })

    const finalised = await finaliseDestination(
      prepared,
      null,
    )

    expect(finalised.ownershipError).toBeNull()
    expect(finalised.path).toBe(join(tmpRoot, "Untouched"))
  })

  it("publishes the rip anyway when the chown fails", async () => {
    // -2 is out of range for chown, standing in for the real
    // failure (EPERM when not root). The point is the outcome: a
    // disc that read correctly must still land somewhere the
    // owner can find, because wrong ownership is one manual
    // `chown -R` away from fixed and a rip stranded in a
    // dot-directory is not.
    const prepared = await prepare({
      jobUuid: "own-4",
      folderName: "Landed Anyway",
    })

    const finalised = await finaliseDestination(prepared, {
      uid: -2,
      gid: -2,
    })

    expect(finalised.path).toBe(
      join(tmpRoot, "Landed Anyway"),
    )
    await expect(
      stat(join(finalised.path, "title_t00.mkv")),
    ).resolves.toBeDefined()

    // ...and says so, naming where the rip actually is and
    // warning off chmod, which fails on this NFSv4-ACL pool.
    expect(finalised.ownershipError).toContain(
      "Landed Anyway",
    )
    expect(finalised.ownershipError).toContain("chown -R")
    expect(finalised.ownershipError).toContain("NOT chmod")
  })

  it("never clobbers an existing folder", async () => {
    await mkdir(join(tmpRoot, "Taken"), { recursive: true })

    const prepared = await prepare({
      jobUuid: "collide-01234567",
      folderName: "Taken",
    })

    const finalised = await finaliseDestination(
      prepared,
      null,
    )

    expect(finalised.hasCollision).toBe(true)
    expect(finalised.path).toBe(
      join(tmpRoot, "Taken (rip-deck-duplicate-collide-)"),
    )
  })
})

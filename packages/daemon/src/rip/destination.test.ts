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
  ISO_SUFFIX,
  incompleteDirName,
  pathExists,
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

  it("uses one path for us and another for makemkvcon", () => {
    // Measured on Tower: the destination dataset is
    // /media/Disc-Rips to us and /home/arm/media
    // inside the arm container. Handing our path to a
    // container-side makemkvcon addresses a directory that does
    // not exist there, so the rip fails before it starts.
    const prepared = prepareDestination({
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

  it("keeps both identical when views agree", () => {
    // The normal case, and what Stage 6 should aim for.
    const prepared = prepareDestination({
      rootPath: tmpRoot,
      folderName: "X",
      jobUuid: "uuid-2",
    })

    expect(prepared.incompleteInnerPath).toBe(
      prepared.incompletePath,
    )
  })

  it("⚠️ does NOT create the incomplete directory", async () => {
    // The regression guard for 2026-08-26. `makemkvcon backup`
    // REFUSES a destination that already exists — even an empty
    // one — with
    //
    //   MSG:5068 "Folder … already contains a backup, please
    //             choose another folder"
    //
    // and then exits 0 having written nothing. Pre-creating the
    // directory here failed four DVDs in a row, and the only
    // symptom upstream was `empty_output` with no cause named.
    //
    // Proven by A/B on the live tower, same disc and drive: with
    // the directory present, MSG:5068; with it absent, the backup
    // runs. So the leaf is a NAME and makemkvcon owns creating
    // it. cyanrip is the opposite case and creates its own —
    // see `ripAudioCd`.
    const prepared = prepareDestination({
      rootPath: tmpRoot,
      folderName: "Untouched (2026) - DVD",
      jobUuid: "uuid-no-mkdir",
    })

    expect(await pathExists(prepared.incompletePath)).toBe(
      false,
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
    const prepared = prepareDestination({
      rootPath: tmpRoot,
      folderName: input.folderName,
      jobUuid: input.jobUuid,
    })

    // Standing in for `makemkvcon backup`, which creates this
    // directory itself — `prepareDestination` deliberately does
    // not, because MakeMKV refuses a destination that already
    // exists (MSG:5068). Every test below is about what happens
    // AFTER a rip wrote something, so the write has to be faked
    // here rather than assumed.
    await mkdir(prepared.incompletePath, {
      recursive: true,
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

/**
 * ⚠️ A DVD backup lands as a single ISO FILE, not a directory —
 * see `verifyBackup.ts` for the measurement. Everything below is
 * about the file shape, which nothing here handled until
 * 2026-08-26.
 */
describe("finalising a DVD, which is one ISO file", () => {
  const tmpRoot = join(
    tmpdir(),
    `rip-deck-iso-finalise-${process.pid}`,
  )

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const prepareImage = async (input: {
    jobUuid: string
    folderName: string
  }) => {
    const prepared = prepareDestination({
      rootPath: tmpRoot,
      folderName: input.folderName,
      jobUuid: input.jobUuid,
    })

    await mkdir(tmpRoot, { recursive: true })
    // Standing in for `makemkvcon backup` on a DVD: it writes a
    // FILE at exactly this path, with no extension.
    await writeFile(prepared.incompletePath, "iso", "utf8")

    return prepared
  }

  it("publishes it with an .iso extension", async () => {
    // Without this the library gains an 8 GB file named
    // `[BACKUP] Some Film (1987) - DVD`, which Windows offers to
    // open with a text editor.
    const prepared = await prepareImage({
      jobUuid: "iso-1",
      folderName: "[BACKUP] Some Film (1987) - DVD",
    })

    const finalised = await finaliseDestination(
      prepared,
      null,
    )

    expect(finalised.path).toBe(
      join(
        tmpRoot,
        `[BACKUP] Some Film (1987) - DVD${ISO_SUFFIX}`,
      ),
    )
    expect(await pathExists(finalised.path)).toBe(true)
  })

  it("⚠️ puts a collision marker BEFORE the extension", async () => {
    // `… .iso (rip-deck-duplicate-01234567)` is not an ISO to
    // anything that reads extensions, and staying openable is
    // the one property the second copy has to keep.
    const prepared = await prepareImage({
      jobUuid: "iso-2abcdefg",
      folderName: "[BACKUP] Some Film (1987) - DVD",
    })

    const finalised = await finaliseDestination(
      prepared,
      null,
    )

    expect(finalised.hasCollision).toBe(true)
    expect(finalised.path).toBe(
      join(
        tmpRoot,
        "[BACKUP] Some Film (1987) - DVD " +
          `(rip-deck-duplicate-iso-2abc)${ISO_SUFFIX}`,
      ),
    )
  })

  it("leaves a Blu-ray directory's name alone", async () => {
    // The suffix comes from what is ON DISK, so the directory
    // shape must be untouched by it.
    const prepared = prepareDestination({
      rootPath: tmpRoot,
      folderName: "[BACKUP] Some Disc (2001) - Blu-ray",
      jobUuid: "dir-1",
    })

    await mkdir(join(prepared.incompletePath, "BDMV"), {
      recursive: true,
    })

    const finalised = await finaliseDestination(
      prepared,
      null,
    )

    expect(finalised.path).toBe(
      join(tmpRoot, "[BACKUP] Some Disc (2001) - Blu-ray"),
    )
  })

  it("⚠️ chowns an image without throwing ENOTDIR", async () => {
    // `applyOutputOwnership` used to `readdir` its own argument.
    // On a file that throws, and the throw reached
    // `failureOfChown` — so every DVD would have reported
    // landing with the wrong owner while the chown had in fact
    // succeeded.
    const prepared = await prepareImage({
      jobUuid: "iso-own",
      folderName: "[BACKUP] Owned Film (1990) - DVD",
    })

    const finalised = await finaliseDestination(prepared, {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    })

    expect(finalised.ownershipError).toBeNull()
  })
})

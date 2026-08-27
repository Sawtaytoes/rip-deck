import { EMPTY_TRAY_SECTORS } from "@rip-deck/contracts"
import { describe, expect, it } from "vitest"
import {
  type DiscTypeDecision,
  decideDiscType,
  detectDiscType,
  parseUdevDatabaseRecord,
  readUdevMedia,
  readVolumeLabel,
} from "./discType.ts"

/**
 * Sector counts for the disc tiers, in 512-byte sectors.
 *
 * Real-ish rather than exact: the only boundary that has to be
 * precise is `EMPTY_TRAY_SECTORS`, and that comes from the
 * contract rather than from a literal here.
 */
const SECTORS = {
  /** A ~74-minute album. */
  audioCd: 1_300_000,
  /** DVD-9. */
  dvd: 15_000_000,
  /** BD-50. */
  bluray: 90_000_000,
  /** BD-100, which in practice means UHD. */
  uhd: 190_000_000,
} as const

const udev = (
  properties: Record<string, string>,
): ReadonlyMap<string, string> =>
  new Map(Object.entries(properties))

/** A drive with no disc in it, as `cdrom_id` describes it. */
const emptyDrive = udev({
  ID_CDROM: "1",
  ID_CDROM_CD: "1",
  ID_CDROM_DVD: "1",
  ID_CDROM_BD: "1",
})

const audioCdRecord = udev({
  ID_CDROM: "1",
  ID_CDROM_CD: "1",
  ID_CDROM_BD: "1",
  ID_CDROM_MEDIA: "1",
  ID_CDROM_MEDIA_CD: "1",
  ID_CDROM_MEDIA_STATE: "complete",
  ID_CDROM_MEDIA_TRACK_COUNT: "12",
  ID_CDROM_MEDIA_TRACK_COUNT_AUDIO: "12",
})

const blurayRecord = udev({
  ID_CDROM: "1",
  ID_CDROM_BD: "1",
  ID_CDROM_MEDIA: "1",
  ID_CDROM_MEDIA_BD: "1",
  ID_CDROM_MEDIA_STATE: "complete",
  ID_CDROM_MEDIA_TRACK_COUNT: "1",
  ID_CDROM_MEDIA_TRACK_COUNT_DATA: "1",
})

const dvdRecord = udev({
  ID_CDROM: "1",
  ID_CDROM_BD: "1",
  ID_CDROM_MEDIA: "1",
  ID_CDROM_MEDIA_DVD: "1",
  ID_CDROM_MEDIA_STATE: "complete",
  ID_CDROM_MEDIA_TRACK_COUNT_DATA: "1",
})

describe("parsing a udev database record", () => {
  it("takes the exported properties and nothing else", () => {
    // The file is line-tagged: E: is the property export, the
    // rest is udev's own bookkeeping and means nothing to us.
    const parsed = parseUdevDatabaseRecord(
      [
        "I:6602399",
        "E:ID_CDROM=1",
        "E:ID_CDROM_MEDIA=1",
        "G:systemd",
        "Q:systemd",
        "W:2",
      ].join("\n"),
    )

    expect(parsed.get("ID_CDROM")).toBe("1")
    expect(parsed.get("ID_CDROM_MEDIA")).toBe("1")
    expect(parsed.size).toBe(2)
  })

  it("splits on the first '=' only", () => {
    // Values legitimately contain more of them; splitting on
    // all of them truncates the value instead of failing, which
    // is the kind of silent wrong answer this codebase keeps
    // getting bitten by.
    const parsed = parseUdevDatabaseRecord(
      "E:ID_SERIAL=Slimtype_BD_A_DA8AESH=abc",
    )

    expect(parsed.get("ID_SERIAL")).toBe(
      "Slimtype_BD_A_DA8AESH=abc",
    )
  })

  it("survives a file that is not a udev record", () => {
    expect(parseUdevDatabaseRecord("").size).toBe(0)
    expect(
      parseUdevDatabaseRecord("garbage\nE:no-equals").size,
    ).toBe(0)
  })
})

describe("reading media facts out of udev", () => {
  it("has nothing to say about a non-optical record", () => {
    // Null is "no evidence", which is a different state from
    // "evidence of an empty tray" and must not collapse into it.
    expect(
      readUdevMedia(udev({ DEVTYPE: "disk" })),
    ).toBeNull()
  })

  it("ignores the DRIVE's capability flags", () => {
    // Every unit in this tower is a Blu-ray writer, so all nine
    // permanently report ID_CDROM_BD=1 whether or not anything
    // is inserted. Matching those would type every disc in the
    // rack as a UHD BD.
    const media = readUdevMedia(emptyDrive)

    expect(media?.hasMedia).toBe(false)
    expect(media?.family).toBeNull()
  })

  it("reads the family off the MEDIA flags", () => {
    expect(readUdevMedia(audioCdRecord)?.family).toBe("cd")
    expect(readUdevMedia(dvdRecord)?.family).toBe("dvd")
    expect(readUdevMedia(blurayRecord)?.family).toBe("bd")
  })

  it("matches a profile suffix, not a prefix", () => {
    // ID_CDROM_MEDIA_CD_RW is CD; ID_CDROM_MEDIA_STATE and
    // ID_CDROM_MEDIA_TRACK_COUNT_* are neither.
    expect(
      readUdevMedia(
        udev({
          ID_CDROM: "1",
          ID_CDROM_MEDIA: "1",
          ID_CDROM_MEDIA_CD_RW: "1",
        }),
      )?.family,
    ).toBe("cd")

    expect(
      readUdevMedia(
        udev({
          ID_CDROM: "1",
          ID_CDROM_MEDIA: "1",
          ID_CDROM_MEDIA_STATE: "complete",
          ID_CDROM_MEDIA_TRACK_COUNT: "1",
        }),
      )?.family,
    ).toBeNull()
  })

  it("counts audio and data tracks", () => {
    const media = readUdevMedia(audioCdRecord)

    expect(media?.audioTrackCount).toBe(12)
    expect(media?.dataTrackCount).toBe(0)
  })
})

describe("the disc's own volume label", () => {
  // Every record below is copied from `/run/udev/data/b11:N` on
  // the live tower, 2026-08-26, with eight TMNT DVDs loaded.

  it("reads the label udev already recorded", () => {
    expect(
      readVolumeLabel(
        udev({
          ID_FS_LABEL:
            "Teenage_Mutant_Ninja_Turtles_V7_Disc_2",
        }),
      ),
    ).toBe("Teenage_Mutant_Ninja_Turtles_V7_Disc_2")
  })

  it("⚠️ prefers ID_FS_LABEL over the TRUNCATED ID_FS_VOLUME_ID", () => {
    // `ID_FS_VOLUME_ID` is the ISO9660 field and is capped at 32
    // characters. On this very disc it truncates the name to
    // `Teenage_Mutant_Ninja_Turtles_V`, losing the disc number —
    // which is the one part that distinguishes it from Disc 1.
    // `ID_FS_LABEL` comes from UDF and carries the whole string.
    const record = udev({
      ID_FS_VOLUME_ID: "Teenage_Mutant_Ninja_Turtles_V",
      ID_FS_LABEL: "Teenage_Mutant_Ninja_Turtles_V7_Disc_2",
    })

    expect(readVolumeLabel(record)).toBe(
      "Teenage_Mutant_Ninja_Turtles_V7_Disc_2",
    )
  })

  it("says null when udev recorded no label", () => {
    // Not "this disc has no name" — "ask makemkvcon". The
    // caller's fallback depends on that distinction.
    expect(readVolumeLabel(emptyDrive)).toBeNull()
  })

  it("treats an empty or blank label as no label", () => {
    expect(
      readVolumeLabel(udev({ ID_FS_LABEL: "" })),
    ).toBeNull()
    expect(
      readVolumeLabel(udev({ ID_FS_LABEL: "   " })),
    ).toBeNull()
  })

  it("carries the label onto a DVD routed to makemkv", () => {
    const decision = decideDiscType({
      sizeSectors: SECTORS.dvd,
      udevProperties: udev({
        ID_CDROM: "1",
        ID_CDROM_MEDIA: "1",
        ID_CDROM_MEDIA_DVD: "1",
        ID_CDROM_MEDIA_STATE: "complete",
        ID_CDROM_MEDIA_TRACK_COUNT_DATA: "1",
        ID_FS_LABEL: "TEENAGE_MUTANT_NINJA_TURTLES",
      }),
    })

    expect(decision.kind).toBe("rip")
    expect(
      decision.kind === "rip" ? decision.volumeLabel : null,
    ).toBe("TEENAGE_MUTANT_NINJA_TURTLES")
  })

  it("has no label on the capacity-only path, and says so", () => {
    // udev unreadable — the `/run/udev` mount missing, say. The
    // disc still routes, and `identifyDisc` is still the
    // fallback, exactly as before this shortcut existed.
    const decision = decideDiscType({
      sizeSectors: SECTORS.bluray,
      udevProperties: null,
    })

    expect(decision.kind).toBe("rip")
    expect(
      decision.kind === "rip" ? decision.volumeLabel : null,
    ).toBeNull()
  })
})

describe("the disc-type fork", () => {
  it("routes an audio CD to cyanrip", () => {
    // The owner's request, and requirement A3: CD uses cyanrip.
    expect(
      decideDiscType({
        sizeSectors: SECTORS.audioCd,
        udevProperties: audioCdRecord,
      }),
    ).toEqual({
      kind: "rip",
      discType: "cd",
      ripper: "cyanrip",
      capacityBytes: SECTORS.audioCd * 512,
      hasDataTracks: false,
      // No `ID_FS_LABEL` on an audio CD — it has no filesystem.
      // Harmless: an album names itself from AccurateRip/CDDB,
      // never from a volume label.
      volumeLabel: null,
    })
  })

  it("still rips a CD Extra, and says it has a data session", () => {
    // A 1990s enhanced CD is not ambiguous — cyanrip rips its
    // audio tracks and leaves the data one. Flagged rather than
    // dropped silently.
    const decision = decideDiscType({
      sizeSectors: SECTORS.audioCd,
      udevProperties: udev({
        ID_CDROM: "1",
        ID_CDROM_MEDIA: "1",
        ID_CDROM_MEDIA_CD: "1",
        ID_CDROM_MEDIA_STATE: "complete",
        ID_CDROM_MEDIA_TRACK_COUNT_AUDIO: "11",
        ID_CDROM_MEDIA_TRACK_COUNT_DATA: "1",
      }),
    })

    expect(decision.kind).toBe("rip")
    assertRip(decision)
    expect(decision.ripper).toBe("cyanrip")
    expect(decision.hasDataTracks).toBe(true)
  })

  it("routes DVD, BD and UHD BD to makemkv", () => {
    // Nothing different from before: the proven Stage 3 path.
    for (const [sectors, record, discType] of [
      [SECTORS.dvd, dvdRecord, "dvd"],
      [SECTORS.bluray, blurayRecord, "bluray"],
      [SECTORS.uhd, blurayRecord, "uhd"],
    ] as const) {
      const decision = decideDiscType({
        sizeSectors: sectors,
        udevProperties: record,
      })

      assertRip(decision)
      expect(decision.ripper).toBe("makemkv")
      expect(decision.discType).toBe(discType)
    }
  })

  it("splits UHD from BD on capacity, because udev cannot", () => {
    // A UHD disc IS a BD-ROM, so cdrom_id reports both as plain
    // ID_CDROM_MEDIA_BD. The >= ~55 GB threshold is B2's, and it
    // is also what names the folder "- 4K".
    const bd = decideDiscType({
      sizeSectors: SECTORS.bluray,
      udevProperties: blurayRecord,
    })
    const uhd = decideDiscType({
      sizeSectors: SECTORS.uhd,
      udevProperties: blurayRecord,
    })

    assertRip(bd)
    assertRip(uhd)
    expect(bd.discType).toBe("bluray")
    expect(uhd.discType).toBe("uhd")
  })

  it("never transcodes, on either branch", () => {
    // A2 is a property of the ripper choice: both branches are
    // whole-disc/whole-track copies. There is no third ripper to
    // pick, so this asserts the union stays closed.
    for (const decision of [
      decideDiscType({
        sizeSectors: SECTORS.audioCd,
        udevProperties: audioCdRecord,
      }),
      decideDiscType({
        sizeSectors: SECTORS.uhd,
        udevProperties: blurayRecord,
      }),
    ]) {
      assertRip(decision)
      expect(["makemkv", "cyanrip"]).toContain(
        decision.ripper,
      )
    }
  })
})

describe("the empty-tray sentinel", () => {
  it("is not a 1 GB disc", () => {
    // 2097151 sectors is a STABLE value, so it reaches the
    // settle check looking exactly like a real disc — and
    // 2097151 * 512 is a hair under 1 GiB, so capacity typing
    // alone would call it a CD and hand it to cyanrip.
    expect(
      decideDiscType({
        sizeSectors: EMPTY_TRAY_SECTORS,
        udevProperties: emptyDrive,
      }),
    ).toEqual({ kind: "no_media" })
  })

  it("is not a disc even with no udev record at all", () => {
    expect(
      decideDiscType({
        sizeSectors: EMPTY_TRAY_SECTORS,
        udevProperties: null,
      }),
    ).toEqual({ kind: "no_media" })
  })

  it("wants a human when udev insists there IS a disc", () => {
    // One of the two sources is stale. Believing "empty" would
    // leave a real disc sitting in the bay with nothing
    // reported, which is the silent version of the failure B3
    // exists to prevent.
    const decision = decideDiscType({
      sizeSectors: EMPTY_TRAY_SECTORS,
      udevProperties: blurayRecord,
    })

    assertAttention(decision)
    expect(decision.reason).toBe("conflicting_evidence")
  })

  it("reports a zero-size tray as empty", () => {
    expect(
      decideDiscType({
        sizeSectors: 0,
        udevProperties: emptyDrive,
      }),
    ).toEqual({ kind: "no_media" })
  })
})

describe("failing closed", () => {
  it("refuses cyanrip on capacity alone", () => {
    // THE safety rule of this module. Capacity cannot tell an
    // album from a driver CD, and the cyanrip branch has never
    // seen a disc — so it demands positive evidence of audio
    // tracks rather than inferring them from a size.
    const decision = decideDiscType({
      sizeSectors: SECTORS.audioCd,
      udevProperties: null,
    })

    assertAttention(decision)
    expect(decision.reason).toBe("audio_cd_unconfirmed")
  })

  it("refuses cyanrip for a disc too big to be a CD", () => {
    // A stale udev record describing the previous disc. An
    // "audio disc" of 45 GB is not one, and routing it to a CD
    // ripper is the worst outcome available here.
    const decision = decideDiscType({
      sizeSectors: SECTORS.bluray,
      udevProperties: audioCdRecord,
    })

    assertAttention(decision)
    expect(decision.reason).toBe("conflicting_evidence")
  })

  it("refuses a data CD, because ISO support is deferred", () => {
    // A4 is explicitly deferred, so there is no ripper for
    // this. Pretending otherwise produces a silent no-op or a
    // garbage rip.
    const decision = decideDiscType({
      sizeSectors: SECTORS.audioCd,
      udevProperties: udev({
        ID_CDROM: "1",
        ID_CDROM_MEDIA: "1",
        ID_CDROM_MEDIA_CD: "1",
        ID_CDROM_MEDIA_STATE: "complete",
        ID_CDROM_MEDIA_TRACK_COUNT_DATA: "1",
      }),
    })

    assertAttention(decision)
    expect(decision.reason).toBe("data_disc_deferred")
  })

  it("flags blank media rather than calling it an empty tray", () => {
    // A blank disc IS media — it just isn't a rip. Calling it
    // "no media" would mean nothing ever reports it, and
    // ejecting it is how the flap-storm starts.
    const decision = decideDiscType({
      sizeSectors: SECTORS.bluray,
      udevProperties: udev({
        ID_CDROM: "1",
        ID_CDROM_MEDIA: "1",
        ID_CDROM_MEDIA_BD_R: "1",
        ID_CDROM_MEDIA_STATE: "blank",
      }),
    })

    assertAttention(decision)
    expect(decision.reason).toBe("blank_media")
  })

  it("flags a video disc that reads as CD-sized", () => {
    // The size attribute is stale or the disc is unreadable.
    // Starting a 90 GB-shaped rip against it is not the answer.
    const decision = decideDiscType({
      sizeSectors: SECTORS.audioCd,
      udevProperties: blurayRecord,
    })

    assertAttention(decision)
    expect(decision.reason).toBe("conflicting_evidence")
  })

  it("flags a disc udev says is there and sysfs does not", () => {
    const decision = decideDiscType({
      sizeSectors: SECTORS.bluray,
      udevProperties: emptyDrive,
    })

    assertAttention(decision)
    expect(decision.reason).toBe("conflicting_evidence")
  })

  it("flags optical media of a kind we cannot rip", () => {
    const decision = decideDiscType({
      sizeSectors: SECTORS.dvd,
      udevProperties: udev({
        ID_CDROM: "1",
        ID_CDROM_MEDIA: "1",
        ID_CDROM_MEDIA_MO: "1",
        ID_CDROM_MEDIA_STATE: "complete",
      }),
    })

    assertAttention(decision)
    expect(decision.reason).toBe("unrecognised_media")
  })

  it("never invents a disc type when it is unsure", () => {
    // Putting a guess in the UI and the logs is how a wrong
    // answer becomes a remembered fact.
    const decision = decideDiscType({
      sizeSectors: SECTORS.audioCd,
      udevProperties: null,
    })

    assertAttention(decision)
    expect(decision.discType).toBe("unknown")
  })
})

describe("without udev's database", () => {
  it("keeps the proven MakeMKV path working unchanged", () => {
    // The container mounts /dev but not /run/udev, so until
    // that mount exists this is the ONLY path that runs. It has
    // to preserve exactly what Stage 3 already does.
    for (const [sectors, discType] of [
      [SECTORS.dvd, "dvd"],
      [SECTORS.bluray, "bluray"],
      [SECTORS.uhd, "uhd"],
    ] as const) {
      const decision = decideDiscType({
        sizeSectors: sectors,
        udevProperties: null,
      })

      assertRip(decision)
      expect(decision.ripper).toBe("makemkv")
      expect(decision.discType).toBe(discType)
    }
  })
})

describe("detecting from a drive", () => {
  it("reads size and udev together, per drive", () => {
    // Both reads are plain files, so nine of these run
    // concurrently with no shared scan, lock or state (E1/E2).
    const seen: string[] = []

    return expect(
      detectDiscType(
        { kernelName: "sr3" },
        {
          readSizeSectors: async (kernelName) => {
            seen.push(kernelName)
            return SECTORS.audioCd
          },
          readUdevProperties: async (kernelName) => {
            seen.push(kernelName)
            return audioCdRecord
          },
        },
      ),
    )
      .resolves.toMatchObject({
        kind: "rip",
        ripper: "cyanrip",
      })
      .then(() => {
        expect(seen).toEqual(["sr3", "sr3"])
      })
  })

  it("treats an unreadable size as an empty tray", async () => {
    // A drive that vanished mid-probe is normal here: the owner
    // powers the tower independently of the container (F3).
    await expect(
      detectDiscType(
        { kernelName: "sr3" },
        {
          readSizeSectors: async () => null,
          readUdevProperties: async () => null,
        },
      ),
    ).resolves.toEqual({ kind: "no_media" })
  })
})

function assertRip(
  decision: DiscTypeDecision,
): asserts decision is Extract<
  DiscTypeDecision,
  { kind: "rip" }
> {
  expect(decision.kind).toBe("rip")
}

function assertAttention(
  decision: DiscTypeDecision,
): asserts decision is Extract<
  DiscTypeDecision,
  { kind: "needs_attention" }
> {
  expect(decision.kind).toBe("needs_attention")
}

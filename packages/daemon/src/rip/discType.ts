import { readFile } from "node:fs/promises"
import {
  type DiscType,
  EMPTY_TRAY_SECTORS,
  inferDiscType,
} from "@rip-deck/contracts"

/**
 * Which ripper a settled disc belongs to.
 *
 * The fork the owner asked for: "CD uses cyanrip, and DVD/BD/UHD
 * BD uses MakeMKV Backup mode." Requirement A3 pins cyanrip over
 * abcde; A1 pins `backup --decrypt` for everything else.
 *
 * The hard part is not the fork, it is deciding which side of it
 * a disc is on WITHOUT guessing — because the two mistakes are
 * not symmetric. Handing a Blu-ray to cyanrip wastes a slot;
 * handing an audio CD to `makemkvcon backup` wastes a slot and
 * teaches the owner that the new tool is unreliable. So this
 * module is built to refuse rather than to guess (B3), and the
 * refusal NEVER ejects — auto-eject is the root cause of the
 * flap-storm that killed valid rips in neighbouring bays.
 *
 * ## Two sources, deliberately
 *
 * `inferDiscType` in `@rip-deck/contracts` types a disc from
 * CAPACITY alone, and that is genuinely all it can do from
 * `/sys/block/srN/size`. Capacity separates CD from DVD from BD
 * from UHD BD perfectly well — the tiers are orders of magnitude
 * apart — but it cannot separate an **audio CD** from a **data
 * CD-ROM**, because they are the same size and the same shape.
 * That distinction is the whole cyanrip fork.
 *
 * So the authoritative source for the disc *family* is udev's
 * `cdrom_id`, which issues the SCSI `GET CONFIGURATION` and
 * `READ TOC` for us and records the answer as `ID_CDROM_MEDIA_*`
 * properties. Three reasons it is the right source here:
 *
 *  1. **It already gates the settle path.** Layer 1 of
 *     `waitForSettledMedia` is a udev rule on
 *     `ENV{ID_CDROM_MEDIA}=="1"`, so by the time a disc reaches
 *     us `cdrom_id` has demonstrably run.
 *  2. **Reading it costs zero device access.** The properties
 *     are a plain file in udev's database, so this obeys the
 *     rule the whole architecture rests on: no ioctl, no SCSI
 *     command, nothing that can block in D-state for 600 s and
 *     freeze the other eight drives' monitoring.
 *  3. **`makemkvcon` cannot answer it.** MakeMKV does not handle
 *     audio CDs at all, so asking it "is this a CD?" is asking
 *     the tool that is wrong for the job whether the job is its.
 *
 * Capacity is kept as the second source, and it does two jobs:
 * it refines BD into UHD BD (`cdrom_id` reports both as plain
 * `ID_CDROM_MEDIA_BD`, because UHD is a BD-ROM), and it
 * cross-checks udev so that a stale record cannot route a 25 GB
 * disc to a CD ripper.
 *
 * ## The rule that keeps the new path safe
 *
 * **cyanrip is never chosen on capacity alone.** The MakeMKV
 * path has two real Blu-ray rips behind it; the cyanrip path has
 * zero, and nothing in this repo has ever seen an audio CD in
 * this rig. So the new branch demands POSITIVE evidence — udev
 * counting audio tracks — and a CD-sized disc with no udev
 * record goes to needs-attention instead. That is fail-closed in
 * the direction that costs an operator one click, rather than
 * fail-open in the direction that produces a wrong rip.
 */

/**
 * Which tool rips this disc.
 *
 * Deliberately not "backup" vs "flac": the mode is a property of
 * the tool, and conflating the two is what let a `mkv`-mode
 * success test fail a perfect `backup` (HANDOFF §2.3).
 */
export type RipperKind = "makemkv" | "cyanrip"

/** Largest a Red Book CD can be, rounded generously up. */
const CD_CAPACITY_CEILING_BYTES = 1024 * 1024 * 1024

/** Why a settled disc still needs a human (B3). */
export type DiscAttentionReason =
  /**
   * CD-sized, but nothing confirmed it carries audio tracks.
   *
   * Almost always means udev's database was unreadable — see
   * `readUdevRecord` for the mount this needs. Routing to
   * cyanrip anyway would be guessing on the one path with no
   * hardware evidence behind it.
   */
  | "audio_cd_unconfirmed"
  /** A data disc. ISO support is requirement A4, deferred. */
  | "data_disc_deferred"
  /** Blank, recordable media. Nothing to rip; do not eject. */
  | "blank_media"
  /** udev and sysfs disagree about what is in the drive. */
  | "conflicting_evidence"
  /** Optical media of a kind we have no ripper for. */
  | "unrecognised_media"

export type DiscTypeDecision =
  | {
      kind: "rip"
      discType: DiscType
      ripper: RipperKind
      capacityBytes: number
      /**
       * An audio CD that also carries a data session — a 1990s
       * "CD Extra" / "Enhanced CD". Not ambiguous: cyanrip rips
       * its audio tracks and ignores the data one. Surfaced so
       * the card can say the data session was left behind,
       * rather than quietly dropping it.
       */
      hasDataTracks: boolean
    }
  /** Empty tray, or media the kernel cannot see at all. */
  | { kind: "no_media" }
  | {
      kind: "needs_attention"
      reason: DiscAttentionReason
      /** What we did manage to conclude, for the card. */
      discType: DiscType
      capacityBytes: number
    }

/**
 * The `ID_CDROM_MEDIA_*` facts we act on.
 *
 * Null from `readUdevMedia` means "udev has nothing to say",
 * which is a different state from "udev says the tray is empty"
 * and must not be collapsed into it.
 */
export type UdevMedia = {
  hasMedia: boolean
  /** Recordable media with nothing written to it yet. */
  isBlank: boolean
  /** The medium's family, as `cdrom_id` reports it. */
  family: "cd" | "dvd" | "bd" | null
  audioTrackCount: number
  dataTrackCount: number
}

/**
 * Parse one record from udev's database.
 *
 * The file is `/run/udev/data/b<major>:<minor>` and is
 * line-oriented with a one-character type tag: `E:` for the
 * exported properties (which is all we want), plus `I:`, `G:`,
 * `Q:`, `V:` and `W:` for udev's own bookkeeping.
 *
 * Reading the file rather than shelling out to `udevadm info` is
 * a deliberate choice, and it is the same one `sysfs.ts` makes
 * for the same reason: a file read cannot hang, cannot fail to
 * spawn, and cannot inherit a wedged drive's SCSI timeout. Nine
 * of these may be in flight at once.
 */
export const parseUdevDatabaseRecord = (
  raw: string,
): Map<string, string> => {
  const properties = new Map<string, string>()

  for (const line of raw.split("\n")) {
    if (!line.startsWith("E:")) continue

    const body = line.slice(2)
    const separator = body.indexOf("=")
    if (separator === -1) continue

    // Split on the FIRST `=` only. Values legitimately contain
    // more of them (`ID_PATH_TAG`, `ID_SERIAL` on some
    // enclosures), and splitting on all of them silently
    // truncates the value rather than failing.
    properties.set(
      body.slice(0, separator),
      body.slice(separator + 1),
    )
  }

  return properties
}

/**
 * Reduce udev's properties to the media facts.
 *
 * Returns null when the record is not an optical device's —
 * `cdrom_id` sets `ID_CDROM=1` on every drive it processes, so
 * its absence means either the record belongs to something else
 * or `cdrom_id` has never run. Either way we have no evidence,
 * which is not the same as evidence of an empty tray.
 *
 * ⚠️ **The `ID_CDROM_*` properties without `MEDIA` describe the
 * DRIVE, not the disc.** Every unit in this tower is a Blu-ray
 * writer, so all nine permanently report `ID_CDROM_BD=1`,
 * `ID_CDROM_DVD=1` and `ID_CDROM_CD=1` no matter what is
 * inserted — or whether anything is. Matching those would type
 * every disc in the rack as a UHD BD. Only `ID_CDROM_MEDIA_*` is
 * about the medium.
 */
export const readUdevMedia = (
  properties: ReadonlyMap<string, string>,
): UdevMedia | null => {
  if (properties.get("ID_CDROM") !== "1") return null

  return {
    hasMedia: properties.get("ID_CDROM_MEDIA") === "1",
    // `ID_CDROM_MEDIA_STATE` is "blank", "appendable" or
    // "complete". Only "blank" means there is nothing on it.
    isBlank:
      properties.get("ID_CDROM_MEDIA_STATE") === "blank",
    family: readMediaFamily(properties),
    audioTrackCount: readCount(
      properties,
      "ID_CDROM_MEDIA_TRACK_COUNT_AUDIO",
    ),
    dataTrackCount: readCount(
      properties,
      "ID_CDROM_MEDIA_TRACK_COUNT_DATA",
    ),
  }
}

/**
 * Which family the medium belongs to.
 *
 * `cdrom_id` emits one flag per profile it matched — `_BD`,
 * `_BD_R`, `_BD_RE`, `_DVD`, `_DVD_R`, `_DVD_PLUS_R_DL`, `_CD`,
 * `_CD_R`, `_CD_RW` and so on — so this scans for any member of
 * a family rather than enumerating every profile udev has ever
 * shipped. The suffix boundary matters: `ID_CDROM_MEDIA_CD` and
 * `ID_CDROM_MEDIA_CD_RW` are both CD, while
 * `ID_CDROM_MEDIA_TRACK_COUNT_*` and `ID_CDROM_MEDIA_STATE` are
 * neither and must not match anything.
 *
 * Ordered widest-medium-first because a BD profile is never
 * accompanied by a DVD or CD one, so the first match is the
 * answer, and this ordering fails safe if a future `cdrom_id`
 * ever emits both.
 */
const readMediaFamily = (
  properties: ReadonlyMap<string, string>,
): UdevMedia["family"] => {
  const families = [
    ["bd", /^ID_CDROM_MEDIA_BD(_|$)/],
    ["dvd", /^ID_CDROM_MEDIA_DVD(_|$)/],
    ["cd", /^ID_CDROM_MEDIA_CD(_|$)/],
  ] as const

  for (const [family, pattern] of families) {
    for (const [key, value] of properties) {
      if (value === "1" && pattern.test(key)) return family
    }
  }

  return null
}

const readCount = (
  properties: ReadonlyMap<string, string>,
  key: string,
): number => {
  const parsed = Number.parseInt(
    properties.get(key) ?? "",
    10,
  )
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * The fork, as a pure function.
 *
 * Pure because every interesting case here is one we cannot
 * reproduce on demand — a blank disc, a CD Extra, a stale udev
 * record — and the tower is off. Keeping the decision separate
 * from the two file reads is what makes those cases testable at
 * all.
 *
 * `udevProperties` must be read FRESH for this drive. A record
 * left over from the previous disc is exactly the input the
 * conflict checks below exist to catch, but they can only catch
 * the gross cases.
 */
export const decideDiscType = (input: {
  /** `/sys/block/srN/size`, in 512-byte sectors. */
  sizeSectors: number
  /** Null when udev's database was unreadable. */
  udevProperties: ReadonlyMap<string, string> | null
}): DiscTypeDecision => {
  const capacityBytes = Math.max(input.sizeSectors, 0) * 512

  // The 1 GiB sentinel. The kernel reports 2097151 sectors for
  // an empty or unreadable tray, and it is STABLE — so it sails
  // through the settle check looking exactly like a real disc,
  // and `inferDiscType` would call it a CD because
  // 2097151 * 512 = 1,073,741,312 bytes, a hair under 1 GiB.
  //
  // Nothing is lost by treating it as empty unconditionally:
  // 1.07 GB is larger than any Red Book CD can be (99 minutes
  // caps out near 900 MB), so no real audio disc can collide
  // with the sentinel.
  const isEmptyTray =
    input.sizeSectors === EMPTY_TRAY_SECTORS

  const media =
    input.udevProperties === null
      ? null
      : readUdevMedia(input.udevProperties)

  if (media === null) {
    return decideFromCapacityAlone({
      sizeSectors: input.sizeSectors,
      capacityBytes,
      isEmptyTray,
    })
  }

  if (!media.hasMedia) {
    // udev says empty. If sysfs also says empty they agree and
    // there is simply no disc. If sysfs is showing a real
    // capacity, one of them is stale — and quietly believing
    // "empty" would leave a real disc sitting in the bay with
    // nothing reported, which is the silent version of the
    // failure B3 exists to prevent.
    return isEmptyTray || input.sizeSectors <= 0
      ? { kind: "no_media" }
      : attention("conflicting_evidence", capacityBytes)
  }

  if (isEmptyTray) {
    return attention("conflicting_evidence", capacityBytes)
  }

  if (media.isBlank) {
    // A blank disc is media — it just isn't a rip. It stays in
    // the drive and gets flagged, because ejecting it is how
    // the flap-storm starts.
    return attention("blank_media", capacityBytes)
  }

  if (media.audioTrackCount > 0) {
    // The only route to cyanrip, and it needs udev to have
    // counted actual audio tracks.
    //
    // The capacity guard is the backstop against a stale record:
    // a disc with audio tracks cannot be bigger than a CD, so a
    // multi-gigabyte "audio disc" means udev is describing a
    // disc that is no longer in the tray. Routing that to a CD
    // ripper would be the worst outcome available here.
    if (capacityBytes >= CD_CAPACITY_CEILING_BYTES) {
      return attention(
        "conflicting_evidence",
        capacityBytes,
      )
    }

    return {
      kind: "rip",
      discType: "cd",
      ripper: "cyanrip",
      capacityBytes,
      hasDataTracks: media.dataTrackCount > 0,
    }
  }

  if (media.family === "cd") {
    // CD-sized, no audio tracks: a data CD-ROM. Requirement A4
    // (data disc -> ISO) is explicitly deferred, so there is no
    // ripper for this and pretending otherwise would produce
    // either a silent no-op or a garbage rip.
    return attention("data_disc_deferred", capacityBytes)
  }

  if (media.family === "dvd" || media.family === "bd") {
    // The proven path. `inferDiscType` supplies the tier — and
    // in particular the BD -> UHD refinement, which udev cannot
    // make because a UHD disc IS a BD-ROM and `cdrom_id`
    // reports it as one. The >= ~55 GB threshold is B2's, and
    // it also names the folder.
    const discType = inferDiscType(input.sizeSectors)

    // Capacity has to agree that this is video-disc sized. A
    // DVD or BD reading as CD-sized means the size attribute is
    // stale or the disc is unreadable; either way, starting a
    // 90 GB-shaped rip against it is not the answer.
    if (discType === "none" || discType === "cd") {
      return attention(
        "conflicting_evidence",
        capacityBytes,
      )
    }

    return {
      kind: "rip",
      discType,
      ripper: "makemkv",
      capacityBytes,
      hasDataTracks: media.dataTrackCount > 0,
    }
  }

  // Optical media of some other profile — magneto-optical, or a
  // format `cdrom_id` learns about after this was written.
  return attention("unrecognised_media", capacityBytes)
}

/**
 * The fallback when udev's database is unreadable.
 *
 * This is not hypothetical: the container mounts `/dev` but not
 * `/run/udev` (see the Dockerfile), so until that mount exists
 * this is the ONLY path that runs. It therefore has to preserve
 * exactly what Stage 3 already does — capacity-typed DVD/BD/UHD
 * straight to `makemkvcon backup` — while refusing to extend
 * that same guesswork to the branch that has never been tried.
 */
const decideFromCapacityAlone = (input: {
  sizeSectors: number
  capacityBytes: number
  isEmptyTray: boolean
}): DiscTypeDecision => {
  const discType = inferDiscType(input.sizeSectors)

  if (discType === "none" || input.isEmptyTray) {
    return { kind: "no_media" }
  }

  if (discType === "cd") {
    // Capacity cannot tell an album from a driver CD, and
    // guessing "album" would hand a data disc to a tool that
    // rips audio tracks it does not have. One click from the
    // owner beats a wrong rip.
    return attention(
      "audio_cd_unconfirmed",
      input.capacityBytes,
    )
  }

  return {
    kind: "rip",
    discType,
    ripper: "makemkv",
    capacityBytes: input.capacityBytes,
    hasDataTracks: false,
  }
}

const attention = (
  reason: DiscAttentionReason,
  capacityBytes: number,
): DiscTypeDecision => ({
  kind: "needs_attention",
  reason,
  // The type is reported as unknown rather than invented: we
  // know something is in the drive and we do not know what, and
  // saying "cd" here would put a guess in the UI and the logs.
  discType: "unknown",
  capacityBytes,
})

export type DiscTypeDeps = {
  readSizeSectors: (
    kernelName: string,
  ) => Promise<number | null>
  readUdevProperties: (
    kernelName: string,
  ) => Promise<ReadonlyMap<string, string> | null>
}

const defaultDeps: DiscTypeDeps = {
  readSizeSectors: (kernelName) =>
    readIntFile(`/sys/block/${kernelName}/size`),
  // Wrapped rather than referenced directly: `defaultDeps` is
  // evaluated at module load and `readUdevRecord` is declared
  // below it, so a bare reference is a temporal-dead-zone
  // ReferenceError at import time — which fails the whole
  // module, not just this path.
  readUdevProperties: (kernelName) =>
    readUdevRecord(kernelName),
}

/**
 * Type the disc in one drive.
 *
 * Both reads are plain files, so this never blocks on the
 * device and nine of them may run concurrently without any
 * shared state, lock or scan between them (E1/E2).
 */
export const detectDiscType = async (
  input: { kernelName: string },
  deps: DiscTypeDeps = defaultDeps,
): Promise<DiscTypeDecision> => {
  const [sizeSectors, udevProperties] = await Promise.all([
    deps.readSizeSectors(input.kernelName),
    deps.readUdevProperties(input.kernelName),
  ])

  return decideDiscType({
    sizeSectors: sizeSectors ?? 0,
    udevProperties,
  })
}

/**
 * Read a drive's udev record.
 *
 * ⚠️ **This needs `/run/udev` inside the container**, which the
 * image does not currently mount — it mounts `/dev` only. Until
 * it does, this returns null on every drive and every disc falls
 * back to capacity-only typing, which means no audio CD is ever
 * routed to cyanrip. Failing that way round is intentional, but
 * it is a silent degradation, so the mount is a requirement and
 * not a nicety.
 *
 * The device numbers come from `/sys/block/srN/dev` rather than
 * from the digits in the kernel name. Those two agree today and
 * are not the same thing — `srN` is a name, `11:N` is an
 * address — and this file already lives in a codebase where
 * three different numberings for the same drive disagree.
 */
const readUdevRecord = async (
  kernelName: string,
): Promise<ReadonlyMap<string, string> | null> => {
  const devNumbers = await readTextFile(
    `/sys/block/${kernelName}/dev`,
  )
  if (devNumbers === null) return null

  const raw = await readTextFile(
    `/run/udev/data/b${devNumbers}`,
  )
  if (raw === null) return null

  return parseUdevDatabaseRecord(raw)
}

const readTextFile = async (
  path: string,
): Promise<string | null> => {
  try {
    return (await readFile(path, "utf8")).trim()
  } catch {
    return null
  }
}

const readIntFile = async (
  path: string,
): Promise<number | null> => {
  const raw = await readTextFile(path)
  if (raw === null) return null

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

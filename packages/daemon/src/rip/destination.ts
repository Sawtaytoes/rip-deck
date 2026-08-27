import {
  chown,
  lchown,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises"
import { join } from "node:path"
import {
  type DiscType,
  discTypeLabel,
} from "@rip-deck/contracts"

/**
 * Where a rip is written, and how it gets its final name.
 *
 * The central rule (A6/A7): a backup is a MOVE, not a copy. So
 * makemkvcon writes straight into a hidden directory ON THE
 * DESTINATION DATASET and we `rename()` it into place when it
 * succeeds. That rename is atomic and costs zero bytes.
 *
 * The alternative — stage somewhere else, copy on success — is
 * wrong twice over here. ZFS dedup is OFF on this pool, so a
 * copy silently doubles the space a 90 GB UHD rip occupies; and
 * staging inside a container's overlay is abcde's old wart,
 * where a mid-rip kill left zero output because the work
 * directory died with the container.
 *
 * The `.`-prefixed, UUID-suffixed name does three jobs: it hides
 * partial output from anything scanning the library, it makes an
 * abandoned rip's leftovers obvious and safe to delete, and the
 * UUID is what lets orphan adoption pin a running process to
 * exactly one job after a daemon restart.
 */

/** Headroom over the disc size required before starting. */
export const SPACE_HEADROOM_FRACTION = 1.1

/**
 * What a DVD backup gets called once it lands.
 *
 * `makemkvcon` writes a DVD image with NO extension at all, so
 * without this the library gains an 8 GB file named
 * `[BACKUP] Some Film (1987) - DVD` that Windows offers to open
 * with a text editor. A Blu-ray backup is a directory and takes
 * no suffix.
 */
export const ISO_SUFFIX = ".iso"

export const incompleteDirName = (
  jobUuid: string,
): string => `.rip-deck-incomplete-${jobUuid}`

/**
 * Marks a folder as a WHOLE-DISC BACKUP, not a finished rip.
 *
 * The two things live side by side in one dataset — 723 of ARM's
 * finished rips and, now, ours — and they want completely
 * different treatment. A backup is a full disc structure that
 * still has to be opened in MakeMKV and have its real titles
 * pulled out; a finished rip is done. Telling them apart by
 * looking inside is exactly the manual work this prefix removes.
 *
 * Leading, and bracketed, on purpose: it sorts the backlog
 * together at the top of an alphabetical listing, and `[` is
 * legal on both POSIX and Windows/SMB so it survives
 * `sanitiseFolderName` untouched.
 */
export const BACKUP_FOLDER_PREFIX = "[BACKUP] "

/**
 * Folder name per requirement B2: `{title} ({year}) - {type}`,
 * optionally prefixed `[BACKUP] ` when the folder holds a whole
 * disc awaiting title extraction.
 *
 * A disc with no confident identification does NOT get a
 * made-up name — it keeps its volume label and is flagged for a
 * human. Inventing "Unknown (2026)" would quietly bury the one
 * fact that makes the disc findable again.
 */
export const buildFolderName = (input: {
  title: string
  year: number | null
  discType: DiscType
  /**
   * True for a `makemkvcon backup` disc structure — which is
   * every video rip rip-deck performs, since A2 forbids
   * transcoding and backup-only is the default, not an override.
   *
   * False for an audio CD: cyanrip emits a finished, tagged FLAC
   * album with nothing left to extract, so marking it as pending
   * post-processing would be a lie.
   */
  isDiscBackup: boolean
}): string => {
  const label = discTypeLabel(input.discType)
  const year = input.year === null ? "" : ` (${input.year})`
  const suffix = label === null ? "" : ` - ${label}`

  const prefix = input.isDiscBackup
    ? BACKUP_FOLDER_PREFIX
    : ""

  // Sanitise the BODY, then prefix — so the marker can never be
  // mangled by a hostile title, and is never the part that the
  // length cap truncates.
  return (
    prefix +
    sanitiseFolderName(
      `${input.title}${year}${suffix}`,
      MAX_FOLDER_NAME_LENGTH - prefix.length,
    )
  )
}

/** Windows' path budget is the binding constraint, not ZFS's. */
const MAX_FOLDER_NAME_LENGTH = 200

/**
 * Strip what a filesystem or an SMB client would choke on.
 *
 * The library is served over SMB to Windows, so this is the
 * Windows-illegal set rather than the (much smaller) POSIX one —
 * a folder Linux accepts but Windows cannot open is a folder the
 * owner cannot reach.
 */
export const sanitiseFolderName = (
  name: string,
  maxLength: number = MAX_FOLDER_NAME_LENGTH,
): string =>
  name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // Windows silently drops a trailing dot or space, which turns
    // "Movie Vol. 2." into a name that never matches on lookup.
    .replace(/[. ]+$/, "")
    .slice(0, maxLength)
    // The slice can re-expose a trailing dot or space, so strip
    // again AFTER the cut, not only before it.
    .replace(/[. ]+$/, "")

export type SpaceCheck = {
  hasEnoughSpace: boolean
  freeBytes: number
  requiredBytes: number
}

/**
 * Preflight the destination's free space.
 *
 * Running out of room mid-rip wastes the whole read and leaves
 * partial output behind, and it is entirely predictable — the
 * disc's size is known before we start.
 */
export const checkFreeSpace = async (input: {
  rootPath: string
  discBytes: number
}): Promise<SpaceCheck> => {
  const stats = await statfs(input.rootPath)
  const freeBytes = stats.bsize * stats.bavail
  const requiredBytes = Math.ceil(
    input.discBytes * SPACE_HEADROOM_FRACTION,
  )

  return {
    hasEnoughSpace: freeBytes >= requiredBytes,
    freeBytes,
    requiredBytes,
  }
}

export type PreparedDestination = {
  /** Where WE create, rename and delete. Our own filesystem view. */
  incompletePath: string
  /**
   * The same directory as `makemkvcon` must be told to address it.
   *
   * Identical to `incompletePath` unless makemkvcon is running
   * somewhere with a different filesystem view. Measured on
   * Tower 2026-07-25: the destination dataset is
   * `/media/Disc-Rips` to us and `/home/arm/media`
   * inside the `arm` container, so handing our path to a
   * container-side makemkvcon addresses a directory that does
   * not exist there. The rename stays ours; only the argument
   * changes.
   */
  incompleteInnerPath: string
  /** Where it lands on success. */
  finalPath: string
  jobUuid: string
}

/**
 * Name the incomplete directory. **Do NOT create it.**
 *
 * ⚠️ `makemkvcon backup` REFUSES a destination that already
 * exists, even an empty one it would have been happy to create
 * itself:
 *
 *     MSG:5072 "Backing up disc into folder file:///…/.rip-deck-incomplete-…"
 *     MSG:5068 "Folder /…/.rip-deck-incomplete-… already contains
 *               a backup, please choose another folder"
 *     MSG:5069 "Backup failed"
 *
 * and then exits **0** having written nothing, so the only
 * symptom upstream is an `empty_output` summary that names no
 * cause. Four TMNT DVDs failed exactly that way on 2026-08-26.
 *
 * Proven by A/B on the live tower that day, same disc, same
 * drive, one isolated container each — the only difference being
 * whether the directory was there first:
 *
 *   - destination pre-created (empty) -> MSG:5068, backup failed
 *   - destination absent              -> backup runs, PRGV climbs
 *
 * "Already contains a backup" is a misleading message: the
 * directory was empty. MakeMKV means "this path is taken".
 *
 * So the leaf is a NAME here and nothing else. `makemkvcon`
 * creates it, and `finaliseDestination` renames it afterwards.
 * The root is not created either — `checkFreeSpace` has already
 * `statfs`'d it, so a missing destination root has failed the
 * job long before this point.
 *
 * ⚠️ This is the makemkv/`backup` path ONLY. cyanrip is the
 * opposite: it is spawned with the incomplete directory as its
 * `cwd`, so that one MUST exist before the spawn, and
 * `ripAudioCd` in `watcher.ts` creates its own. Do not
 * "consolidate" the two — they disagree on purpose.
 */
export const prepareDestination = (input: {
  rootPath: string
  folderName: string
  jobUuid: string
  /**
   * The destination root as makemkvcon sees it. Omit when both
   * sides share a filesystem view, which is the normal case and
   * the one Stage 6 should aim for.
   */
  innerRootPath?: string
}): PreparedDestination => {
  const dirName = incompleteDirName(input.jobUuid)
  const incompletePath = join(input.rootPath, dirName)

  return {
    incompletePath,
    incompleteInnerPath: join(
      input.innerRootPath ?? input.rootPath,
      dirName,
    ),
    finalPath: join(input.rootPath, input.folderName),
    jobUuid: input.jobUuid,
  }
}

// Deliberately not exported: `mqtt/config.ts` already exports a
// type of this name and `index.ts` re-exports both surfaces, so
// a second public `EnvLike` is an ambiguous barrel export.
type EnvLike = Record<string, string | undefined>

export type OutputOwnership = {
  uid: number
  gid: number
}

/**
 * Who a finished rip must belong to (§2.7).
 *
 * `rip-deck` runs as root, so without this the output lands
 * `root:root` and Plex — which runs as the TrueNAS `apps`
 * account — cannot read a single byte of it. That is not
 * hypothetical: the Ivanhoe rip landed unreadable and was fixed
 * by hand with `chown -R apps:apps`.
 *
 * The numbers are not guessed. Measured read-only on Tower
 * 2026-07-26 by counting the existing library:
 *
 *   find /media/Disc-Rips -maxdepth 1 -mindepth 1 \
 *     -type d -printf '%U:%G\n' | sort | uniq -c | sort -rn
 *     591 568:568
 *     131 568:0
 *       1 1000:1001
 *       1 1000:1000
 *
 * So every rip ARM ever made is uid 568, and the overwhelming
 * majority is gid 568 too — TrueNAS SCALE's `apps:apps`. The
 * 568:0 minority is ARM's own root-gid wart, i.e. the same class
 * of bug this fixes, so it is not the pattern to copy. (`getent
 * passwd 568` returns nothing inside the container, which is
 * exactly why the numeric ids are the durable form here.)
 */
export const DEFAULT_OUTPUT_UID = 568
export const DEFAULT_OUTPUT_GID = 568

/**
 * `null` means "leave ownership alone" — a supported state, for
 * running somewhere that is not this pool or is not root.
 */
export const createOutputOwnership = (
  env: EnvLike = process.env,
): OutputOwnership | null => {
  if (env.RIP_DECK_OUTPUT_CHOWN === "false") return null

  return {
    uid:
      parseId(env.RIP_DECK_OUTPUT_UID) ??
      DEFAULT_OUTPUT_UID,
    gid:
      parseId(env.RIP_DECK_OUTPUT_GID) ??
      DEFAULT_OUTPUT_GID,
  }
}

const parseId = (
  raw: string | undefined,
): number | null => {
  if (raw === undefined || raw.trim() === "") return null

  const parsed = Number.parseInt(raw, 10)

  // A typo'd id must not silently become 0 (= root), which is the
  // precise failure this whole function exists to prevent.
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : null
}

/**
 * Hand the whole tree to the library's owner.
 *
 * `chown` only, and deliberately no `chmod`: measured on the
 * Bunnies pool, `chmod` FAILS outright because the dataset is
 * NFSv4-ACL, and it is also unnecessary — the inherited ACL
 * supplies the mode. Adding one "for safety" would turn every
 * successful rip into a thrown error.
 *
 * Symlink-safe in both directions, which costs nothing and rules
 * out a whole class of surprise: the walk uses `readdir`'s own
 * entry types, so a link cannot lead the recursion out of the
 * rip's tree, and children are `lchown`ed, so a link's TARGET
 * outside the tree is never rechowned either.
 */
export const applyOutputOwnership = async (input: {
  path: string
  ownership: OutputOwnership
}): Promise<void> => {
  const { uid, gid } = input.ownership

  await chown(input.path, uid, gid)

  // ⚠️ A DVD backup is a single ISO FILE, not a directory — see
  // `verifyBackup.ts`. `readdir` on one throws ENOTDIR, and that
  // throw reached `failureOfChown`, which reported every DVD as
  // landing with the wrong owner while the chown above had in
  // fact already succeeded.
  if (!(await stat(input.path)).isDirectory()) return

  const entries = await readdir(input.path, {
    withFileTypes: true,
  })

  for (const entry of entries) {
    const childPath = join(input.path, entry.name)

    if (entry.isDirectory()) {
      await applyOutputOwnership({
        path: childPath,
        ownership: input.ownership,
      })
      continue
    }

    await lchown(childPath, uid, gid)
  }
}

export type FinalisedDestination = {
  path: string
  /**
   * True when the intended name was already taken, so the rip
   * landed beside it under a marked name instead.
   */
  hasCollision: boolean
  /**
   * Why the rip landed with the wrong owner, or `null` when it
   * did not — which includes ownership being switched off.
   *
   * A field rather than a throw. See `finaliseDestination`.
   */
  ownershipError: string | null
}

/**
 * Move a finished rip into place.
 *
 * Two refusals worth stating out loud:
 *
 *  - We never clobber an existing folder. A name collision is
 *    usually a re-rip of something already in the library, and
 *    overwriting the good copy with a fresh one that might be
 *    worse is unrecoverable. The new rip lands beside it under a
 *    marked name and the job goes to needs-attention, so a human
 *    decides which one to keep.
 *  - An `EXDEV` rename is a hard error, not a fallback to copy.
 *    It means the incomplete directory was not on the
 *    destination dataset after all, and silently copying would
 *    double the space used — which is precisely the failure this
 *    whole design exists to prevent (A6).
 *
 * Ownership (§2.7) is fixed BEFORE the rename, not after, so the
 * library never contains — even for an instant — a folder a
 * scanner can see but not read. A failing chown is reported
 * rather than thrown: by this point the disc has been read
 * correctly and the bytes are on the pool, and refusing to
 * publish good data over a metadata problem would strand it in a
 * dot-directory nobody looks in. Wrong ownership is one manual
 * `chown -R` away from fixed; a rip nobody can find is not.
 */
export const finaliseDestination = async (
  prepared: PreparedDestination,
  ownership: OutputOwnership | null = createOutputOwnership(),
): Promise<FinalisedDestination> => {
  // ⚠️ A DVD backup is a single ISO FILE and a Blu-ray backup is
  // a directory (see `verifyBackup.ts`), and only the filesystem
  // says which one this rip produced — `makemkvcon` never does.
  // A disc image published with no extension is one the owner
  // cannot open by double-clicking and no scanner recognises, so
  // the suffix is decided here, from what is actually on disk,
  // rather than inferred from the disc type upstream.
  const suffix = (await isFile(prepared.incompletePath))
    ? ISO_SUFFIX
    : ""

  const finalPath = `${prepared.finalPath}${suffix}`
  const hasCollision = await pathExists(finalPath)

  // The marker goes BEFORE the extension, not after it: a file
  // called `… .iso (rip-deck-duplicate-01234567)` is not an ISO
  // to anything that reads extensions, which is the one property
  // the collision copy has to keep.
  const path = hasCollision
    ? `${prepared.finalPath} ` +
      `(rip-deck-duplicate-${prepared.jobUuid.slice(0, 8)})` +
      suffix
    : finalPath

  const ownershipFailure =
    ownership === null
      ? null
      : await failureOfChown({
          path: prepared.incompletePath,
          ownership,
        })

  try {
    await rename(prepared.incompletePath, path)
  } catch (error) {
    if (isExdev(error)) {
      throw new Error(
        `Refusing to finish this rip by copying. ` +
          `${prepared.incompletePath} and ${path} are on ` +
          `different filesystems, so the atomic rename failed. ` +
          `The incomplete directory MUST live on the ` +
          `destination dataset — copying would silently double ` +
          `the space this rip uses, because ZFS dedup is off.`,
        { cause: error },
      )
    }

    throw error
  }

  return {
    path,
    hasCollision,
    // Named for where the rip ACTUALLY is, not for the hidden
    // directory it was in when the chown failed — the whole
    // point of the message is that a human can paste it.
    ownershipError:
      ownership === null || ownershipFailure === null
        ? null
        : `This rip landed with the wrong owner: could not ` +
          `chown it to ${ownership.uid}:${ownership.gid}, so ` +
          `Plex and anything else running as that account ` +
          `cannot read it. Fix with ` +
          `\`chown -R ${ownership.uid}:${ownership.gid} ` +
          `"${path}"\` — NOT chmod, which fails on this ` +
          `NFSv4-ACL pool. (${ownershipFailure})`,
  }
}

/** The reason the chown failed, or `null` when it did not. */
const failureOfChown = async (input: {
  path: string
  ownership: OutputOwnership
}): Promise<string | null> => {
  try {
    await applyOutputOwnership(input)
    return null
  } catch (error) {
    return error instanceof Error
      ? error.message
      : String(error)
  }
}

/** Delete the partial output of a rip that will not be kept. */
export const discardDestination = async (
  prepared: PreparedDestination,
): Promise<void> => {
  await rm(prepared.incompletePath, {
    recursive: true,
    force: true,
  })
}

/**
 * Does this path exist?
 *
 * Exported because a FAILED rip now has to ask it about its own
 * incomplete directory. `makemkvcon` creates that directory
 * itself (see `prepareDestination`), so a rip that died before
 * the backup started leaves nothing behind — and reporting
 * "Partial output KEPT at …" for a path that is not there sends
 * a reader to look for a directory that never existed.
 */
export const pathExists = async (
  path: string,
): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Is this path a regular file — i.e. a DVD image? */
const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

const isExdev = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "EXDEV"

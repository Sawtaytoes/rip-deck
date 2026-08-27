import {
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { basename, join, resolve, sep } from "node:path"
import {
  ISO_SUFFIX,
  incompleteDirName,
  pathExists,
} from "./destination.ts"
import type { LiveRips } from "./liveRips.ts"

/**
 * The folders a rip leaves behind when it does not land cleanly,
 * and the one control that clears them.
 *
 * Two kinds live in the destination dataset alongside 700-odd
 * finished rips, and until now nothing in Rip Deck could see or
 * remove either. The owner had to be told to delete them by hand:
 * *"Clear the messed up folders, in fact, add a control inside
 * Rip Deck to clear it… It'd be even better if we had some way to
 * know if the previous rip was complete or incomplete."*
 *
 *  - **`.rip-deck-incomplete-<uuid>`** — where `makemkvcon` writes
 *    while a rip runs. A rip that SUCCEEDS renames this into
 *    place, so one still sitting here is a rip that did not
 *    finish. That is not an inference: the rename is the last
 *    step, and it is atomic
 *    (`finaliseDestination`).
 *  - **`<name> (rip-deck-duplicate-xxxxxxxx)`** — a rip that DID
 *    finish, into a name something already occupied.
 *    `finaliseDestination` never clobbers, so the new copy lands
 *    beside the old one and a human decides which to keep. That
 *    decision has never had a button.
 *
 * ## Complete or incomplete is knowable, and mostly for free
 *
 * The folder's own NAME answers it — an `.rip-deck-incomplete-`
 * prefix means the rename never happened. What the name cannot
 * say is how far it got, so `describeLeftover` adds the two facts
 * that decide whether it is worth keeping: whether the disc
 * structure (`VIDEO_TS` / `BDMV`) is there at all, and how many
 * bytes landed.
 *
 * ⚠️ **An empty incomplete folder is the MSG:5068 signature.**
 * Four of them appeared on 2026-08-26 when `makemkvcon` refused a
 * destination Rip Deck had pre-created, exited 0 and wrote
 * nothing. That is fixed, but the shape is worth naming when it
 * recurs, because "0 bytes" and "half a disc" want opposite
 * decisions.
 *
 * ## ⚠️ A RUNNING rip lives in one of these folders too
 *
 * `.rip-deck-incomplete-<uuid>` is not only where a rip that
 * failed is left. It is where a rip that is HAPPENING writes,
 * from `prepareDestination` until the atomic rename at the end,
 * and on a nine-drive tower there can be nine of them filling up
 * at once. Everything above says "a rip that did not finish",
 * and that sentence is true of a rip that has not finished YET.
 *
 * The name cannot tell the two apart, and neither can the bytes:
 * a 40 GB half-written UHD rip looks the same whether the process
 * writing it died an hour ago or is writing it right now. Only
 * the LIVE JOB SET can tell, so every rule here takes a
 * `LiveRips` (`liveRips.ts`) and refuses on it — for both verbs,
 * and shown in the panel as a locked row rather than discovered
 * by pressing a button. `reaper.ts` has guarded exactly this
 * since it was written; this file did not, which meant the
 * operator's Delete button could do what the reaper refuses to
 * ([decision](../../../../docs/decisions/2026-08-27-a-leftover-control-refuses-a-live-rip.md)).
 */

/** How `finaliseDestination` marks a collision landing. */
export const DUPLICATE_MARKER = "(rip-deck-duplicate-"

/**
 * What a folder in the destination root is, by name alone.
 *
 * Pure, and name-only on purpose: it runs against every entry in
 * a directory holding 700+ finished rips, and a `stat` per entry
 * to answer "is this even ours" would be a tree walk of the whole
 * library. Null means "a normal rip, or something that is not
 * ours" — both of which this must leave alone.
 */
export type LeftoverKind =
  /** A rip that never finished. The rename never happened. */
  | { kind: "incomplete"; jobUuid: string }
  /** A finished rip that landed beside a name already taken. */
  | { kind: "duplicate"; occupiedName: string }

export const classifyLeftover = (
  name: string,
): LeftoverKind | null => {
  const incompletePrefix = incompleteDirName("")

  if (name.startsWith(incompletePrefix)) {
    const jobUuid = name.slice(incompletePrefix.length)

    // A bare `.rip-deck-incomplete-` with no uuid is not one of
    // ours — every folder this code creates is named from a
    // `randomUUID()`. Refusing it keeps the delete endpoint's
    // validation honest rather than merely prefix-based.
    return jobUuid === ""
      ? null
      : { kind: "incomplete", jobUuid }
  }

  const duplicate = DUPLICATE_PATTERN.exec(name)

  return duplicate === null
    ? null
    : {
        kind: "duplicate",
        // The `.iso` belongs to the name it COLLIDED with, not
        // to the marker — `finaliseDestination` puts the marker
        // before the extension, so the occupied file is
        // `<title>.iso` and not `<title>`.
        occupiedName: `${duplicate[1]}${duplicate[2] ?? ""}`,
      }
}

/**
 * A duplicate landing's name, with an OPTIONAL `.iso` after the
 * closing bracket.
 *
 * ⚠️ **The suffix is why this is a pattern and not `endsWith(")")`.**
 * A DVD backup is a single ISO FILE, and `finaliseDestination`
 * publishes a collided one as
 * `<title> (rip-deck-duplicate-01234567).iso` — the marker goes
 * BEFORE the extension, on purpose, so the copy stays an ISO to
 * anything that reads extensions
 * ([decision](../../../../docs/decisions/2026-08-26-a-dvd-backup-is-one-iso-file-not-a-directory.md)).
 * The first version of `classifyLeftover` tested `endsWith(")")`,
 * which is true of every Blu-ray duplicate and false of every DVD
 * one — so the panel that exists to resolve collisions could not
 * see the DVD collisions at all. The owner has one on the shelf
 * right now: two Ninja Turtles discs carry the same UDF volume
 * label, so the second landed marked, and it is an `.iso`.
 *
 * Built from `DUPLICATE_MARKER` rather than spelled twice, so the
 * marker has exactly one definition. `[^)]+` for the uuid because
 * the slice is 8 hex characters today and the pattern should not
 * be the thing that breaks if that ever changes.
 */
const DUPLICATE_PATTERN = new RegExp(
  `^(.+) ${DUPLICATE_MARKER.replace("(", "\\(")}[^)]+\\)` +
    `(\\${ISO_SUFFIX})?$`,
)

export type Leftover = {
  /** Absolute path, for the delete command to name back. */
  path: string
  /** The folder name, which is what the operator recognises. */
  name: string
  kind: LeftoverKind["kind"]
  /**
   * For a duplicate, the folder it collided with. Null for an
   * incomplete one, which collided with nothing.
   */
  occupiedName: string | null
  sizeBytes: number
  /** `VIDEO_TS` or `BDMV`, or null when neither is there. */
  discStructure: string | null
  modifiedAtMs: number
  /** One sentence for the card. See `describeLeftover`. */
  detail: string
  /** Whether deleting this can lose a finished rip. */
  isSafeToDelete: boolean
  /**
   * Neither verb may touch this one, and the panel says so.
   *
   * True when a rip is writing into it right now, and true when
   * Rip Deck cannot rule that out. Separate from
   * `isSafeToDelete`, which is a JUDGEMENT the operator may
   * overrule — a duplicate is "not safe" and he deletes one on
   * purpose. This is a REFUSAL: the API answers 400 either way,
   * so the button is disabled rather than armed with a trap
   * behind it.
   */
  isLocked: boolean
  /** Why it is locked, for the panel. Null when it is not. */
  lockReason: string | null
}

/**
 * Say what this folder is, in one sentence an operator can act on.
 *
 * Pure, because every interesting case is one that is tedious to
 * reproduce — a rip killed mid-disc, a `MSG:5068` no-op, a
 * collision against a rip from 2024.
 *
 * `isSafeToDelete` is deliberately conservative. It is true only
 * for an incomplete folder with no disc structure in it: that
 * cannot be a finished rip, because a finished rip would have
 * been renamed and would carry `VIDEO_TS`/`BDMV`. Everything else
 * is offered for deletion but not blessed, and the card says why.
 */
export const describeLeftover = (input: {
  kind: LeftoverKind["kind"]
  occupiedName: string | null
  sizeBytes: number
  discStructure: string | null
  /** `refusalForLiveRip`'s answer, or null when it allowed. */
  lockReason: string | null
}): { detail: string; isSafeToDelete: boolean } => {
  // First, and above every other sentence this function can
  // produce: the other branches all describe a rip that is OVER
  // and weigh up what deleting it costs. None of that applies to
  // one that is still running, and offering the operator that
  // trade-off at all would be the bug.
  if (input.lockReason !== null) {
    return {
      detail: `${capitalise(input.lockReason)}.`,
      isSafeToDelete: false,
    }
  }

  if (input.kind === "duplicate") {
    return {
      detail:
        `A FINISHED rip that landed beside ` +
        `"${input.occupiedName ?? "another folder"}", which was ` +
        `already there. Rip Deck never overwrites, so both ` +
        `copies were kept. Delete whichever one you do not ` +
        `want — this is a real rip, not a leftover.`,
      isSafeToDelete: false,
    }
  }

  if (input.discStructure === null) {
    return {
      detail:
        input.sizeBytes === 0
          ? "An EMPTY rip folder. The rip was cancelled or " +
            "refused before it wrote anything, so there is " +
            "nothing here to lose."
          : `${formatBytes(input.sizeBytes)} of partial output ` +
            "with no disc structure in it — no VIDEO_TS, no " +
            "BDMV, and no ISO9660 signature — so no player or " +
            "scanner can read it. The rip stopped before the " +
            "disc structure was written.",
      isSafeToDelete: true,
    }
  }

  // ⚠️ `ISO` here means a DVD image, which is a FILE rather than
  // a directory — see `verifyBackup.ts`. The wording has to fit
  // both shapes, because both land under the same name.
  const shape =
    input.discStructure === "ISO"
      ? "a complete-looking ISO disc image"
      : `a ${input.discStructure} directory`

  return {
    detail:
      `An UNFINISHED rip: ${formatBytes(input.sizeBytes)}, ` +
      `${shape}, kept where it fell. It was never renamed into ` +
      `the library, so Rip Deck never confirmed it — but it is ` +
      `not empty, so check it before you delete it.`,
    isSafeToDelete: false,
  }
}

/**
 * Find every leftover in the destination root.
 *
 * `withFileTypes` so this is one `readdir` rather than a `stat`
 * per entry, and the size walk runs ONLY for entries
 * `classifyLeftover` already claimed — otherwise a listing of the
 * dashboard's snapshot would walk the entire 700-folder library
 * on every poll.
 */
export const scanLeftovers = async (input: {
  rootPath: string
  /**
   * Which rips are running, so a live one is LISTED AND LOCKED.
   *
   * ⚠️ **A live rip stays in the list on purpose.** Hiding it was
   * the alternative and it is worse: the dashboard shows nine
   * bays ripping while the panel shows nothing on disk, and the
   * two views of the same rip then disagree. An operator who
   * cannot see the folder cannot tell "no leftover" from "the
   * panel is not listing one", and the next time a rip really
   * does strand output he has no reason to trust the empty
   * panel. So it is shown, with both controls disabled and a
   * sentence saying which job owns it
   * ([decision](../../../../docs/decisions/2026-08-27-a-leftover-control-refuses-a-live-rip.md)).
   */
  liveRips: LiveRips
}): Promise<Leftover[]> => {
  const entries = await readdir(input.rootPath, {
    withFileTypes: true,
  }).catch(() => [])

  const found: Leftover[] = []

  for (const entry of entries) {
    // ⚠️ A DVD backup is a FILE, not a directory — see
    // `verifyBackup.ts`. Skipping non-directories here would
    // make every leftover DVD image invisible to the one panel
    // that exists to clear them, which is exactly the shape of
    // the bug that produced them.
    if (!entry.isDirectory() && !entry.isFile()) continue

    const classified = classifyLeftover(entry.name)
    if (classified === null) continue

    const path = join(input.rootPath, entry.name)
    const [sizeBytes, discStructure, modifiedAtMs] =
      await Promise.all([
        entry.isDirectory()
          ? measureTree(path)
          : fileSize(path),
        entry.isDirectory()
          ? findDiscStructure(path)
          : readIsoMarker(path),
        modifiedAt(path),
      ])

    const occupiedName =
      classified.kind === "duplicate"
        ? classified.occupiedName
        : null

    // The SAME function the two write verbs refuse on, so the
    // row's locked state and the API's answer can never differ.
    // A disabled button that the endpoint would have allowed —
    // or worse, an armed one it refuses — is the drift this
    // sharing exists to make impossible.
    const lockReason = refusalForLiveRip({
      classified,
      liveRips: input.liveRips,
    })

    found.push({
      path,
      name: entry.name,
      kind: classified.kind,
      occupiedName,
      sizeBytes,
      discStructure,
      modifiedAtMs,
      isLocked: lockReason !== null,
      lockReason,
      ...describeLeftover({
        kind: classified.kind,
        occupiedName,
        sizeBytes,
        discStructure,
        lockReason,
      }),
    })
  }

  // Newest first: the one the operator is asking about is
  // almost always the rip that just failed.
  return found.sort(
    (left, right) => right.modifiedAtMs - left.modifiedAtMs,
  )
}

/**
 * Why NEITHER verb may touch this leftover, or null.
 *
 * ⚠️ **The fifth rule, and the only one that asks the watcher
 * rather than the filesystem.** The other four decide what a PATH
 * is; this one decides what is HAPPENING to it, and nothing on
 * disk can answer that. A `.rip-deck-incomplete-<uuid>` that is
 * being written to right now is byte-for-byte the same shape as
 * one abandoned last week.
 *
 * Two rules, in the order `reaper.ts` puts them:
 *
 *  1. **Unknown refuses.** `isKnown: false` means the live set
 *    could not be read, and "no job claims this uuid" and "we do
 *    not know which jobs exist" must never be read as the same
 *    thing. Reaper guard 2, said again here.
 *  2. **A live job's uuid refuses.** Reaper guard 3.
 *
 * ## Why a duplicate landing is exempt
 *
 * `(rip-deck-duplicate-…)` is applied by `finaliseDestination`
 * and `publishAlbum` when the rip is OVER — the marker exists
 * because the finished output could not take the name it wanted,
 * and it is written by the same rename that ends the rip. So a
 * folder wearing that marker is never being written to, and
 * locking one would take away the control the operator has to use
 * to resolve the collision. Only the incomplete prefix names a
 * job that can still be live.
 *
 * Pure, so nine concurrent rips are a unit test rather than
 * something we find out about on the pool.
 */
export const refusalForLiveRip = (input: {
  classified: LeftoverKind
  liveRips: LiveRips
}): string | null => {
  if (input.classified.kind !== "incomplete") return null

  if (!input.liveRips.isKnown) {
    return (
      "Rip Deck cannot tell which rips are running right " +
      `now (${input.liveRips.reason}), so it will not touch ` +
      "an unfinished rip folder"
    )
  }

  return input.liveRips.jobUuids.has(
    input.classified.jobUuid,
  )
    ? `a rip is writing into this folder right now — job ` +
        `${input.classified.jobUuid} is live. Wait for it to ` +
        `land, or cancel it from its bay`
    : null
}

/**
 * Why a delete was refused, or null when it is allowed.
 *
 * ⚠️ **The validation is the whole point of this function.** The
 * endpoint takes a path from an HTTP body and this is the only
 * thing standing between that and `rm -rf` on a dataset holding
 * 700 finished rips. Five rules, all of which must hold:
 *
 *  1. The resolved path is a DIRECT child of the destination
 *    root. `resolve` first, so `../` cannot climb out and a
 *    symlinked name cannot point elsewhere.
 *  2. Its name is one `classifyLeftover` claims. A finished rip
 *    is not deletable through this endpoint at all — the button
 *    exists to clear leftovers, not to manage the library.
 *  3. It is not the destination root itself.
 *  4. No live rip claims it. See `refusalForLiveRip`.
 *
 * Pure, so all of them can be tested without a filesystem.
 */
export const refusalToDeleteLeftover = (input: {
  rootPath: string
  path: string
  /**
   * Which rips are running. REQUIRED, with no default.
   *
   * A default of "nothing is running" is the one value that
   * turns a forgotten argument into a deleted rip, so the
   * argument is visible at every call site instead.
   */
  liveRips: LiveRips
}): string | null =>
  refusalToTouchLeftover({
    ...input,
    permitted:
      "only a folder in the destination root may be cleared",
    scope:
      "This clears unfinished rips and duplicate landings " +
      "only; a finished rip is not deletable from here.",
  })

/**
 * The five rules, shared by the two verbs that act on a leftover.
 *
 * Extracted when rename arrived, and NOT copied: a second spelling
 * of "is this path safe to act on" is a second thing to keep in
 * step, and the one that drifts is the one nobody tested. The two
 * closing sentences differ because they are what the operator
 * reads, and "not deletable from here" is the wrong sentence to
 * show somebody who pressed Rename.
 *
 * ⚠️ **A third verb gets these by construction, and must.** The
 * live-rip rule arrived because rename had been added WITHOUT it
 * — renaming a directory out from under a running `makemkvcon` is
 * the same class of loss as deleting it, and the four rules that
 * were shared did not include the one that mattered.
 */
const refusalToTouchLeftover = (input: {
  rootPath: string
  path: string
  liveRips: LiveRips
  /**
   * How the direct-child sentence ends — the clause after the
   * em dash, verb included.
   */
  permitted: string
  /** What this endpoint is for, said to whoever aimed it wrong. */
  scope: string
}): string | null => {
  const root = resolve(input.rootPath)
  const target = resolve(input.path)

  if (target === root) {
    return "that is the destination root itself"
  }

  if (!target.startsWith(root + sep)) {
    return `${target} is not inside ${root}`
  }

  const name = basename(target)

  if (join(root, name) !== target) {
    return (
      `${target} is not a direct child of ${root} — ` +
      input.permitted
    )
  }

  const classified = classifyLeftover(name)

  if (classified === null) {
    return `"${name}" is not a Rip Deck leftover. ${input.scope}`
  }

  // Last, because it is the only rule that needs the name to
  // have been claimed first — it reads the uuid out of it.
  return refusalForLiveRip({
    classified,
    liveRips: input.liveRips,
  })
}

export const deleteLeftover = async (input: {
  rootPath: string
  path: string
  liveRips: LiveRips
}): Promise<{ isDeleted: boolean; message: string }> => {
  const refusal = refusalToDeleteLeftover(input)

  if (refusal !== null) {
    return {
      isDeleted: false,
      message: `Refused to delete: ${refusal}.`,
    }
  }

  try {
    await rm(resolve(input.path), {
      recursive: true,
      force: true,
    })
  } catch (error) {
    return {
      isDeleted: false,
      message:
        `Could not delete ${input.path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return {
    isDeleted: true,
    message: `Cleared ${basename(input.path)}.`,
  }
}

/**
 * Why a rename was refused, or null when the NAME is allowed.
 *
 * The owner, 2026-08-27, looking at a Ninja Turtles box set whose
 * discs carry wrong and inconsistent UDF volume labels — one disc
 * whose own menu reads *SEASON 4 / Disc Two* is labelled
 * `Teenage_Mutant_Ninja_Turtles_V7_Disc_2`, and two more share
 * one label outright so the second landed marked as a duplicate:
 *
 * > *"We need to be able to delete (which you added) AND also
 * > rename the rip, so it doesn't conflict."*
 *
 * ⚠️ **This checks the SOURCE and the NAME, and cannot check the
 * DESTINATION.** "Is something already there" is a filesystem
 * fact, so it lives in `renameLeftover` — see the note there
 * about why refusing to clobber is the rule that matters most.
 * Everything that can be decided from two strings is decided
 * here, so it is testable without a filesystem, exactly like the
 * delete refusal beside it.
 *
 * ⚠️ **Renaming a live rip's folder is the same loss as deleting
 * it.** `makemkvcon` holds an open handle on a path it was given
 * before it started; moving that directory out from under it
 * strands every byte it has written and every byte it is about
 * to. The live-rip rule is therefore shared with delete rather
 * than being a delete-only guard — see `refusalForLiveRip`.
 *
 * The source rules are `refusalToDeleteLeftover`'s five, shared
 * rather than restated. On top of them the new name must be ONE
 * PATH SEGMENT:
 *
 *  1. Not empty, and not only whitespace.
 *  2. No `/` and no `\`. A rename moves nothing; it renames in
 *    place, and a name with a separator in it is a caller asking
 *    for something this endpoint does not do.
 *  3. Not `.` and not `..`. Both resolve to a directory that is
 *    not the leftover, and `rename(x, "..")` is a question with
 *    no good answer.
 *  4. The result still lands as a direct child of the root. A
 *    belt-and-braces re-check of rule 1 above, against the
 *    resolved path rather than against the characters — so a
 *    separator this platform recognises and the list above does
 *    not is caught anyway.
 *
 * What it deliberately does NOT check is whether the new name is
 * one `classifyLeftover` claims. Removing the
 * `(rip-deck-duplicate-…)` marker is the main reason to rename at
 * all, and a rename whose result had to still look like a
 * leftover could never do it.
 */
export const refusalToRenameLeftover = (input: {
  rootPath: string
  path: string
  newName: string
  /** Which rips are running. Required, as delete's is. */
  liveRips: LiveRips
}): string | null => {
  const sourceRefusal = refusalToTouchLeftover({
    liveRips: input.liveRips,
    path: input.path,
    permitted:
      "only a folder in the destination root may be renamed",
    rootPath: input.rootPath,
    scope:
      "This renames unfinished rips and duplicate landings " +
      "only; a finished rip is not renamable from here.",
  })

  if (sourceRefusal !== null) return sourceRefusal

  const name = input.newName.trim()

  if (name === "") {
    return "the new name is empty"
  }

  if (name.includes("/") || name.includes("\\")) {
    return (
      `"${name}" is a path, not a name. A rename renames in ` +
      "place, so the new name is one folder name with no " +
      "slashes in it."
    )
  }

  if (name === "." || name === "..") {
    return `"${name}" is a directory traversal, not a name.`
  }

  // Spelled as a codepoint test rather than as a regex: a
  // character class holding literal control characters is what
  // `noControlCharactersInRegex` exists to catch, and silencing
  // that rule to say "no control characters" reads badly.
  const hasControlCharacter = [...name].some(
    (character) => (character.codePointAt(0) ?? 0) < 0x20,
  )

  if (hasControlCharacter) {
    return (
      "the new name has a control character in it, which no " +
      "filesystem this runs on will store."
    )
  }

  const root = resolve(input.rootPath)
  const destination = resolve(join(root, name))

  if (join(root, basename(destination)) !== destination) {
    return (
      `${destination} is not a direct child of ${root} — ` +
      "a rename may not move a leftover out of the " +
      "destination root"
    )
  }

  return null
}

/**
 * The name a rename ACTUALLY lands under.
 *
 * ⚠️ **A DVD backup is one ISO FILE, and it keeps its extension.**
 * `finaliseDestination` decides the suffix from what is on disk
 * rather than from the disc type, and publishes a file-shaped rip
 * as `<name>.iso`
 * ([decision](../../../../docs/decisions/2026-08-26-a-dvd-backup-is-one-iso-file-not-a-directory.md)).
 * An operator retyping a name has no reason to remember that, and
 * an 8 GB extension-less ISO is the exact thing that decision
 * exists to stop — Windows offers to open it in a text editor and
 * no scanner recognises it. So the suffix is appended for him.
 *
 * A Blu-ray backup is a DIRECTORY and takes no suffix, which is
 * why this needs `isFile` and cannot read the disc type.
 *
 * Case-insensitive, because a name typed as `… .ISO` already has
 * the extension and gaining a second one would be worse than
 * having none.
 */
export const renamedLeftoverName = (input: {
  newName: string
  isFile: boolean
}): string => {
  const name = input.newName.trim()

  return input.isFile &&
    !name.toLowerCase().endsWith(ISO_SUFFIX)
    ? `${name}${ISO_SUFFIX}`
    : name
}

/**
 * Rename one leftover, in place, in the destination root.
 *
 * ⚠️ **It REFUSES rather than clobbers, and that is the whole
 * point of the feature.** The reason to rename is a name
 * collision; resolving one by silently overwriting an 8 GB ISO
 * with another 8 GB ISO would be the worst failure this code
 * could have. `finaliseDestination` makes the same promise on the
 * rip path and for the same reason — a rip that lands on a taken
 * name goes beside it, marked, and a human chooses.
 *
 * The exists-check and the `rename` are two syscalls, so a rip
 * finalising into that exact name in between would still be
 * clobbered. The window is microseconds against a control a
 * person presses, `finaliseDestination` refuses the same
 * collision from its side, and Node exposes no atomic
 * `RENAME_NOREPLACE`. Stated rather than hidden.
 */
export const renameLeftover = async (input: {
  rootPath: string
  path: string
  newName: string
  liveRips: LiveRips
}): Promise<{
  isRenamed: boolean
  message: string
  /** Where it landed, or null when nothing moved. */
  path: string | null
}> => {
  const refusal = refusalToRenameLeftover(input)

  if (refusal !== null) {
    return {
      isRenamed: false,
      message: `Refused to rename: ${refusal}.`,
      path: null,
    }
  }

  const source = resolve(input.path)
  const info = await stat(source).catch(() => null)

  if (info === null) {
    return {
      isRenamed: false,
      message:
        `Refused to rename: ${basename(source)} is no longer ` +
        "there. Something else may have cleared it already.",
      path: null,
    }
  }

  const name = renamedLeftoverName({
    isFile: info.isFile(),
    newName: input.newName,
  })
  const destination = join(resolve(input.rootPath), name)

  if (destination === source) {
    return {
      isRenamed: false,
      message: `Refused to rename: "${name}" is the name it already has.`,
      path: null,
    }
  }

  if (await pathExists(destination)) {
    return {
      isRenamed: false,
      message:
        `Refused to rename: "${name}" is already taken. Rip ` +
        "Deck never overwrites a rip, so pick a name nothing " +
        "in the destination root is using.",
      path: null,
    }
  }

  try {
    await rename(source, destination)
  } catch (error) {
    return {
      isRenamed: false,
      message:
        `Could not rename ${basename(source)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      path: null,
    }
  }

  return {
    isRenamed: true,
    message: `Renamed to ${name}.`,
    path: destination,
  }
}

/**
 * `"ISO"` when this file carries the ISO9660 signature.
 *
 * The same `CD001`-at-byte-32769 check `verifyBackup.ts` makes,
 * and for the same reason: MakeMKV writes a DVD image with no
 * extension, so there is nothing else to key on. A COPY rather
 * than a shared import, because that one is on the rip path and
 * answers a different question — whether a finished rip counts —
 * and coupling a UI listing to the verification rule would mean
 * a threshold change silently relabelling the panel.
 */
const readIsoMarker = async (
  path: string,
): Promise<string | null> => {
  let handle: Awaited<ReturnType<typeof open>> | null = null

  try {
    handle = await open(path, "r")
    const buffer = Buffer.alloc(5)
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      32_769,
    )

    return bytesRead === buffer.length &&
      buffer.toString("latin1") === "CD001"
      ? "ISO"
      : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

const fileSize = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** `VIDEO_TS` or `BDMV`, or null when neither is present. */
const findDiscStructure = async (
  path: string,
): Promise<string | null> => {
  for (const marker of ["VIDEO_TS", "BDMV"]) {
    try {
      const info = await stat(join(path, marker))
      if (info.isDirectory()) return marker
    } catch {
      // Absent; try the next.
    }
  }

  return null
}

const modifiedAt = async (
  path: string,
): Promise<number> => {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Bytes under a directory.
 *
 * A local copy rather than a shared helper with
 * `verifyBackup.ts`: that one is on the rip path and answers a
 * different question (does this look like a finished disc), and
 * merging them would couple a UI listing to the verification
 * rule. `force`-style tolerance instead of throwing, because a
 * folder being deleted underneath a poll is normal here.
 */
const measureTree = async (
  path: string,
): Promise<number> => {
  const entries = await readdir(path, {
    withFileTypes: true,
  }).catch(() => [])

  let total = 0

  for (const entry of entries) {
    const child = join(path, entry.name)

    if (entry.isDirectory()) {
      total += await measureTree(child)
      continue
    }

    total += await stat(child)
      .then((info) => info.size)
      .catch(() => 0)
  }

  return total
}

/**
 * A refusal clause, promoted to a sentence.
 *
 * `refusalForLiveRip` writes a lower-case clause because its
 * first reader is `Refused to delete: <clause>.`, and the panel's
 * second reader wants the same words standing alone. Sharing the
 * string rather than writing it twice is the point — two
 * spellings of "a rip is running in here" is two things to keep
 * in step.
 */
const capitalise = (sentence: string): string =>
  sentence.charAt(0).toUpperCase() + sentence.slice(1)

const formatBytes = (bytes: number): string => {
  const gb = bytes / 1_000_000_000

  return gb >= 1
    ? `${gb.toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`
}

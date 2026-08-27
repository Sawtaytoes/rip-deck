import { readdir, rm, stat } from "node:fs/promises"
import { basename, join, resolve, sep } from "node:path"
import { incompleteDirName } from "./destination.ts"

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

  const marker = name.lastIndexOf(` ${DUPLICATE_MARKER}`)

  return marker === -1 || !name.endsWith(")")
    ? null
    : {
        kind: "duplicate",
        occupiedName: name.slice(0, marker),
      }
}

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
}): { detail: string; isSafeToDelete: boolean } => {
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
            "with no VIDEO_TS or BDMV directory, so no player " +
            "or scanner can read it. The rip stopped before " +
            "the disc structure was written.",
      isSafeToDelete: true,
    }
  }

  return {
    detail:
      `An UNFINISHED rip: ${formatBytes(input.sizeBytes)} with ` +
      `a ${input.discStructure} directory, kept where it fell. ` +
      `It was never renamed into the library, so it is ` +
      `incomplete — but it is not empty, so check it before ` +
      `you delete it.`,
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
}): Promise<Leftover[]> => {
  const entries = await readdir(input.rootPath, {
    withFileTypes: true,
  }).catch(() => [])

  const found: Leftover[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const classified = classifyLeftover(entry.name)
    if (classified === null) continue

    const path = join(input.rootPath, entry.name)
    const [sizeBytes, discStructure, modifiedAtMs] =
      await Promise.all([
        measureTree(path),
        findDiscStructure(path),
        modifiedAt(path),
      ])

    const occupiedName =
      classified.kind === "duplicate"
        ? classified.occupiedName
        : null

    found.push({
      path,
      name: entry.name,
      kind: classified.kind,
      occupiedName,
      sizeBytes,
      discStructure,
      modifiedAtMs,
      ...describeLeftover({
        kind: classified.kind,
        occupiedName,
        sizeBytes,
        discStructure,
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
 * Why a delete was refused, or null when it is allowed.
 *
 * ⚠️ **The validation is the whole point of this function.** The
 * endpoint takes a path from an HTTP body and this is the only
 * thing standing between that and `rm -rf` on a dataset holding
 * 700 finished rips. Three rules, all of which must hold:
 *
 *  1. The resolved path is a DIRECT child of the destination
 *    root. `resolve` first, so `../` cannot climb out and a
 *    symlinked name cannot point elsewhere.
 *  2. Its name is one `classifyLeftover` claims. A finished rip
 *    is not deletable through this endpoint at all — the button
 *    exists to clear leftovers, not to manage the library.
 *  3. It is not the destination root itself.
 *
 * Pure, so all three can be tested without a filesystem.
 */
export const refusalToDeleteLeftover = (input: {
  rootPath: string
  path: string
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
      "only a folder in the destination root may be cleared"
    )
  }

  if (classifyLeftover(name) === null) {
    return (
      `"${name}" is not a Rip Deck leftover. This clears ` +
      "unfinished rips and duplicate landings only; a finished " +
      "rip is not deletable from here."
    )
  }

  return null
}

export const deleteLeftover = async (input: {
  rootPath: string
  path: string
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

const formatBytes = (bytes: number): string => {
  const gb = bytes / 1_000_000_000

  return gb >= 1
    ? `${gb.toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`
}

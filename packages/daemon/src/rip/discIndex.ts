import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { DrvEvent } from "@rip-deck/contracts"
import { parseMakemkvLine } from "../makemkv/parseLine.ts"
import type { MakemkvCommand } from "./ripCommand.ts"

/**
 * Map `/dev/srN` to the disc index `backup` insists on.
 *
 * Discovered on hardware 2026-07-25, and it is the single most
 * annoying fact in this codebase: **`makemkvcon backup` refuses
 * a `dev:` source.** It answers
 *
 *   Backup source must start with "disc:"
 *
 * and exits 10. `info` accepts `dev:`, `mkv` accepts `dev:`,
 * `backup` does not — the usage text lists the four source
 * forms once, globally, and does not mention that `backup`
 * takes only one of them.
 *
 * That forces a THIRD numbering on us. We already juggle the
 * physical slot and the kernel's `srN` (which is the inverse of
 * physical order); the disc index is a separate sequence again,
 * assigned in MakeMKV's own scan order. Measured on this rig,
 * all three disagree:
 *
 *   slot 9  ->  /dev/sr0  ->  disc:5
 *   slot 1  ->  /dev/sr8  ->  disc:0
 *
 * So the index is meaningless without the lookup, and it must be
 * resolved immediately before the rip: it is derived from
 * enumeration order, and a drive appearing or disappearing
 * renumbers everything after it. `verifyDiscIndex` exists
 * because that renumbering could otherwise silently point a rip
 * at the wrong drive.
 */

/** MakeMKV pads its list to 16 slots with `visible=256`. */
const PADDING_VISIBLE = 256

/** Enumeration is a full bus scan; bound it. */
const ENUMERATE_TIMEOUT_MS = 120_000

export type DriveEnumeration = {
  /** Disc index keyed by device path, e.g. `/dev/sr0` -> 5. */
  indexByDevPath: Map<string, number>
  drives: DrvEvent[]
}

/**
 * Enumerate drives to learn their disc indices.
 *
 * This is a full `info disc:9999` bus scan, which is exactly the
 * call that hung for seventeen minutes at 0% CPU on a wedged
 * sibling — the failure `--noscan` and `dev:` scoping exist to
 * avoid (E3). We are forced into it here because `backup` has no
 * device-scoped form at all.
 *
 * It is bounded and it happens ONCE, before the spawn, rather
 * than on any sampling path.
 *
 * ⚠️ **An isolated rip does not need this call at all.** With one
 * device visible the index is always `ISOLATED_DISC_INDEX`, so a
 * caller that has isolation configured should skip straight to
 * `runRipJob` and spend the scan's time ripping — nine
 * concurrent rips each opening nine drives is precisely the
 * contention isolation exists to remove. The call still earns its
 * place as a preflight ("is this drive visible to MakeMKV at
 * all?") on the unisolated path.
 */
export const enumerateDrives = async (input: {
  makemkv: MakemkvCommand
  timeoutMs?: number
}): Promise<DriveEnumeration> => {
  const args = [
    ...input.makemkv.prefixArgs,
    "-r",
    "--cache=1",
    "info",
    "disc:9999",
  ]

  const drives = await new Promise<DrvEvent[]>(
    (resolve) => {
      const collected: DrvEvent[] = []
      const child = spawn(input.makemkv.command, args, {
        stdio: ["ignore", "pipe", "ignore"],
      })

      const timeout = setTimeout(() => {
        child.kill("SIGKILL")
      }, input.timeoutMs ?? ENUMERATE_TIMEOUT_MS)

      createInterface({ input: child.stdout }).on(
        "line",
        (line) => {
          const event = parseMakemkvLine(line)
          if (event.type === "DRV") collected.push(event)
        },
      )

      child.once("error", () => {
        clearTimeout(timeout)
        resolve([])
      })
      child.once("close", () => {
        clearTimeout(timeout)
        resolve(collected)
      })
    },
  )

  return {
    indexByDevPath: buildIndexByDevPath(drives),
    drives,
  }
}

/**
 * Fold the DRV list into a device-path lookup.
 *
 * Pure, so the padding and empty-path rules are testable without
 * a drive attached.
 */
export const buildIndexByDevPath = (
  drives: DrvEvent[],
): Map<string, number> => {
  const indexByDevPath = new Map<string, number>()

  for (const drive of drives) {
    // The 16-slot padding carries an empty device path; mapping
    // "" to an index would make every unmatched lookup resolve
    // to a real drive, which is the worst possible failure here.
    if (drive.visible === PADDING_VISIBLE) continue
    if (drive.devicePath.trim() === "") continue

    indexByDevPath.set(drive.devicePath, drive.index)
  }

  return indexByDevPath
}

/**
 * Confirm the drive MakeMKV opened is the one we asked for.
 *
 * `backup disc:N` re-scans the bus on startup and re-emits the
 * whole DRV table before it reads a byte. That table is MakeMKV
 * telling us, in its own words, which device each index points
 * at right now — so it is a free, authoritative check against
 * the index having shifted between our enumeration and this
 * process's.
 *
 * Getting this wrong would not error; it would cheerfully rip a
 * DIFFERENT bay's disc into a folder named after this one. That
 * is unrecoverable-by-inspection, so the mismatch is fatal.
 *
 * Returns null while the answer is not yet knowable — the table
 * arrives a few lines into the stream, and absence of the row is
 * not evidence of a mismatch.
 *
 * **Under per-rip device isolation this check becomes cheap and
 * nearly tautological, and it is kept deliberately.** A container
 * holding one `--device` should always answer with that one
 * device at index 0 — but "should" is doing real work in that
 * sentence: the numbering of a lone drive is assumed rather than
 * measured, and a `--device` built from a stale `/dev/srN` would
 * map a sibling in with total confidence. This is the last line
 * of defence against an error nothing downstream can detect, and
 * on an already-parsed stream it costs a `find` over sixteen
 * rows.
 */
export const verifyDiscIndex = (input: {
  drives: DrvEvent[]
  discIndex: number
  expectedDevPath: string
}): { isMatch: boolean; actualDevPath: string } | null => {
  const row = input.drives.find(
    (drive) => drive.index === input.discIndex,
  )

  if (row === undefined) return null
  if (row.visible === PADDING_VISIBLE) return null
  if (row.devicePath.trim() === "") return null

  return {
    isMatch: row.devicePath === input.expectedDevPath,
    actualDevPath: row.devicePath,
  }
}

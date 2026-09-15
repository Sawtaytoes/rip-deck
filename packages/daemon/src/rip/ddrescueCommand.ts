/**
 * The `ddrescue` invocation, built in one place.
 *
 * The third branch of the fork in `discType.ts`, and the one
 * requirement A4 named: a **data CD-ROM** becomes a raw image
 * plus the mapfile that says which sectors were read. MakeMKV
 * does not handle data discs and cyanrip rips audio tracks a
 * data disc does not have, so before this existed a data CD
 * reached `needs_attention` and stopped there.
 *
 * ⚠️ **Nothing here has been run against a disc.** Same standing
 * as `cyanripCommand.ts` on the day it was written. What it HAS
 * been checked against is the real binary: every flag below was
 * read out of `ddrescue --help` from the package this image
 * installs, not out of documentation.
 *
 * ## Why ddrescue and not `dd`
 *
 * `dd conv=noerror,sync` is the recipe that circulates, and it
 * is the one thing this repo must never do: it replaces an
 * unreadable sector with ZEROES and exits 0, so a disc with rot
 * produces a full-length image that looks perfect and is
 * quietly corrupt. That is the same silent-success class as
 * `makemkvcon` exiting 0 on "Failed to open disc" — the fault
 * D1 exists for. ddrescue records every sector it could not
 * read in a MAPFILE, so "did I get all of it" is a question
 * with an exact answer instead of a hope.
 *
 * ## Provenance
 *
 * Checked because J6 makes it a hard constraint. GNU ddrescue
 * is by **Antonio Diaz Diaz** (Spain), part of the GNU project,
 * GPLv2+, and packaged in **Debian main**. The image installs
 * 1.29-1 from trixie, whose own `--version` prints
 * `Copyright (C) 2025 Antonio Diaz Diaz`. No Chinese-origin
 * component in its chain — it has no dependencies beyond libc
 * and libstdc++.
 *
 * ⚠️ **The package is `gddrescue`; the binary is `ddrescue`.**
 * There is no package called `ddrescue` in trixie at all, so
 * the line an author would write by reflex —
 * `apt-get install ddrescue` — fails the image build with
 * "Unable to locate package". Verified against the archive on
 * 2026-09-15.
 *
 * ## Flags that matter by their ABSENCE
 *
 * As with cyanrip, some requirements here are met by flags that
 * must never appear, which is invisible in a diff. Each has a
 * test asserting it is absent.
 *
 *  - `-p` preallocates the output file. **Never pass it.** The
 *    outcome is decided by comparing the image's LENGTH against
 *    the disc's capacity, and a preallocated file is
 *    full-length from the first second — so a rip that died
 *    after 4 MB would verify as complete.
 *  - `-n` skips the scraping phase. Not passed: scraping is
 *    how a marginal sector is eventually recovered, and
 *    skipping it would report a readable disc as damaged.
 *  - `-f` overwrites an output DEVICE. Never passed. The output
 *    here is always a regular file inside the job's own
 *    incomplete directory, and a build that needs `-f` to work
 *    is a build aimed at the wrong path.
 *  - `-d` / `-D` use direct disc access. Not passed: direct I/O
 *    on USB optical drives is inconsistent across firmware, and
 *    this tower's drives are three different models.
 *  - `-S` writes the output sparsely. Not passed. A sparse image
 *    reads back as zeroes in the holes, which is exactly the
 *    `dd conv=sync` failure this file rejects, only harder to
 *    see.
 */

/**
 * The sector size of a data CD or DVD, in bytes.
 *
 * ddrescue defaults to 512, which is wrong here in a way that
 * does not announce itself. A CD-ROM Mode 1 sector holds 2048
 * bytes of user data and the drive cannot read a quarter of
 * one, so at the default a single failed sector is recorded as
 * four bad 512-byte blocks and every retry re-reads the same
 * physical sector four times. The image is the same either way;
 * the mapfile — which is the whole reason for using this tool —
 * is not.
 */
export const DATA_DISC_SECTOR_BYTES = 2048

/**
 * Seconds without a successful read before ddrescue gives up.
 *
 * The liveness guard, and the reason this path needs no
 * watchdog of its own. A disc the drive simply cannot read will
 * otherwise retry inside the scraping phase for as long as
 * there are sectors left, holding a bay for hours and producing
 * nothing that was not already in the image after the first
 * pass.
 *
 * Five minutes rather than one: a drive that has hit a damaged
 * region backs off, re-seeks and re-reads, and the gap between
 * two genuinely successful reads on a scratched disc is
 * routinely tens of seconds. A short timeout would abandon
 * discs that were still making progress.
 */
export const DATA_DISC_TIMEOUT_SECONDS = 300

/**
 * Retry passes over the areas that failed the first time.
 *
 * ddrescue's default is 0, which means the copy, trim and
 * scrape phases run once each and the run ends. One retry pass
 * costs nothing on a clean disc — there is nothing left to
 * retry, so the pass is skipped entirely — and recovers the
 * marginal sector that read on the second attempt, which is the
 * common case on a pressed disc with a fingerprint on it.
 *
 * Not more than one: beyond that the returns are thin and the
 * bay is held, and `DATA_DISC_TIMEOUT_SECONDS` is a time bound
 * rather than a progress bound.
 */
export const DATA_DISC_RETRY_PASSES = 1

export type DdrescueCommandInput = {
  /**
   * `/dev/srN`. Ephemeral — resolve it immediately before the
   * spawn, never persist it as identity.
   *
   * Addressed directly, like cyanrip and unlike
   * `makemkvcon backup`, so nothing enumerates the bus and a
   * wedged sibling drive cannot delay this rip.
   */
  devPath: string
  /** Where the raw image is written. Inside the job's own dir. */
  imagePath: string
  /**
   * Where the mapfile is written. Inside the job's own dir.
   *
   * ⚠️ **Not optional, and not a debug artefact.** Without a
   * mapfile ddrescue cannot report which sectors failed and
   * cannot resume, so the rip's outcome would collapse back to
   * "the exit code was 0" — which is the assumption this whole
   * repository exists because of.
   */
  mapfilePath: string
}

export const buildDdrescueArgs = ({
  devPath,
  imagePath,
  mapfilePath,
}: DdrescueCommandInput): string[] => [
  "--sector-size",
  String(DATA_DISC_SECTOR_BYTES),
  "--retry-passes",
  String(DATA_DISC_RETRY_PASSES),
  "--timeout",
  `${String(DATA_DISC_TIMEOUT_SECONDS)}s`,
  // Positional, and in this order: ddrescue takes
  // `infile outfile mapfile` and silently means something very
  // different if two of them are swapped.
  devPath,
  imagePath,
  mapfilePath,
]

/**
 * How to invoke ddrescue, as a command VECTOR.
 *
 * Same shape and same reason as `resolveCyanripCommand`: the
 * binary may live somewhere else, and `RIP_DECK_DDRESCUE` is
 * how a rip reaches it. The image ships it, so the default bare
 * `"ddrescue"` is the live path and a wrapper is the exception.
 */
export type DdrescueCommand = {
  command: string
  /** Args that precede ddrescue's own args, for wrappers. */
  prefixArgs: string[]
  /**
   * How to run an arbitrary command wherever ddrescue runs — the
   * wrapper with its trailing binary removed, or null when
   * ddrescue is spawned directly.
   *
   * Exists for the same measured reason as its two twins:
   * SIGTERM to a `docker exec` client kills the client and
   * leaves the process inside the container running, so a
   * cancel would orphan a ripper still holding the drive (E5).
   */
  wrapperArgs: string[] | null
}

export const resolveDdrescueCommand = (
  raw: string | undefined,
): DdrescueCommand => {
  const parts = (raw ?? "ddrescue").trim().split(/\s+/)

  // The binary is always the last token, so everything before it
  // is the wrapper. A single token means no wrapper at all.
  return {
    command: parts[0],
    prefixArgs: parts.slice(1),
    wrapperArgs:
      parts.length > 1 ? parts.slice(1, -1) : null,
  }
}

export type DdrescueInvocation = {
  command: string
  args: string[]
}

/** A complete, spawnable ddrescue invocation. */
export const buildDdrescueInvocation = (input: {
  ddrescue: DdrescueCommand
  rip: DdrescueCommandInput
}): DdrescueInvocation => ({
  command: input.ddrescue.command,
  args: [
    ...input.ddrescue.prefixArgs,
    ...buildDdrescueArgs(input.rip),
  ],
})

/**
 * Args that kill our ddrescue wherever the wrapper put it.
 *
 * Matched on the DEVICE PATH, for the same reason as cyanrip's
 * twin: one drive runs at most one rip, so the device
 * identifies the process exactly, and it is in the argv.
 *
 * ⚠️ **The anchors are load-bearing.** `pkill -f` matches an
 * extended regular expression against the whole space-joined
 * command line, so a bare `/dev/sr1` is a substring of
 * `/dev/sr10` and would kill an unrelated bay's rip. `srN`
 * numbering follows enumeration order and is not bounded by the
 * nine physical drives, so two-digit device names are a normal
 * state rather than a hypothetical.
 */
export const buildDdrescueKillArgs = (input: {
  wrapperArgs: string[]
  devPath: string
  signal: "TERM" | "KILL"
}): string[] => [
  ...input.wrapperArgs,
  "pkill",
  `-${input.signal}`,
  "-f",
  `(^| )${input.devPath}( |$)`,
]

/**
 * What ddrescue's mapfile says about the read.
 *
 * `recoveredBytes + unrecoveredBytes` is the region ddrescue
 * described, which is the whole device once a run has finished.
 */
export type DiscImageMap = {
  recoveredBytes: number
  /**
   * Bytes ddrescue never read successfully.
   *
   * Non-tried, non-trimmed, non-scraped and bad-sector blocks
   * all count here. The distinction between them matters to a
   * resume and not to an outcome: every one of them is a hole
   * in the image.
   */
  unrecoveredBytes: number
}

/** Mapfile block statuses that mean "this data is in the image". */
const RECOVERED_STATUS = "+"

/** Every status character ddrescue writes in the third column. */
const BLOCK_STATUSES = new Set([
  RECOVERED_STATUS,
  // Non-tried.
  "?",
  // Non-trimmed.
  "*",
  // Non-scraped.
  "/",
  // Bad sector.
  "-",
])

/**
 * Read a ddrescue mapfile into recovered and unrecovered totals.
 *
 * ## The format, and the one line that is not a block
 *
 * Comments start with `#`. The first line that is not a comment
 * is the STATUS line — current position, a status character and
 * a pass number — and every line after it is a block:
 * `pos size status`, both numbers hexadecimal.
 *
 * Blocks are recognised by SHAPE rather than by position: three
 * whitespace-separated fields whose third is one of ddrescue's
 * five status characters. The status line cannot be mistaken
 * for one, because its third field is a pass number. Keying on
 * "skip the first non-comment line" instead would silently
 * mis-total a mapfile whose header ddrescue ever changes, and
 * the number it produced would still look plausible.
 *
 * Returns null when the file holds no blocks at all, which is
 * the state of a mapfile ddrescue created and died before
 * writing — an answer of "0 bytes unrecovered" there would be a
 * clean bill of health for a rip that never happened.
 */
export const parseDiscImageMap = (
  contents: string,
): DiscImageMap | null => {
  let recoveredBytes = 0
  let unrecoveredBytes = 0
  let hasBlock = false

  for (const line of contents.split("\n")) {
    const trimmed = line.trim()

    if (trimmed === "" || trimmed.startsWith("#")) continue

    const fields = trimmed.split(/\s+/)

    if (fields.length !== 3) continue
    if (!BLOCK_STATUSES.has(fields[2])) continue

    const size = Number(fields[1])

    // `Number()` on a `0x…` string parses hexadecimal, and
    // returns NaN rather than throwing on anything else. A
    // block whose size cannot be read is skipped rather than
    // counted as zero: a silent zero would shrink the disc.
    if (!Number.isFinite(size)) continue

    hasBlock = true

    if (fields[2] === RECOVERED_STATUS) {
      recoveredBytes += size
      continue
    }

    unrecoveredBytes += size
  }

  return hasBlock
    ? { recoveredBytes, unrecoveredBytes }
    : null
}

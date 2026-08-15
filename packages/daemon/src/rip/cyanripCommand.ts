/**
 * The `cyanrip` invocation, built in one place.
 *
 * The audio-CD half of the fork in `discType.ts`. Requirement A3
 * pins the tool — **cyanrip, not abcde** — and the format:
 * FLAC, with AccurateRip v1 and v2 verification. B5 adds
 * MusicBrainz tagging and embedded cover art.
 *
 * ⚠️ **Nothing here has been run against a CD.** The MakeMKV
 * side of the fork has two complete Blu-ray rips behind it and
 * every flag in `ripCommand.ts` is a fix for a failure someone
 * watched happen. This file still has no disc behind it, and the
 * first real CD should be expected to correct some of it.
 *
 * What it *does* now have, as of 2026-07-27, is the binary. The
 * image carries cyanrip 0.9.3 (Debian trixie), and on this rig
 * it opened slot 1's real drive and identified it through
 * libcdio. So the flags below are checked against the real
 * `cyanrip -h` rather than against documentation, and the two
 * agreed on every one. Two measured behaviours:
 *
 *  - **The version flag is `-V`, not `--version`.** `--version`
 *    is rejected ("invalid option -- '-'"), which matters
 *    because a health check written the obvious way would report
 *    a missing binary that is present.
 *  - **An empty drive exits 1 in under a second, writing
 *    nothing** ("Invalid number of tracks: 255!"). That is the
 *    fail-closed direction, and it is the opposite of
 *    `makemkvcon`, which exits 0 on "Failed to open disc" —
 *    the asymmetry D1 exists for.
 *
 * ## Provenance
 *
 * Checked because J6 makes it a hard constraint and the plan
 * naming a tool does not exempt it. cyanrip is by **Lynne**
 * (GitHub `cyanreg`, `dev@lynne.ee`), an FFmpeg core developer
 * who maintains `hwcontext_vulkan*` and `tx*` in FFmpeg's own
 * MAINTAINERS file. LGPL-2.1, public since 2016, packaged in
 * **Debian main** (trixie onward) by the Debian Multimedia
 * Maintainers. Its dependency set — FFmpeg, libcdio-paranoia,
 * libmusicbrainz5, libcurl — is long-established Western FOSS.
 * No Chinese-origin component anywhere in that chain.
 *
 * Re-confirmed against the package actually installed, rather
 * than the one this paragraph was written about — a same-named
 * impostor is exactly what that check is for. `cyanrip
 * 0.9.3.1-1+b1`'s own `/usr/share/doc/cyanrip/copyright` names
 * `Upstream-Contact: Lynne <dev@lynne.ee>` and
 * `Source: https://github.com/cyanreg/cyanrip` under LGPL-2.1+,
 * packaged by Sebastian Ramacher for the Debian Multimedia
 * Maintainers. Same project.
 *
 * ## Flags that matter by their ABSENCE
 *
 * cyanrip's accuracy and metadata features are ON by default and
 * are switched OFF by a flag. That inverts the usual reading of
 * a command line: the requirements here are satisfied by flags
 * we must never pass, which is invisible in a diff and easy to
 * "tidy up" later. Each one therefore has a test asserting it is
 * absent.
 *
 *  - `-A` disables the AccurateRip query. **Never pass it** — A3
 *    asks for AccurateRip v1+v2, and cyanrip does both by
 *    default.
 *  - `-N` disables MusicBrainz lookup. Not passed by default
 *    (B5), but exposed, because H4 wants a rip to survive with
 *    no internet.
 *  - `-U` disables cover-art lookup and `-G` disables embedding.
 *    **Never pass either** — B5 asks for embedded art.
 *  - `-Q` ejects the tray after a successful rip. **Never pass
 *    it.** Auto-eject on the rip cycle is the root cause of the
 *    flap-storm that killed valid rips in other bays, and "only
 *    on success" is exactly how a flap starts when a disc is
 *    re-read. (An OPERATOR may eject — `rip/tray.ts`,
 *    [decision](docs/decisions/2026-07-26-operator-triggered-eject-over-mqtt.md).
 *    A ripper deciding to is a different thing entirely.)
 *  - `-P` sets the paranoia level and `0` disables checking
 *    entirely. Left at its default maximum; D1 says a rip with
 *    read errors is not a success, and turning the error
 *    detection down to make rips finish is the same bug wearing
 *    a different hat.
 */

import { isValidReadOffsetSamples } from "@rip-deck/contracts"

/**
 * FLAC, and never anything lossy.
 *
 * This is cyanrip's default too, and it is still passed
 * explicitly: A2's "never transcode" is a hard constraint, and a
 * hard constraint that depends on an upstream default is one
 * upstream release away from being violated silently.
 *
 * FLAC from CD-DA is not a transcode — it is a lossless
 * container for the exact samples read off the disc, which is
 * what AccurateRip checksums in the first place. The transcode
 * ban is about the video path.
 */
export const CYANRIP_OUTPUT_FORMAT = "flac"

export type CyanripCommandInput = {
  /**
   * `/dev/srN`. Ephemeral — resolve it immediately before the
   * spawn, never persist it as identity.
   *
   * Unlike `makemkvcon backup`, which is forced onto a
   * bus-enumeration `disc:<index>` and re-scans every drive to
   * resolve it, cyanrip addresses the device directly. So the
   * audio path has the per-drive isolation the video path had to
   * give up (HANDOFF §2.2): a wedged sibling cannot delay the
   * start of a CD rip, because nothing enumerates the bus.
   */
  devPath: string
  /**
   * The drive's read offset, in samples.
   *
   * This is not cosmetic. AccurateRip compares checksums of
   * samples aligned to a reference offset, so a drive ripping at
   * the wrong offset produces a bit-perfect-but-shifted file
   * that **never matches the database** — the verification A3
   * asks for silently reports "not in database" on every disc,
   * forever, and looks like a metadata problem rather than a
   * configuration one.
   *
   * Offsets are per drive MODEL, and this tower is not uniform:
   * slots 2-4 are LG units whose OmniDrive firmware reports them
   * as ASUS, so the model string cannot be used to look one up.
   * Omitted until a real value exists per serial — cyanrip's
   * `-f` finds it from a disc with an AccurateRip entry.
   *
   * It lives in `config/drives.json` as `readOffsetSamples`,
   * against the drive's `firmwareSerial`, and reaches here via
   * the registry (`drives/registry.ts`) and the bay's
   * `BayRipInput`. Null — the state every drive is in today —
   * omits the flag silently: no warning and no log line, the
   * same way a missing `RIP_DECK_MQTT_URL` is a supported state
   * rather than an error.
   */
  driveOffsetSamples?: number | null
  /**
   * Pass `-N` to skip the MusicBrainz lookup entirely.
   *
   * Default on, for B5. Turn it off for an offline rip (H4).
   *
   * ⚠️ Unverified: what cyanrip does when a lookup is ENABLED
   * and the network is down is not documented and has not been
   * observed. `-N`'s own description — "disables MusicBrainz
   * lookup and ignores lack of manual metadata to continue" —
   * hints that without it, missing metadata may stop the rip.
   * If a CD rip ever hangs with no output, this is the first
   * thing to suspect; it would be the audio-path twin of
   * MakeMKV's BOXYESNO trap.
   */
  isMetadataLookupEnabled?: boolean
  /** Comma-separated encodings. Overridable only for tests. */
  outputFormat?: string
}

export const buildCyanripArgs = ({
  devPath,
  driveOffsetSamples = null,
  isMetadataLookupEnabled = true,
  outputFormat = CYANRIP_OUTPUT_FORMAT,
}: CyanripCommandInput): string[] => [
  "-d",
  devPath,
  "-o",
  outputFormat,
  // The LAST gate, and deliberately a second one: the registry
  // loader already validates, but this is the only place the
  // number becomes an argv token, and a caller that assembles
  // an offset some other way must not be able to reach `-s`
  // with a non-integer or a value no drive could have. Failing
  // here means OMITTING the flag — a rip with no offset is the
  // everyday state, a rip with a wrong one is silently
  // sample-shifted.
  ...(isValidReadOffsetSamples(driveOffsetSamples)
    ? ["-s", String(driveOffsetSamples)]
    : []),
  ...(isMetadataLookupEnabled ? [] : ["-N"]),
]

/**
 * How to invoke cyanrip, as a command VECTOR.
 *
 * Same shape and same reason as `resolveMakemkvCommand`: the
 * binary may not be on this host at all.
 *
 * ⚠️ The original reason for this indirection is **gone**. It
 * was written when the image was `node:24-bookworm-slim`, which
 * has no cyanrip, so the only way to reach one was a wrapper —
 * `RIP_DECK_CYANRIP="docker exec cyanrip cyanrip"`. The image is
 * trixie now and ships the binary, so the default bare
 * `"cyanrip"` is the live path and the wrapper is the exception.
 *
 * Kept anyway, and not as dead weight: `RIP_DECK_CYANRIP` is how
 * a rip reaches a cyanrip somewhere else — running `rip-deck`
 * outside the image, or pinning a newer build than trixie's
 * while it soaks. The kill path below only exists for that case,
 * so removing the wrapper would take a real capability with it.
 *
 * Deliberately a near-duplicate of `resolveMakemkvCommand`
 * rather than a shared helper: `ripCommand.ts` belongs to
 * another unit this session, and the two resolvers are
 * independent by design anyway — the whole point is that the two
 * binaries can live in different places. Folding them into one
 * `resolveCommandVector` is a tidy-up for whoever owns
 * `ripCommand.ts`, not a correctness fix.
 */
export type CyanripCommand = {
  command: string
  /** Args that precede cyanrip's own args, for wrappers. */
  prefixArgs: string[]
  /**
   * How to run an arbitrary command wherever cyanrip runs — the
   * wrapper with its trailing binary removed, or null when
   * cyanrip is spawned directly.
   *
   * Exists for the same measured reason as its makemkvcon twin:
   * SIGTERM to a `docker exec` client kills the client and
   * leaves the process inside the container running, so a
   * cancel would orphan a ripper still holding the drive (E5).
   */
  wrapperArgs: string[] | null
}

export const resolveCyanripCommand = (
  raw: string | undefined,
): CyanripCommand => {
  const parts = (raw ?? "cyanrip").trim().split(/\s+/)

  // The binary is always the last token, so everything before it
  // is the wrapper. A single token means no wrapper at all.
  return {
    command: parts[0],
    prefixArgs: parts.slice(1),
    wrapperArgs:
      parts.length > 1 ? parts.slice(1, -1) : null,
  }
}

export type CyanripInvocation = {
  command: string
  args: string[]
  /**
   * The `.rip-deck-incomplete-<uuid>` directory, ON THE
   * DESTINATION DATASET.
   *
   * A7 is satisfied through the working directory rather than
   * through a flag, and that is the deliberate part. cyanrip's
   * `-D` takes a NAMING SCHEME (its default is
   * `{album}{...} [{format}]`), not a destination path, and
   * whether it tolerates an absolute prefix is undocumented and
   * unverified. The cwd of a child process is not: it is ours to
   * set and it is unambiguous.
   *
   * Getting this wrong is precisely abcde's old wart, which is
   * why A7 exists at all — abcde staged WAVs in a work directory
   * inside the container, so a mid-rip kill produced zero
   * output. Writing straight to the dataset means a killed rip
   * leaves its partial output where the operator can see it,
   * which is also what D4 asks for.
   */
  cwd: string
}

/**
 * A complete, spawnable cyanrip invocation.
 *
 * ⚠️ **cyanrip's output layout is not makemkvcon's.**
 * `makemkvcon backup` writes the disc structure DIRECTLY into
 * the directory it is handed, so `finaliseDestination` can
 * rename that directory into place. cyanrip creates an album
 * directory *inside* its working directory and writes tracks
 * there — so renaming the incomplete directory would produce
 * `Album (1997)/Album [flac]/01 - ...`, one level too deep.
 * Resolve the album directory afterwards; see
 * `resolveCyanripAlbumDir`.
 */
export const buildCyanripInvocation = (input: {
  cyanrip: CyanripCommand
  incompletePath: string
  rip: CyanripCommandInput
}): CyanripInvocation => ({
  command: input.cyanrip.command,
  args: [
    ...input.cyanrip.prefixArgs,
    ...buildCyanripArgs(input.rip),
  ],
  cwd: input.incompletePath,
})

/**
 * Find the album directory cyanrip produced.
 *
 * Fails closed, returning null, on anything other than exactly
 * one directory. Zero means the rip wrote nothing — which,
 * exactly as in backup mode, is a failure that a zero exit code
 * would otherwise hide (D1, and HANDOFF §2.3's mirror image).
 * More than one means either a multi-disc set or leftovers from
 * a previous attempt in the same directory, and picking one at
 * random would file half an album under the other half's name.
 *
 * Log files are ignored: cyanrip's `-L` default writes the rip
 * log — the thing that actually records the AccurateRip and
 * EAC CRC32 results — beside the album directory rather than
 * inside it, so it is expected company and not a second album.
 */
export const resolveCyanripAlbumDir = (
  entries: readonly {
    name: string
    isDirectory: boolean
  }[],
): string | null => {
  const directories = entries.filter(
    (entry) => entry.isDirectory,
  )

  return directories.length === 1
    ? directories[0].name
    : null
}

/**
 * Args that kill our cyanrip wherever the wrapper put it.
 *
 * Matched on the DEVICE PATH, not on the job UUID and not on the
 * process name. The makemkvcon twin can match a UUID because the
 * UUID is in its output-path argument; cyanrip's UUID is only in
 * its working directory, and a working directory does not appear
 * in `/proc/<pid>/cmdline`. The device is in the argv, and one
 * drive runs at most one rip, so it identifies the process
 * exactly.
 *
 * ⚠️ **The anchors are load-bearing.** `pkill -f` takes an
 * extended regular expression matched against the whole
 * space-joined command line, so a bare `/dev/sr1` is a substring
 * of `/dev/sr10` and would kill a completely unrelated bay's
 * rip. `srN` numbering is assigned by enumeration order and is
 * not bounded by the nine physical drives, so two-digit device
 * names are a normal state, not a hypothetical.
 */
export const buildCyanripKillArgs = (input: {
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

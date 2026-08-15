import { createHash } from "node:crypto"

/**
 * The `makemkvcon` invocation, built in one place.
 *
 * Every flag here earns its place, and each one is a fix for a
 * failure we have actually seen on this tower:
 *
 *  - `-r` robot mode. The whole health engine is fed by parsed
 *    events; scraping human-readable output after the fact is
 *    requirement C3's explicit non-goal.
 *  - `--noscan` is the direct fix for the 17-minute "Scanning
 *    CD-ROM devices" hang at 0% CPU. Without it, startup probes
 *    every drive on the bus, so one wedged sibling stalls a rip
 *    that had nothing to do with it (E3).
 *
 *    ⚠️ Measured on hardware 2026-07-25: `backup` IGNORES
 *    `--noscan`. It emits `PRGT:5018 "Scanning CD-ROM devices"`
 *    and re-enumerates the whole bus regardless, because a
 *    `disc:` source is defined in terms of that enumeration.
 *    The flag is kept because it is correct and effective on
 *    the `info` paths, and costs nothing here — but it does NOT
 *    buy isolation on a rip. That comes from running the rip in
 *    a container holding one device; see `RipIsolation` below and
 *    `docs/decisions/2026-07-25-backup-takes-a-disc-index-and-scans-the-bus.md`.
 *  - `disc:` rather than `dev:` is not a choice. `backup`
 *    rejects a device source outright ("Backup source must
 *    start with \"disc:\"", exit 10), so the caller has to
 *    resolve the index first. See `discIndex.ts` — including
 *    why the result is verified against MakeMKV's own DRV table
 *    before a byte is written.
 *  - `--cache=128` bounds memory. Nine default caches would
 *    exhaust RAM on a host that is also a NAS (E4).
 *  - `--directio=true` keeps the rip out of the page cache; the
 *    destination is a ZFS dataset with its own ARC.
 *  - `--messages=-stdout --progress=-same` merges both streams
 *    onto stdout. Robot mode swallows progress entirely without
 *    `--progress=-same`, which is a silent and very confusing
 *    way to lose every PRGV event.
 *  - `backup --decrypt` is a full disc backup, never a transcode
 *    (A2). This is the default and not an override.
 */

/** Bounded MakeMKV read cache, in megabytes. */
export const RIP_CACHE_MB = 128

export type RipCommandInput = {
  /**
   * MakeMKV's disc index for the target drive.
   *
   * NOT the slot and NOT the `srN` number — a third numbering
   * again. Resolve it with `enumerateDrives` immediately before
   * the spawn; it is derived from enumeration order and shifts
   * when a drive appears or disappears.
   */
  discIndex: number
  /** The `.rip-deck-incomplete-<uuid>` directory to write into. */
  outputPath: string
  cacheMb?: number
}

export const buildRipArgs = ({
  discIndex,
  outputPath,
  cacheMb = RIP_CACHE_MB,
}: RipCommandInput): string[] => [
  "-r",
  "--noscan",
  `--cache=${cacheMb}`,
  "--directio=true",
  "--messages=-stdout",
  "--progress=-same",
  "backup",
  "--decrypt",
  `disc:${discIndex}`,
  outputPath,
]

export type MakemkvCommand = {
  command: string
  /** Args that precede the makemkvcon args, for wrappers. */
  prefixArgs: string[]
  /**
   * How to run an ARBITRARY command wherever makemkvcon runs —
   * the wrapper with its trailing binary removed. Null when
   * makemkvcon is spawned directly and there is no elsewhere.
   *
   * This exists because a wrapper usually does not forward
   * signals. Measured on Tower 2026-07-25: SIGTERM to a
   * `docker exec` client kills the client and leaves the process
   * inside the container running. So a cancel or a stall-abort
   * would kill our handle and orphan a makemkvcon still holding
   * the drive — requirement E5 failing in the exact way it was
   * written to prevent.
   *
   * Deliberately NOT modelled as "the container name". Peeling
   * the binary off the end works for `docker exec <c> makemkvcon`
   * and equally for `ssh <host> docker exec <c> makemkvcon` or
   * any other wrapper, and needs no knowledge of which flags a
   * particular wrapper takes or which of its tokens is a name.
   */
  wrapperArgs: string[] | null
}

/**
 * Resolve how to invoke makemkvcon.
 *
 * Deliberately a command VECTOR rather than a binary path,
 * because on this host makemkvcon is not installed natively —
 * it lives inside a container. Being able to set
 * `RIP_DECK_MAKEMKVCON="docker exec arm makemkvcon"` is what
 * makes the Stage 3 hardware test possible without installing
 * anything on Tower, and the same seam later takes the plain
 * in-container path once rip-deck ships as its own app (Stage 6).
 *
 * Splitting on whitespace is sufficient and intentionally dumb:
 * a path containing spaces would need quoting rules that would
 * be a bigger footgun than the case they solve.
 */
export const resolveMakemkvCommand = (
  raw: string | undefined,
): MakemkvCommand => {
  const parts = (raw ?? "makemkvcon").trim().split(/\s+/)

  // The binary is always the last token, so everything before it
  // is the wrapper. A single token means no wrapper at all.
  return {
    command: parts[0],
    prefixArgs: parts.slice(1),
    wrapperArgs:
      parts.length > 1 ? parts.slice(1, -1) : null,
  }
}

/**
 * Args that kill our makemkvcon wherever the wrapper put it.
 *
 * Matched on the job UUID rather than the process name, because
 * the UUID appears in the output-directory argument and is
 * unique to this one job. `pkill -f makemkvcon` would be a
 * disaster if we are borrowing ARM's container — ARM is ripping
 * eight other discs in there.
 *
 * Under per-rip isolation this becomes `docker exec
 * rip-deck-rip-<uuid> pkill …`, and the UUID match also catches
 * tini, whose argv is `docker-init -- makemkvcon … <uuid> …`.
 * That is harmless and mildly useful: tini forwards a TERM to
 * makemkvcon, and a KILL to tini takes the container down with
 * it, which is the outcome either way.
 *
 * `pkill` therefore has to exist in the rip image — see the
 * `procps` install in the Dockerfile, which the rip-deck image did
 * not have while it was only ever exec'd into ARM's.
 */
export const buildInnerKillArgs = (input: {
  wrapperArgs: string[]
  jobUuid: string
  signal: "TERM" | "KILL"
}): string[] => [
  ...input.wrapperArgs,
  "pkill",
  `-${input.signal}`,
  "-f",
  input.jobUuid,
]

/**
 * Per-rip device isolation.
 *
 * `backup` ignores `--noscan` and re-enumerates the whole USB bus
 * before every rip, because a `disc:` source is *defined* in
 * terms of that enumeration (measured 2026-07-25; see
 * `docs/decisions/2026-07-25-backup-takes-a-disc-index-and-scans-the-bus.md`).
 * No flag suppresses it. Two consequences, and neither is
 * acceptable at nine concurrent rips:
 *
 *  - a wedged sibling delays the START of an unrelated rip, and
 *    with nine rips each scanning nine drives that is 81 device
 *    probes fighting over one hub;
 *  - the index is a third numbering that shifts whenever any
 *    drive appears or disappears.
 *
 * So instead of asking MakeMKV not to look at the siblings, we
 * take them away: each rip runs in its own container holding a
 * single `--device /dev/srN`. The forced scan then finds exactly
 * one drive, the index is always `ISOLATED_DISC_INDEX`, and a
 * wedged sibling is structurally invisible rather than merely
 * deprioritised.
 *
 * ([decision](docs/decisions/2026-07-26-each-rip-runs-in-its-own-device-scoped-container.md))
 */

/**
 * The only disc index an isolated rip can have.
 *
 * One visible drive, so MakeMKV's enumeration is a single row and
 * that row is index 0. **Assumed, not measured** — the tower has
 * been off since this was written. It is a safe assumption to get
 * wrong: `verifyDiscIndex` compares MakeMKV's own DRV table
 * against the device we asked for and aborts `wrong_drive` before
 * a byte is written.
 */
export const ISOLATED_DISC_INDEX = 0

/**
 * Named per job, never per drive.
 *
 * Nine rips run at once and a drive can be re-ripped while its
 * previous container is still being torn down, so anything
 * derived from the slot or from `srN` would collide. `docker run
 * --name` fails outright on a duplicate, which would turn a name
 * collision into a refused rip.
 */
const CONTAINER_NAME_PREFIX = "rip-deck-rip-"

export const buildRipContainerName = (input: {
  jobUuid: string
}): string => `${CONTAINER_NAME_PREFIX}${input.jobUuid}`

export type RipIsolation = {
  /** Image carrying makemkvcon — `rip-deck:0.1.0` today. */
  image: string
  /**
   * How to reach a container runtime, as a vector: `docker`, or
   * `ssh root@tower.example.com docker` from somewhere without a
   * socket. Same shape, and same reasoning, as
   * `RIP_DECK_MAKEMKVCON`.
   */
  dockerArgs: string[]
  /**
   * Deployment-shaped `docker run` args — the bits only the
   * operator knows: the destination mount, the `/config` mount
   * that carries the MakeMKV key, `--user`, any extra `--device`.
   *
   * Deliberately opaque. rip-deck supplies exactly what only
   * rip-deck knows (which device, which container name, which
   * image, which argv) and refuses to guess at a deployment's
   * mount layout, because a wrong guess here is a rip that dies
   * on a missing key twenty minutes in.
   *
   * ⚠️ Never put `-t` here. A TTY merges stderr into stdout, and
   * stdout is parsed, not read.
   */
  extraArgs: string[]
}

/** Split a command string the same dumb way as the binary path. */
const splitTokens = (raw: string): string[] => {
  const trimmed = raw.trim()
  return trimmed === "" ? [] : trimmed.split(/\s+/)
}

/**
 * Read the isolation config out of the environment.
 *
 * Opt-in, keyed on the image name being set, because isolation
 * needs a container runtime the daemon can actually reach — a
 * `/var/run/docker.sock` mount and the `docker` CLI. A deployment
 * without those must keep working the way Stage 3 did rather than
 * fail every rip, so absence of config means "no isolation", not
 * "misconfigured".
 */
export const resolveRipIsolation = (
  env: Record<string, string | undefined>,
): RipIsolation | null => {
  const image = (
    env.RIP_DECK_RIP_ISOLATION_IMAGE ?? ""
  ).trim()

  if (image === "") return null

  const dockerArgs = splitTokens(
    env.RIP_DECK_RIP_ISOLATION_DOCKER ?? "docker",
  )

  return {
    image,
    dockerArgs:
      dockerArgs.length > 0 ? dockerArgs : ["docker"],
    extraArgs: splitTokens(
      env.RIP_DECK_RIP_ISOLATION_ARGS ?? "",
    ),
  }
}

/**
 * The command vector that runs one rip in its own container.
 *
 * Built as a `MakemkvCommand` on purpose: everything downstream —
 * the spawn, the argv hash, the kill path — already speaks that
 * shape, so isolation is a different *value* rather than a
 * different code path. `wrapperArgs` keeps its documented meaning
 * of "how to run an arbitrary command wherever makemkvcon runs",
 * which for a per-rip container is `docker exec <name>`.
 *
 * Flag by flag:
 *
 *  - `--device <devPath>` is the entire point. A container gets a
 *    minimal `/dev`, so the eight siblings do not merely rank
 *    lower in the scan — they do not exist.
 *  - `--device <scsiGenericPath>` is NOT optional, and leaving it
 *    out is the failure this comment exists to stop anyone
 *    rediscovering. **Measured on hardware 2026-07-26:** a
 *    container given only `--device /dev/sr0` answers
 *
 *      MSG:5042 "The program can't find any usable optical drives."
 *
 *    and returns a DRV table that is nothing but padding. MakeMKV
 *    talks SCSI through the generic node, so `srN` alone is a
 *    drive it can see and cannot use. Add the matching `sgN` and
 *    the same command immediately reports exactly one drive.
 *
 *    ⚠️ The number is NOT `sg0`, and is not derivable from `N`.
 *    On this host `sr0..sr8` map to `sg207..sg215`, because the
 *    NAS's own disks claim the low numbers. It has to be read per
 *    drive from `/sys/block/srN/device/scsi_generic/`, which is
 *    what `readScsiGenericPath` does — and it is resolved fresh
 *    per rip, because it renumbers on USB re-enumeration exactly
 *    like `srN` does.
 *  - `--rm`, because nine rips a batch would otherwise leave nine
 *    dead containers behind every time.
 *  - `--init` is load-bearing and easy to miss. Without it
 *    makemkvcon is PID 1, and the kernel drops signals with a
 *    default disposition sent to PID 1 — so a `SIGTERM` cancel
 *    would be silently ignored and E5 would fail in exactly the
 *    way it was written to prevent. With it, tini is PID 1 and
 *    forwards.
 *  - No `-t`. A TTY merges stderr into stdout and appends CRs to
 *    robot-mode lines that get parsed field by field.
 *  - No `-i`. stdin stays closed, matching the ripJob rule that a
 *    makemkvcon which decides to ask a question must fail fast
 *    rather than block forever holding the drive.
 */
export const buildIsolatedMakemkvCommand = (input: {
  isolation: RipIsolation
  devPath: string
  /**
   * The drive's SCSI generic node, e.g. `/dev/sg207`.
   *
   * Null only when it could not be resolved. That is a REFUSAL
   * case for the caller, not something to paper over: without it
   * the container finds zero usable drives and the rip fails
   * having written nothing.
   */
  scsiGenericPath: string | null
  jobUuid: string
}): MakemkvCommand => {
  const runtime = input.isolation.dockerArgs[0]
  const runtimeArgs = input.isolation.dockerArgs.slice(1)

  const containerName = buildRipContainerName({
    jobUuid: input.jobUuid,
  })

  return {
    command: runtime,
    prefixArgs: [
      ...runtimeArgs,
      "run",
      "--rm",
      "--init",
      "--name",
      containerName,
      "--device",
      input.devPath,
      // Both nodes or neither: srN is the drive MakeMKV can see,
      // sgN is the one it can talk to.
      ...(input.scsiGenericPath === null
        ? []
        : ["--device", input.scsiGenericPath]),
      ...input.isolation.extraArgs,
      input.isolation.image,
      "makemkvcon",
    ],
    wrapperArgs: [...runtimeArgs, "exec", containerName],
  }
}

export type RipInvocation = {
  makemkv: MakemkvCommand
  /** What to put after `disc:`. */
  discIndex: number
  isIsolated: boolean
}

/**
 * Decide how this one rip is actually invoked.
 *
 * The caller's `discIndex` was resolved against the WHOLE bus and
 * is meaningless inside a container that can see one drive, so
 * isolation replaces it rather than passing it through. Getting
 * that backwards would address `disc:5` in a container whose only
 * drive is `disc:0` — which fails loudly, but for a reason nobody
 * would guess from the message.
 */
export const buildRipInvocation = (input: {
  makemkv: MakemkvCommand
  isolation: RipIsolation | null
  devPath: string
  /** The drive's `/dev/sgN`. See `readScsiGenericPath`. */
  scsiGenericPath: string | null
  jobUuid: string
  discIndex: number
}): RipInvocation =>
  input.isolation === null
    ? {
        makemkv: input.makemkv,
        discIndex: input.discIndex,
        isIsolated: false,
      }
    : {
        makemkv: buildIsolatedMakemkvCommand({
          scsiGenericPath: input.scsiGenericPath,
          isolation: input.isolation,
          devPath: input.devPath,
          jobUuid: input.jobUuid,
        }),
        discIndex: ISOLATED_DISC_INDEX,
        isIsolated: true,
      }

/**
 * Stable hash of a full argv, for orphan adoption.
 *
 * After a daemon restart a live `makemkvcon` must be matched to
 * the job row that claims it. PID alone is not safe — PIDs are
 * reused, and adopting the wrong process would attribute a
 * stranger's output to our job. The argv hash pins it to the
 * exact device and the exact output directory, and the output
 * directory carries a UUID that is unique per job, so a match
 * cannot be a coincidence.
 */
export const hashArgv = (argv: string[]): string =>
  createHash("sha256")
    .update(argv.join("\u0000"))
    .digest("hex")
    .slice(0, 16)

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { MakemkvEvent } from "@rip-deck/contracts"
import {
  isAttachedDrive,
  parseDriveName,
} from "./drives/driveName.ts"
import {
  loadDriveRegistry,
  resolveDrive,
} from "./drives/registry.ts"
import {
  probeAllDrives,
  readScsiGenericPath,
} from "./drives/sysfs.ts"
import { parseMakemkvLine } from "./makemkv/parseLine.ts"
import {
  buildFolderName,
  checkFreeSpace,
} from "./rip/destination.ts"
import { enumerateDrives } from "./rip/discIndex.ts"
import {
  createEventLog,
  createNullEventLog,
} from "./rip/eventLog.ts"
import { identifyDisc } from "./rip/identifyDisc.ts"
import {
  buildRipArgs,
  buildRipInvocation,
  ISOLATED_DISC_INDEX,
  resolveMakemkvCommand,
  resolveRipIsolation,
} from "./rip/ripCommand.ts"
import { runRipJob } from "./rip/ripJob.ts"
import { waitForSettledMedia } from "./rip/settle.ts"

/**
 * `rip-deck` CLI — the Stage 2 observer tools.
 *
 * Both subcommands are READ-ONLY and safe to run while ARM is
 * ripping. That is the point of Stage 2: prove the identity
 * model and the robot-mode parser against the live rig at zero
 * risk, before anything of ours touches a disc.
 */

const MAKEMKVCON =
  process.env.RIP_DECK_MAKEMKVCON ?? "makemkvcon"

const REGISTRY_PATH =
  process.env.RIP_DECK_DRIVES_CONFIG ?? "config/drives.json"

/**
 * Ask MakeMKV to enumerate drives, for their firmware serials.
 *
 * This is the one place we knowingly run a full drive scan:
 * `info disc:9999` probes every drive, so a wedged unit can
 * hang it. It is therefore an explicit, occasional, opt-out
 * step — never on the 2-second sampling path, which reads only
 * sysfs. Everything else scopes to `dev:/dev/srN --noscan`.
 */
const readMakemkvDrives = async (): Promise<
  Map<string, string>
> => {
  const devPathToSerial = new Map<string, string>()

  const events = await new Promise<MakemkvEvent[]>(
    (resolve) => {
      const collected: MakemkvEvent[] = []
      const child = spawn(
        MAKEMKVCON,
        ["-r", "--cache=1", "info", "disc:9999"],
        { stdio: ["ignore", "pipe", "ignore"] },
      )

      const timeout = setTimeout(() => {
        child.kill("SIGKILL")
      }, 60_000)

      createInterface({ input: child.stdout }).on(
        "line",
        (line) => collected.push(parseMakemkvLine(line)),
      )

      child.on("error", () => {
        clearTimeout(timeout)
        resolve([])
      })
      child.on("close", () => {
        clearTimeout(timeout)
        resolve(collected)
      })
    },
  )

  for (const event of events) {
    if (event.type !== "DRV") continue
    if (!isAttachedDrive(event)) continue

    const parsed = parseDriveName(event.driveName)
    if (parsed === null) continue

    devPathToSerial.set(
      event.devicePath,
      parsed.firmwareSerial,
    )
  }

  return devPathToSerial
}

const pad = (value: string, width: number): string =>
  value.length >= width
    ? value
    : value + " ".repeat(width - value.length)

const runProbe = async (isMakemkvEnabled: boolean) => {
  const registry = await loadDriveRegistry(REGISTRY_PATH)
  const probed = await probeAllDrives()

  if (probed.length === 0) {
    console.log(
      "No optical drives present. This is a valid state — " +
        "the tower is powered independently of this service.",
    )
    return
  }

  const serialByDevPath = isMakemkvEnabled
    ? await readMakemkvDrives()
    : new Map<string, string>()

  const rows = probed.map((drive) => {
    const firmwareSerial =
      serialByDevPath.get(drive.address.devPath) ?? null

    const resolution = resolveDrive(registry, {
      usbPortPath: drive.identity.usbPortPath,
      bridgeSerial: drive.identity.bridgeSerial,
      firmwareSerial,
    })

    return { drive, firmwareSerial, resolution }
  })

  rows.sort(
    (a, b) =>
      (a.resolution.placement?.slot ?? 99) -
      (b.resolution.placement?.slot ?? 99),
  )

  console.log(
    [
      pad("SLOT", 5),
      pad("NAME", 22),
      pad("DEV", 8),
      pad("USB PORT PATH", 16),
      pad("FW SERIAL", 14),
      pad("BRIDGE", 14),
      pad("MATCHED BY", 16),
      "MEDIA",
    ].join(""),
  )

  for (const {
    drive,
    firmwareSerial,
    resolution,
  } of rows) {
    console.log(
      [
        pad(
          resolution.placement
            ? String(resolution.placement.slot)
            : "?",
          5,
        ),
        pad(
          resolution.placement?.name ?? "UNKNOWN DRIVE",
          22,
        ),
        pad(drive.address.kernelName, 8),
        pad(drive.identity.usbPortPath, 16),
        pad(firmwareSerial ?? "-", 14),
        pad(drive.identity.bridgeSerial ?? "-", 14),
        pad(resolution.matchedBy, 16),
        drive.media.hasMedia
          ? `${drive.media.discType} ` +
            `(${(
              drive.media.capacityBytes / 1024 ** 3
            ).toFixed(1)} GB)`
          : "empty",
      ].join(""),
    )

    if (resolution.isPortPathStale) {
      console.log(
        `      ^ port path moved (registry has ` +
          `${resolution.entry?.usbPortPath}). The tower has ` +
          `been re-cabled; identity was repaired from the ` +
          `firmware serial.`,
      )
    }
  }

  const unresolved = rows.filter(
    (row) => row.resolution.placement === null,
  )

  console.log(
    `\n${probed.length} drive(s) present, ` +
      `${probed.length - unresolved.length} resolved to a slot.`,
  )

  if (unresolved.length > 0) {
    console.log(
      "Unresolved drives need a config/drives.json entry " +
        "keyed on their firmware serial.",
    )
  }
}

/**
 * Replay a captured log through the parser.
 *
 * Reads stdin so it can be pointed at ARM's existing progress
 * logs — killing robot-mode parsing bugs offline, for free,
 * before we ever drive a disc ourselves.
 */
const runParse = async () => {
  const counts = new Map<string, number>()
  const malformed: string[] = []
  let lineCount = 0

  const lines = createInterface({ input: process.stdin })

  for await (const line of lines) {
    if (line.trim() === "") continue

    lineCount += 1
    const event = parseMakemkvLine(line)
    counts.set(
      event.type,
      (counts.get(event.type) ?? 0) + 1,
    )

    if (
      event.type === "MALFORMED" &&
      malformed.length < 20
    ) {
      malformed.push(`${event.reason}: ${event.raw}`)
    }
  }

  console.log(`Parsed ${lineCount} line(s).\n`)

  for (const [type, count] of [...counts].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`${pad(type, 12)}${count}`)
  }

  if (malformed.length > 0) {
    console.log("\nMalformed lines:")
    for (const entry of malformed) console.log(`  ${entry}`)
  }

  // A malformed line is a parser bug, so make it a failing
  // exit code — this command is meant to be run in CI against
  // a corpus of captured logs.
  if ((counts.get("MALFORMED") ?? 0) > 0) {
    process.exitCode = 1
  }
}

const DESTINATION_ROOT =
  process.env.RIP_DECK_DEST ??
  "/media/Disc-Rips"

const STATE_DIR =
  process.env.RIP_DECK_STATE_DIR ?? "/var/lib/rip-deck"

/**
 * The destination as makemkvcon sees it.
 *
 * Only needed while makemkvcon runs somewhere with a different
 * filesystem view — e.g. borrowing ARM's container, where our
 * /media/Disc-Rips is its /home/arm/media.
 */
const INNER_DEST = process.env.RIP_DECK_DEST_INNER

/** Read a `--flag value` pair out of the argv tail. */
const flagValue = (
  flags: string[],
  name: string,
): string | null => {
  const index = flags.indexOf(name)
  return index === -1 || index + 1 >= flags.length
    ? null
    : flags[index + 1]
}

const formatBytes = (bytes: number): string =>
  `${(bytes / 1024 ** 3).toFixed(1)} GB`

const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  return hours > 0
    ? `${hours}h ${minutes}m`
    : `${minutes}m ${Math.floor(seconds % 60)}s`
}

/**
 * `rip-deck rip` — rip the disc in ONE named slot, by hand.
 *
 * One slot because that is what "rip this disc" means, not
 * because of any limit on how many rips may run. The old refusal
 * here — "Stage 3 is bound to a single slot so ARM keeps the
 * other eight" — is gone: ARM is retired
 * ([decision](docs/decisions/2026-07-26-arm-stays-disabled.md))
 * and the owner has settled concurrency at nine
 * ([decision](docs/decisions/2026-07-26-auto-rip-every-inserted-disc-concurrently.md)).
 * Running several of these at once is now supported, and
 * `rip-deck watch` does it without being asked.
 */
const runRip = async (flags: string[]) => {
  const slotArg =
    flagValue(flags, "--slot") ??
    process.env.RIPD_DRIVES ??
    ""

  // A comma list is still refused, but for a different reason
  // than it used to be: `Number.parseInt("3,4")` is 3, so
  // honouring it would silently rip one of the two slots asked
  // for and say nothing about the other.
  if (slotArg.includes(",")) {
    console.error(
      "This command rips one slot. Pass a single --slot N, " +
        "or run `rip-deck watch`, which rips every disc you " +
        "insert without being told which.",
    )
    process.exitCode = 1
    return
  }

  const slot = Number.parseInt(slotArg, 10)
  if (!Number.isInteger(slot)) {
    console.error(
      "Which slot? Pass --slot N (or set RIPD_DRIVES=N).",
    )
    process.exitCode = 1
    return
  }

  const isDryRun = flags.includes("--dry-run")
  const makemkv = resolveMakemkvCommand(
    process.env.RIP_DECK_MAKEMKVCON,
  )

  // --- Find the drive by SLOT, never by /dev/srN. ----------
  const registry = await loadDriveRegistry(REGISTRY_PATH)
  const probed = await probeAllDrives()

  const matched = probed
    .map((drive) => ({
      drive,
      resolution: resolveDrive(registry, {
        usbPortPath: drive.identity.usbPortPath,
        bridgeSerial: drive.identity.bridgeSerial,
      }),
    }))
    .find(
      ({ resolution }) =>
        resolution.placement?.slot === slot,
    )

  if (matched === undefined) {
    console.error(
      `No drive in slot ${slot}. ` +
        `${probed.length} drive(s) are present — is the tower ` +
        `powered on?`,
    )
    process.exitCode = 1
    return
  }

  const { drive, resolution } = matched
  const devPath = drive.address.devPath
  const name = resolution.placement?.name ?? `slot ${slot}`

  console.log(`Slot ${slot}: ${name} (${devPath})`)

  // --- Three-layer settle. ---------------------------------
  console.log("Waiting for the disc to settle…")
  const settled = await waitForSettledMedia({
    kernelName: drive.address.kernelName,
  })

  if (settled.kind === "no_media") {
    console.error("No disc in that drive.")
    process.exitCode = 1
    return
  }

  if (settled.kind === "timed_out") {
    // NEVER eject. The eject loop is what caused the flap-storm
    // that killed valid rips in other bays (B3/E8).
    console.error(
      "The disc never settled — its reported size kept " +
        "changing. Leaving it in the drive for a human to " +
        "look at; it is NOT being ejected.",
    )
    process.exitCode = 1
    return
  }

  console.log(
    `Disc: ${settled.discType}, ` +
      `${formatBytes(settled.capacityBytes)}`,
  )

  // --- Identify, fail closed. ------------------------------
  const explicitName = flagValue(flags, "--name")
  const identified =
    explicitName === null
      ? await identifyDisc({ devPath, makemkv })
      : { discName: explicitName, spawnFailure: null }

  if (identified.spawnFailure !== null) {
    console.error(
      "Could not run makemkvcon to identify this disc — " +
        `${identified.spawnFailure}. The disc was never read, ` +
        "so this is a deployment fault, not a disc fault: --name " +
        "will not help. Check that the binary is on PATH.",
    )
    process.exitCode = 1
    return
  }

  if (identified.discName === null) {
    console.error(
      "Could not read a name off this disc, and none was " +
        'given. Refusing to invent one — pass --name "…" or ' +
        "leave it for identification. The disc stays in the " +
        "drive.",
    )
    process.exitCode = 1
    return
  }

  // --- Resolve the disc index. -----------------------------
  // `backup` refuses a `dev:` source, so the rip has to be
  // addressed by MakeMKV's own index. Resolved as late as
  // possible, because it is enumeration-order derived; ripJob
  // re-checks it against MakeMKV's DRV table before writing.
  //
  // …UNLESS the rip is isolated, in which case this scan is both
  // pointless and harmful. Pointless because a container that can
  // see one drive always numbers it `disc:0`, so an index
  // resolved against the whole bus describes a bus the rip will
  // never see. Harmful because `info disc:9999` IS the full bus
  // scan that hung for seventeen minutes at 0% CPU on a wedged
  // sibling — so leaving it here would isolate the rip itself
  // while keeping the wedged-sibling delay on the START of every
  // rip, which is the half of §2.2 that isolation is supposed to
  // close.
  //
  // That matters most at nine concurrent rips: nine pre-scans of
  // a bus where any one wedged drive stalls all nine starts.
  const isolation = resolveRipIsolation(process.env)
  const discIndex =
    isolation === null
      ? (
          await enumerateDrives({ makemkv })
        ).indexByDevPath.get(devPath)
      : ISOLATED_DISC_INDEX

  if (discIndex === undefined) {
    console.error(
      `MakeMKV does not list ${devPath}. It is in sysfs but ` +
        `not on MakeMKV's bus scan — the drive is present and ` +
        `not usable, so the disc stays put.`,
    )
    process.exitCode = 1
    return
  }

  console.log(
    isolation === null
      ? `MakeMKV index: disc:${discIndex}`
      : `MakeMKV index: disc:${discIndex} (isolated — no bus ` +
          `scan; ripJob still verifies it against the DRV table)`,
  )

  const folderName = buildFolderName({
    title: identified.discName,
    year: null,
    discType: settled.discType,
    // `rip-deck rip` is the same makemkvcon backup path as the
    // watcher's, so it earns the same marker.
    isDiscBackup: true,
  })

  const space = await checkFreeSpace({
    rootPath: DESTINATION_ROOT,
    discBytes: settled.capacityBytes,
  })

  console.log(`Name: ${folderName}`)
  console.log(
    `Space: ${formatBytes(space.freeBytes)} free, ` +
      `${formatBytes(space.requiredBytes)} required`,
  )

  const jobUuid = randomUUID()

  if (isDryRun) {
    // Build the REAL invocation rather than re-deriving a
    // plausible one: under isolation the command is a `docker
    // run` wrapping makemkvcon, and a dry run that prints the
    // unisolated form would be confidently wrong about the one
    // thing it exists to show.
    const invocation = buildRipInvocation({
      makemkv,
      scsiGenericPath: await readScsiGenericPath(
        drive.address.kernelName,
      ),
      isolation,
      devPath,
      jobUuid,
      discIndex,
    })

    console.log(
      "\nDry run — this is the command that would run:\n" +
        `  ${invocation.makemkv.command} ` +
        [
          ...invocation.makemkv.prefixArgs,
          ...buildRipArgs({
            discIndex: invocation.discIndex,
            outputPath:
              `${INNER_DEST ?? DESTINATION_ROOT}` +
              `/.rip-deck-incomplete-${jobUuid}`,
          }),
        ].join(" "),
    )
    return
  }

  if (!space.hasEnoughSpace) {
    console.error(
      "Not enough free space. Refusing to start.",
    )
    process.exitCode = 1
    return
  }

  // --- Rip. ------------------------------------------------
  // Ctrl-C cancels cleanly rather than orphaning makemkvcon,
  // which is requirement E5 in its smallest form.
  const controller = new AbortController()
  process.once("SIGINT", () => {
    console.log("\nCancelling…")
    controller.abort()
  })

  // Capture the raw stream by default. The first real rip had to
  // be repeated purely because nobody could see what makemkvcon
  // actually said, and the corpus is worth having anyway.
  const eventLogPath =
    flagValue(flags, "--event-log") ??
    `${STATE_DIR}/${jobUuid}.robot.log`

  const eventLog = flags.includes("--no-event-log")
    ? createNullEventLog()
    : await createEventLog({ path: eventLogPath }).catch(
        () => createNullEventLog(),
      )

  console.log(`Raw capture: ${eventLogPath}`)

  const startedAt = Date.now()
  let lastPrintAt = 0

  const result = await runRipJob(
    {
      driveId: drive.identity.usbPortPath,
      devPath,
      discIndex,
      jobUuid,
      discBytes: settled.capacityBytes,
      destinationRoot: DESTINATION_ROOT,
      innerDestinationRoot: INNER_DEST,
      folderName,
      stateDir: STATE_DIR,
      makemkv,
      isolation,
      eventLog,
      signal: controller.signal,
    },
    {
      onSpawn: (claim) =>
        console.log(
          `makemkvcon pid ${claim.pid} -> ` +
            `${claim.incompletePath}`,
        ),

      onProgress: (progress) => {
        const now = Date.now()
        if (now - lastPrintAt < 2_000) return
        lastPrintAt = now

        const percent = (
          progress.totalFraction * 100
        ).toFixed(1)
        const rate =
          progress.throughputBytesPerSec === null
            ? "—"
            : `${(
                progress.throughputBytesPerSec / 1024 ** 2
              ).toFixed(1)} MB/s`
        const eta =
          progress.etaSeconds === null
            ? "—"
            : formatDuration(progress.etaSeconds)
        const trend =
          progress.etaTrend === "rising"
            ? " (ETA RISING)"
            : ""

        console.log(
          `${percent}%  ${rate}  ETA ${eta}${trend}  ` +
            `${progress.currentLabel ?? ""}`,
        )
      },

      onLiveness: (liveness) => {
        if (liveness.action === "continue") return
        console.warn(
          `[${liveness.action}] ${liveness.kind}: ` +
            liveness.reason,
        )
      },
    },
  )

  // --- Report honestly. ------------------------------------
  const elapsed = (Date.now() - startedAt) / 1000
  console.log(`\nFinished in ${formatDuration(elapsed)}.`)
  console.log(
    `exit=${result.exitCode} ` +
      `titlesSaved=${result.titlesSaved} ` +
      `readErrors=${result.readErrorCount}`,
  )

  if (result.isSuccessful) {
    console.log(`SUCCESS -> ${result.destinationPath}`)

    if (result.hasCollision) {
      console.warn(
        "That name already existed, so this rip landed beside " +
          "it under a marked name. Nothing was overwritten — " +
          "decide which copy to keep.",
      )
    }

    return
  }

  // Exit code 0 with a failure reason is the whole point of this
  // project, so say so out loud rather than printing a bare
  // "failed" that reads like a crash.
  console.error(`FAILED: ${result.failureReason}`)

  if (result.exitCode === 0) {
    console.error(
      "Note that makemkvcon exited 0. This is exactly the " +
        "silent-success case ARM reports as a completed rip.",
    )
  }

  if (result.wrongDriveDevPath !== null) {
    console.error(
      `MakeMKV opened ${result.wrongDriveDevPath} for ` +
        `disc:${discIndex}, but slot ${slot} is ${devPath}. ` +
        "The bus renumbered mid-flight, so this was stopped " +
        "before it wrote anything. Re-run it.",
    )
  }

  if (result.observations.interactivePrompt !== null) {
    console.error(
      `It was waiting for an answer to: ` +
        `"${result.observations.interactivePrompt}"`,
    )
  }

  if (result.stderr.trim() !== "") {
    console.error(`stderr:\n${result.stderr.trim()}`)
  }

  if (result.incompletePath !== null) {
    console.error(
      `Partial output KEPT at ${result.incompletePath} — ` +
        "delete it yourself if you are giving up on this disc.",
    )
  }

  process.exitCode = 1
}

const main = async () => {
  const [command, ...flags] = process.argv.slice(2)

  switch (command) {
    case "probe":
      await runProbe(!flags.includes("--no-makemkv"))
      break

    case "parse":
      await runParse()
      break

    case "rip":
      await runRip(flags)
      break

    case "watch":
      // A dynamic import because `main.ts` IS the daemon — it runs
      // on import, which is also how `yarn dev` starts it. Importing
      // it statically would start a watcher every time anyone ran
      // `rip-deck probe`.
      await import("./main.ts")
      break

    default:
      console.log(
        "Usage:\n" +
          "  rip-deck probe [--no-makemkv]   " +
          "drive identity table\n" +
          "  rip-deck parse < capture.log    " +
          "replay robot-mode output\n" +
          "  rip-deck rip --slot N [--name X] [--dry-run]\n" +
          "                     [--event-log PATH | --no-event-log]\n" +
          "                                 " +
          "rip the disc in one slot\n" +
          "  rip-deck watch [--max N] [--poll-interval MS]\n" +
          "                                 " +
          "rip every disc that gets inserted",
      )
      process.exitCode = 1
  }
}

await main()

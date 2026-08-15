import { basename, extname } from "node:path"
import {
  type ApiServer,
  createApiServer,
  readApiPort,
} from "./api/server.ts"
import { createTowerStore } from "./api/snapshot.ts"
import { createTowerFeed } from "./api/towerFeed.ts"
import type { WebAssets } from "./api/webAssets.ts"
import { createTopicConfig } from "./mqtt/config.ts"
import { createWatchMqtt } from "./mqtt/watchMqtt.ts"
import {
  createGovernor,
  resolveRipConcurrency,
} from "./rip/governor.ts"
import {
  type BayOutcome,
  createWatcherConfig,
  type RunningWatcher,
  startWatcher,
  WATCHER_TUNING,
  type WatcherInput,
} from "./rip/watcher.ts"

/**
 * `rip-deck watch` — the daemon that makes a disc rip itself.
 *
 * The owner's requirement, verbatim: *"I want it to rip as many
 * discs as I insert. If I insert 9 discs, start 9 rips of the
 * correct type."*
 * ([decision](docs/decisions/2026-07-26-auto-rip-every-inserted-disc-concurrently.md))
 *
 * This module is the console and the process wiring, and nothing
 * else. Every decision lives in `rip/watcher.ts` (which bay, which
 * ripper, and above all when NOT to) and `rip/governor.ts` (how
 * many at once), both of which are testable without a drive.
 *
 * It runs on import — but only when it was imported in order to
 * BE the daemon, which is what `isWatchInvocation` decides. Both
 * `yarn dev` (`tsx packages/daemon/src/main.ts`) and
 * `rip-deck watch` (a dynamic import from `cli.ts`) come in that
 * way; a test importing it does not.
 *
 * ## What the output is for
 *
 * Nine rips run for hours with nobody watching, so every line here
 * is written to be read afterwards, in a log, by someone asking
 * "what happened to bay 4". That means bays are named by SLOT,
 * never by `/dev/srN` — the slot is the thing with a disc in it,
 * and `srN` reshuffles on every USB re-enumeration.
 */

const readFlag = (
  flags: string[],
  name: string,
): string | null => {
  const index = flags.indexOf(name)
  return index === -1 || index + 1 >= flags.length
    ? null
    : flags[index + 1]
}

const bayLabel = (input: {
  slot: number | null
  name: string
}): string =>
  input.slot === null
    ? `[${input.name}]`
    : `[slot ${input.slot} · ${input.name}]`

const outcomeLine = (outcome: BayOutcome): string => {
  switch (outcome.kind) {
    case "completed":
      return `DONE -> ${outcome.detail}`
    case "failed":
      return `FAILED: ${outcome.detail}`
    case "needs_attention":
      // Said out loud every time, because the disc is still in the
      // drive and a reader who does not know that will go looking
      // for it on the floor. Auto-rip never ejects; the operator's
      // MQTT command does, and did not run here.
      return (
        `NEEDS ATTENTION: ${outcome.detail} ` +
        "(the disc has NOT been ejected)"
      )
    case "no_media":
      return `nothing to do: ${outcome.detail}`
  }
}

/**
 * Every interface, because the dashboard is not in here.
 *
 * The daemon runs in a container and the ARM viewer runs
 * somewhere else entirely, so binding loopback would serve the
 * document to nobody.
 */
const API_BIND_HOST = "0.0.0.0"

/**
 * Bring the JSON API up, and never let it take a rip with it.
 *
 * A rip must not depend on the API being up. `docs/mqtt.md` says
 * the same thing about the broker and for the same reason: the
 * thing this daemon exists to do is move bytes off a disc, and a
 * port already in use — a second `rip-deck watch`, or the old ARM
 * viewer still holding 3007 — is not a reason to stop doing it.
 * So a bind failure is a warning line and nothing else.
 *
 * Exported for its test. The failure path is the half that
 * matters and is the half nobody would exercise by hand.
 */
export const startApiServer = async (input: {
  server: Pick<ApiServer, "listen" | "close">
  /**
   * What the dashboard build left behind, if anything. Said out
   * loud because "0 files" is the difference between a UI and a
   * plain-text apology, and the owner should not have to open a
   * browser to find that out.
   */
  webAssets?: Pick<WebAssets, "fileCount">
  log?: (message: string) => void
  warn?: (message: string) => void
}): Promise<{ close: () => Promise<void> }> => {
  const log = input.log ?? console.log
  const warn = input.warn ?? console.warn

  try {
    const { port } = await input.server.listen()

    log(
      `JSON API: http://${API_BIND_HOST}:${port}/json ` +
        `(also /health, /logs?job=<job_uuid>, and ` +
        `/json?fake=nine-rips for the UI fixtures)`,
    )

    log(
      (input.webAssets?.fileCount ?? 0) > 0
        ? `Dashboard: http://${API_BIND_HOST}:${port}/`
        : `Dashboard: NOT BUILT into this image — GET / says ` +
            `how to fix it. The JSON API above is unaffected.`,
    )

    return { close: input.server.close }
  } catch (error) {
    warn(
      `\nJSON API: NOT SERVED — ` +
        `${error instanceof Error ? error.message : String(error)}.\n` +
        `Ripping is unaffected; the dashboard has nothing to ` +
        `read until this is fixed.\n`,
    )

    // Nothing was bound, so there is nothing to close: `close()`
    // on a server that never listened rejects with
    // ERR_SERVER_NOT_RUNNING, and a shutdown path that throws
    // would strand the rips it was cancelling.
    return { close: () => Promise.resolve() }
  }
}

export const runWatch = async (
  flags: string[],
): Promise<void> => {
  const config = createWatcherConfig(process.env)

  const concurrency = resolveRipConcurrency({
    ...process.env,
    // A `--max N` on the command line is the same kind of
    // statement as the environment variable, so it goes through
    // the same resolver — including the isolation clamp, which no
    // flag may switch off.
    RIP_DECK_MAX_CONCURRENT_RIPS:
      readFlag(flags, "--max") ??
      process.env.RIP_DECK_MAX_CONCURRENT_RIPS,
  })

  const governor = createGovernor({
    maxConcurrentRips: concurrency.maxConcurrentRips,
  })

  const pollIntervalMs =
    Number.parseInt(
      readFlag(flags, "--poll-interval") ?? "",
      10,
    ) || WATCHER_TUNING.pollIntervalMs

  console.log(
    `rip-deck watch — every disc you insert gets ripped, up ` +
      `to ${governor.maxConcurrentRips} at a time.`,
  )
  console.log(`Destination: ${config.destinationRoot}`)
  console.log(
    `Per-rip device isolation: ` +
      (config.isolation === null
        ? "OFF (RIP_DECK_RIP_ISOLATION_IMAGE unset)"
        : `on, via ${config.isolation.image}`),
  )

  if (concurrency.clampReason !== null) {
    console.warn(`\n${concurrency.clampReason}\n`)
  }

  console.log(
    `Polling sysfs every ${pollIntervalMs}ms. Auto-rip never ` +
      `ejects: a disc that fails to settle, fails to identify ` +
      `or has no ripper stays in its drive and is flagged. ` +
      `Trays move only when an operator says so — the button ` +
      `over MQTT (${createTopicConfig(process.env).base}` +
      `/cmd/drive), or the dashboard over POST /api/tray. Both ` +
      `land in the same command path, and both refuse a bay ` +
      `that is ripping.`,
  )

  console.log(
    `Bay memory: ${config.stateDir}/bays.json — a disc already ` +
      `in a drive at startup is HELD, not re-ripped, unless ` +
      `that file says it was finished with.`,
  )

  // The API's whole state, and the reason `readSnapshot` can be
  // a pure memory read: the watcher already knows when something
  // changed, so the API never has to go and ask a drive. A
  // synchronous device call on the request path would let one
  // wedged drive freeze the dashboard for all nine bays.
  const store = createTowerStore()

  // The API is brought up BEFORE the watcher exists, deliberately
  // — a port already in use should be reported before nine bays
  // start moving — so the tray runner cannot be passed by value.
  // It is read per request instead: a `POST /api/tray` landing in
  // that startup window answers 503 rather than 500.
  //
  // `watcher.runTrayCommand` and nothing else. The API has no
  // business reading the bay table or stopping rips, and a narrow
  // handoff is one that cannot grow into either.
  let runningWatcher: RunningWatcher | null = null

  // Constructed before `startApiServer` rather than inline, so
  // the dashboard's files are already in memory and countable by
  // the time there is a line to print about them.
  const apiServer = createApiServer({
    // Fold the watcher's own loaded-discs summary into every live
    // snapshot, so `/json` shows what MQTT publishes — phantoms
    // from the on-disk ledger included — rather than recomputing it
    // from a bay table a restart against a dark tower starts empty
    // ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
    // Read per request, like `readTrayRunner`, because the API is
    // up before the watcher exists; until then the store's own
    // (empty) fold stands.
    readSnapshot: () =>
      runningWatcher === null
        ? store.readSnapshot()
        : {
            ...store.readSnapshot(),
            loadedDiscs: runningWatcher.getLoadedDiscs(),
          },
    port: readApiPort(process.env),
    host: API_BIND_HOST,
    topicConfig: createTopicConfig(process.env),
    readTrayRunner: () =>
      runningWatcher === null
        ? null
        : runningWatcher.runTrayCommand,
    // The watcher's own directory, passed rather than re-read
    // from the environment, so `/logs` can never look somewhere
    // the captures are not.
    stateDir: config.stateDir,
  })

  const api = await startApiServer({
    server: apiServer,
    webAssets: apiServer.webAssets,
  })

  console.log("Ctrl-C cancels every running rip.\n")

  const lastProgressAtMs = new Map<string, number>()

  // MQTT is an output, never a gate — see `mqtt/watchMqtt.ts`.
  // With no broker configured, or with one that refuses us, this
  // publishes nothing and every bay rips exactly as before.
  const mqtt = createWatchMqtt()

  // The console handlers go THROUGH the feed, which writes the
  // store first and prints second. Nine bays' worth of state
  // lives in `api/towerFeed.ts` rather than here because it is a
  // state machine, not formatting — and because everything in
  // this file that is not formatting has to be startable to be
  // tested.
  const feed = createTowerFeed({
    store,
    handlers: {
      onNote: (message) => console.log(message),

      onBayNote: (event) =>
        console.log(`${bayLabel(event)} ${event.message}`),

      onBayOutcome: (event) =>
        console.log(
          `${bayLabel(event)} ${outcomeLine(event.outcome)}`,
        ),

      onBayProgress: (event) => {
        // Nine rips at two events a second would make the log
        // unreadable and hide everything that matters in it.
        const now = Date.now()
        const last =
          lastProgressAtMs.get(event.driveId) ?? 0
        if (now - last < 30_000) return
        lastProgressAtMs.set(event.driveId, now)

        const percent = (
          event.progress.totalFraction * 100
        ).toFixed(1)

        // MB/s, not GB/s: the two real rips ran at 15–23 MB/s, so
        // a GB/s figure would read "0.0" for the whole disc.
        const rate =
          event.progress.throughputBytesPerSec === null
            ? "—"
            : `${(
                event.progress.throughputBytesPerSec /
                  1024 ** 2
              ).toFixed(1)} MB/s`

        console.log(
          `${bayLabel(event)} ${percent}%  ${rate}  ` +
            `${event.progress.currentLabel ?? ""}`,
        )
      },
    },
  })

  const watcherInput: WatcherInput = {
    config,
    governor,
    pollIntervalMs,
    isKeepingProcessAlive: true,
    handlers: feed.handlers,
  }

  // MQTT wraps the feed rather than replacing it, so one event
  // reaches the store, the console AND the broker.
  const watcher = startWatcher(
    mqtt.withPublishing(watcherInput),
  )

  // From here `POST /api/tray` reaches the same
  // `runTrayCommand` the physical button reaches through
  // `cmd/drive`. One command path to a drive, two callers.
  runningWatcher = watcher

  // Immediately after `startWatcher` and before anything can
  // await, so no event can reach the feed while the watcher's
  // bay table is still unreadable to it. This MUST stay above the
  // `mqtt.start` await below.
  feed.attachWatcher({
    getBays: watcher.getBays,
    getSightings: watcher.getBaySightings,
    getUsbStability: watcher.getUsbStability,
  })

  // Never awaited before the watcher exists and never allowed to
  // throw: a broker that refuses us costs the announcements and
  // nothing else.
  await mqtt.start({ watcher })

  // `setMqttEnabled` was one more store setter with no caller:
  // `/json` reported `is_mqtt_enabled: false` in the same second
  // the log said `[mqtt] connected to mqtts://…`. Read AFTER
  // `start`, which is the only thing that can answer it.
  store.setMqttEnabled({
    isMqttEnabled: mqtt.isEnabled(),
  })

  // Poll once immediately rather than waiting out the first
  // interval: a daemon restarted while the tower is loaded should
  // pick the discs up now, not in five seconds.
  await watcher.tickNow()

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      console.log(
        `\n${signal} — cancelling every running rip. ` +
          `Partial output is KEPT.`,
      )

      // Never awaited from inside the signal handler: a second
      // Ctrl-C must still reach the process rather than queue
      // behind a rip that is refusing to die.
      void watcher.stop().then(() => resolve())
    }

    process.once("SIGINT", () => shutdown("SIGINT"))
    process.once("SIGTERM", () => shutdown("SIGTERM"))
  })

  // After the rips, so the retained `offline` availability is the
  // last thing Home Assistant hears: an unavailable "0 active
  // rips" must never read as an idle tower.
  await mqtt.stop()

  // After the rips have landed, and not optional: a listening
  // `node:http` server is a REF'D handle, so leaving it open
  // would mean `rip-deck watch` never exits after Ctrl-C — the
  // same class of bug `rip/unrefTimers.ts` exists for. Node
  // closes idle keep-alive sockets on `close()`, and no handler
  // here holds a response open, so this cannot hang.
  await api.close()

  console.log("Stopped.")
}

/**
 * Was this module loaded in order to BE the daemon?
 *
 * Two ways in, and both have to work:
 *
 *  - `tsx packages/daemon/src/main.ts`, which is what `yarn dev`
 *    runs. Here this file is the process entry.
 *  - `rip-deck watch`, which reaches it through `await import()`
 *    from `cli.ts` precisely so that a `rip-deck probe` does not
 *    start a watcher. Here the entry is `cli.ts` and the giveaway
 *    is the subcommand.
 *
 * A test importing this file is neither, and must not find itself
 * supervising nine bays — which is the whole reason this is a
 * predicate rather than an unconditional call at the bottom of the
 * file.
 */
export const isWatchInvocation = (
  argv: readonly string[],
): boolean => {
  // The extension is stripped so this holds for BOTH the dev entry
  // (`tsx …/main.ts`) and the deployed one (`node …/cli.js`, the
  // esbuild bundle). Keying on `.ts` alone silently failed to start
  // the watcher the moment the image ran compiled JS — the process
  // exited 0 with the tower unwatched.
  const entry =
    argv[1] === undefined
      ? ""
      : basename(argv[1], extname(argv[1]))

  // The entry file is checked in BOTH cases, and in the second
  // one it is what makes the test safe: `npx vitest watch` also
  // has "watch" at argv[2], and matching that alone would start a
  // nine-bay daemon in the middle of a test run.
  return (
    entry === "main" ||
    (entry === "cli" && argv[2] === "watch")
  )
}

if (isWatchInvocation(process.argv)) {
  const flags = process.argv.slice(2)

  await runWatch(
    flags[0] === "watch" ? flags.slice(1) : flags,
  )
}

import {
  EMPTY_PROGRESS,
  type Job,
  type JobProgress,
  type JobState,
  makeVerdict,
  type Verdict,
} from "@rip-deck/contracts"
import {
  catchError,
  defer,
  EMPTY,
  exhaustMap,
  type Subscription,
} from "rxjs"
import {
  type DriveRegistry,
  loadDriveRegistry,
} from "../drives/registry.ts"
import {
  buildLoadedDiscsPayload,
  shouldPublishLoadedDiscs,
} from "../rip/loadedDiscs.ts"
import {
  buildTrayCommandRejection,
  parseTrayCommand,
} from "../rip/trayCommand.ts"
import { unrefInterval } from "../rip/unrefTimers.ts"
import type {
  BayDiscIdentity,
  BayOutcome,
  BayState,
  RunningWatcher,
  WatcherHandlers,
  WatcherInput,
} from "../rip/watcher.ts"
import {
  ACTIVITY_TUNING,
  type ActivityMemory,
  buildActivityPayload,
  createActivityMemory,
  foldActivity,
  summariseBayActivity,
} from "./activity.ts"
import {
  createRipDeckMqtt,
  type RipDeckMqtt,
} from "./bridge.ts"
import {
  bayDiscoveryObjectId,
  type DiscoveryDrive,
} from "./discovery.ts"
import {
  buildDriveDiscState,
  type DriveDiscState,
} from "./driveState.ts"

/**
 * The wiring: `rip-deck watch` -> MQTT.
 *
 * Everything under `mqtt/` was built, unit-tested against a fake
 * broker, and then **never called**. This module is the caller.
 * It exists as its own file rather than as code in `main.ts`
 * because `main.ts` is the console and the process wiring and
 * nothing else, and because every rule below is worth stating
 * where it can be tested.
 *
 * ## The rule that outranks the feature
 *
 * **A rip must never depend on a broker being up.** Not "should
 * not" — an unreachable Mosquitto, a rejected password, an
 * expired certificate and an unset `RIP_DECK_MQTT_URL` all have
 * the same consequence here: publishing is disabled and nine bays
 * keep ripping. `createMqttPublisher` already returns a no-op
 * publisher when there is no URL, but it **throws** when a
 * configured broker refuses the connection, and that throw is
 * what would otherwise take the daemon down at startup. So
 * `start()` catches, says so once on the console, and carries on
 * with publishing off.
 *
 * The same rule applies per message: every publish is fired and
 * forgotten through `safely`, so a broker that goes away
 * mid-session costs a message, never a rip.
 *
 * ## Why it reads bays on a timer instead of on every event
 *
 * The retained topics (`drive/<slug>`, `activity`) describe
 * state, and state is what `watcher.getBays()` holds. The
 * handlers only carry news — a note, a progress tick, an
 * outcome — and a bay that is quietly idle produces none of it,
 * so an event-only design would never publish the nine idle bays
 * that the power-off automation has to be able to see.
 *
 * The sweep publishes only what changed (plus a heartbeat), so
 * nine idle bays cost one retained message a minute, not
 * 108.
 *
 * ## Inbound tray commands
 *
 * `<base>/cmd/drive` was documented and unsubscribed for a
 * release, because the watcher had no command surface to route
 * one to. It has one now — `runTrayCommand` — so this module
 * subscribes, hands the payload to `parseTrayCommand`, and
 * publishes the per-bay report on `<base>/resp/drive`.
 *
 * **Every inbound message gets a reply**, including one we could
 * not parse. An operator who presses a button and hears nothing
 * cannot tell a broken button from a broken daemon, and that is
 * the failure this whole surface exists to avoid.
 *
 * ## What it does NOT do
 *
 *  - **No health verdicts.** The watcher does not run the health
 *    engine, so a completed rip publishes `ok` (the documented
 *    default verdict, which requires no evidence) and a failed
 *    one publishes `unknown`. Neither is ever `confirmed`, so
 *    `publishDriveAlert` and `publishLivenessAlert` stay silent
 *    rather than announcing a verdict nothing measured.
 */

export type WatchMqtt = {
  /** True once a real broker connection exists. */
  isEnabled: () => boolean
  /**
   * Wrap a `startWatcher` input so its handlers also publish.
   *
   * Takes and returns the whole input rather than just the
   * handlers so that the call site stays one expression wrapped
   * around an object literal nobody has to restructure.
   */
  withPublishing: (input: WatcherInput) => WatcherInput
  start: (params: {
    watcher: RunningWatcher
  }) => Promise<void>
  stop: () => Promise<void>
}

/** What we have learned about one bay from the event stream. */
type BayView = {
  slot: number | null
  /**
   * The bay's house label, ALREADY slot-prefixed —
   * `07 - Pioneer BDR-211M`.
   *
   * It arrives that way from the registry, which is where every
   * writer of this field gets it (`config/drives.json` spells
   * the prefix out, and `DrivePlacement.name` documents the
   * shape). So NOTHING here may add the prefix again: doing so
   * is what published `"06 - 06 - Pioneer BDR-211M"` to fifteen
   * retained topics and read it aloud on the house speakers.
   */
  name: string
  identity: BayDiscIdentity | null
  progress: JobProgress | null
  jobUuid: string | null
  outcome: BayOutcome | null
  /** Fingerprint of the last drive-state message we published. */
  publishedFingerprint: string | null
}

const createBayView = (input: {
  slot: number | null
  name: string
}): BayView => ({
  slot: input.slot,
  name: input.name,
  identity: null,
  progress: null,
  jobUuid: null,
  outcome: null,
  publishedFingerprint: null,
})

/**
 * A bay's phase, as a job state.
 *
 * `starting` covers settle + type + identify, which is
 * `identifying` in job terms; there is no job-state word for
 * "about to look at a disc". A `done` bay we have no outcome for
 * reads idle rather than guessing — that only happens for a bay
 * that finished before this module was listening.
 */
export const jobStateForBay = (input: {
  bay: BayState
  outcome: BayOutcome | null
}): JobState | null => {
  switch (input.bay.phase) {
    case "idle":
      return null
    case "starting":
      return "identifying"
    case "ripping":
      return "ripping"
    case "quarantined":
      return "needs_attention"
    case "done":
      switch (input.outcome?.kind) {
        case "completed":
          return "completed"
        case "failed":
          return "failed"
        case "needs_attention":
          return "needs_attention"
        default:
          return null
      }
  }
}

/**
 * The verdict a watcher-driven rip is allowed to claim.
 *
 * `ok` is the default verdict and needs no evidence; anything
 * worse does, and the watcher has none — it knows the rip ended
 * badly, not why. So a failure is `unknown` with the outcome text
 * as its evidence, never a named fault. Confidence is
 * `suspected` throughout, which is exactly what keeps
 * `isAnnounceable` from letting any of this reach the house
 * speakers as a drive alert.
 */
export const verdictForOutcome = (
  outcome: BayOutcome | null,
): Verdict =>
  outcome === null || outcome.kind === "completed"
    ? makeVerdict("ok", "suspected", [])
    : makeVerdict("unknown", "suspected", [outcome.detail])

/**
 * The `Job` the retained drive-state payload is built from.
 *
 * Synthesised rather than real: `rip-deck watch` has no job store,
 * and `buildDriveStatePayload` wants the shape the API's jobs
 * have. Two fields are honestly unknown here and say so —
 * `readErrorCount` is 0 because the watcher never sees the
 * counter, and `startedAt` is the bay's last transition rather
 * than the rip's true start.
 */
export const buildBayJob = (input: {
  bay: BayState
  view: BayView
  state: JobState
}): Job => ({
  id: input.bay.jobUuid ?? input.view.jobUuid ?? "",
  driveId: input.bay.driveId,
  state: input.state,
  startedAt: input.bay.updatedAtMs,
  finishedAt: null,
  identity:
    input.view.identity === null
      ? null
      : {
          title: input.view.identity.title,
          year: null,
          discType: input.view.identity.discType,
          // The title came off the disc itself, not a metadata
          // lookup — `rip-deck watch` does not do one. `manual`
          // claimed a human typed it, which is the one thing
          // that did not happen; `disc` is `identifyDisc`'s read
          // of the volume label, and this field IS the trust
          // trail.
          source: "disc",
          posterUrl: null,
          volumeLabel: input.view.identity.title,
          discNumber: null,
          discTotal: null,
        },
  progress: input.view.progress ?? EMPTY_PROGRESS,
  verdict: verdictForOutcome(input.view.outcome),
  failureReason: null,
  // A field on the bay, written by the ripper's publish step and
  // kept across a restart — never parsed back out of the
  // completion sentence. Null on the outcome path, where the bay
  // is synthesised from an event that does not carry it.
  destinationPath: input.bay.destinationPath,
  readErrorCount: 0,
  // Also straight off the bay: a bay this process adopted at
  // startup is one whose rip belongs to the daemon before it,
  // and hardcoding false here told the opposite story.
  isAdopted: input.bay.isAdopted,
  isKeepTryingRequested: false,
})

/**
 * What has to change before a bay is worth republishing.
 *
 * Deliberately not the payload itself: that carries `updated_at`,
 * which differs on every build, so comparing payloads would
 * republish nine retained messages every five seconds forever.
 *
 * The tray half is in here for a reason that is invisible
 * without it: taking a finished disc out moves a bay from
 * `done`-with-a-disc to `idle`-with-none, and BOTH publish
 * `state: "idle"`. On the job half alone the fingerprint would
 * not move, so the retained topic would keep claiming a disc is
 * loaded for as long as the daemon runs.
 */
export const driveStateFingerprint = (input: {
  state: JobState | null
  jobId: string
  title: string | null
  progressPercent: number
  verdictKind: string
  disc: DriveDiscState
}): string =>
  [
    input.state ?? "idle",
    input.jobId,
    input.title ?? "",
    String(input.progressPercent),
    input.verdictKind,
    // Every tray field, by construction rather than by a list:
    // one added later and forgotten here would be published
    // once and then quietly go stale, which is the exact bug
    // this half is here to fix.
    ...Object.values(input.disc).map(String),
  ].join("|")

export const createWatchMqtt = (
  deps: {
    createMqtt?: typeof createRipDeckMqtt
    loadRegistry?: (path: string) => Promise<DriveRegistry>
    now?: () => number
    sweepIntervalMs?: number
    heartbeatMs?: number
  } = {},
): WatchMqtt => {
  const createMqtt = deps.createMqtt ?? createRipDeckMqtt
  const loadRegistry =
    deps.loadRegistry ?? loadDriveRegistry
  const now = deps.now ?? (() => Date.now())
  const sweepIntervalMs =
    deps.sweepIntervalMs ?? ACTIVITY_TUNING.sweepIntervalMs
  const heartbeatMs =
    deps.heartbeatMs ?? ACTIVITY_TUNING.heartbeatMs

  const views = new Map<string, BayView>()

  let mqtt: RipDeckMqtt | null = null
  let registryPath: string | null = null
  let memory: ActivityMemory = createActivityMemory({
    nowMs: now(),
  })
  let sweepSubscription: Subscription | null = null
  let discoveredDriveIds = ""

  /**
   * Fire a publish and forget it.
   *
   * The one place the "a rip never depends on the broker" rule is
   * enforced per message. Logged rather than swallowed silently:
   * a broker that has been refusing us for an hour should be
   * visible in the log the operator already reads.
   */
  const safely = (
    label: string,
    publish: () => Promise<void>,
  ): void => {
    if (mqtt === null) return

    void publish().catch((error: unknown) => {
      console.error(`[mqtt] ${label} failed`, error)
    })
  }

  const viewFor = (event: {
    driveId: string
    slot: number | null
    name: string
  }): BayView => {
    const existing = views.get(event.driveId)

    if (existing !== undefined) {
      // Placement can only improve: the registry may have been
      // missing on the first tick and present later.
      existing.slot = event.slot
      existing.name = event.name
      return existing
    }

    const created = createBayView(event)
    views.set(event.driveId, created)
    return created
  }

  // Bay discovery object ids from the last successful publish.
  // Compared against the next set so a drive that left (or a
  // path-keyed id we are migrating off) is cleared on the broker
  // rather than left as a retained ghost HA keeps recreating.
  let publishedBayObjectIds: string[] = []

  const publishDiscoveryIfChanged = (): void => {
    const drives: DiscoveryDrive[] = [...views.entries()]
      .map(([driveId, view]) => ({
        driveId,
        label: view.name,
        slot: view.slot,
      }))
      .sort((a, b) => a.driveId.localeCompare(b.driveId))

    // driveId is in the signature on purpose: when the USB path
    // moves, state_topic must be rewritten even though the stable
    // slot-based unique_id stays the same.
    const signature = drives
      .map(
        (drive) =>
          `${drive.driveId}:${drive.slot ?? ""}:${drive.label}`,
      )
      .join("|")

    // Discovery messages are retained, so republishing an
    // unchanged set is pure noise — but a bay that only appeared
    // on the fifth tick has to get its entities eventually.
    if (signature === discoveredDriveIds) return
    discoveredDriveIds = signature

    const nextObjectIds = drives.map(bayDiscoveryObjectId)
    const clearObjectIds = publishedBayObjectIds.filter(
      (id) => !nextObjectIds.includes(id),
    )
    publishedBayObjectIds = nextObjectIds

    safely("discovery", async () => {
      await mqtt?.publishDiscovery({
        drives,
        clearObjectIds,
      })
    })
  }

  const publishBayState = (input: {
    bay: BayState
    /** From the sweep's sightings — see `sweep`. */
    isDrivePresent: boolean
    nowMs: number
  }): void => {
    const view =
      views.get(input.bay.driveId) ??
      createBayView({
        slot: null,
        name: input.bay.driveId,
      })

    views.set(input.bay.driveId, view)

    const state = jobStateForBay({
      bay: input.bay,
      outcome: view.outcome,
    })

    const job =
      state === null
        ? null
        : buildBayJob({ bay: input.bay, view, state })

    // The tray, published alongside the job rather than folded
    // into it. A bay that finished a rip has no job and must
    // still be tellable apart from an empty one — see
    // `DriveDiscState`.
    const disc = {
      bay: input.bay,
      isDrivePresent: input.isDrivePresent,
    }

    const fingerprint = driveStateFingerprint({
      state,
      jobId: job?.id ?? "",
      title: view.identity?.title ?? null,
      progressPercent: Math.round(
        (job?.progress.totalFraction ?? 0) * 100,
      ),
      verdictKind: verdictForOutcome(view.outcome).kind,
      disc: buildDriveDiscState(disc),
    })

    if (fingerprint === view.publishedFingerprint) return
    view.publishedFingerprint = fingerprint

    safely("drive state", async () => {
      await mqtt?.publishDriveState({
        driveId: input.bay.driveId,
        job,
        driveLabel: view.name,
        slot: view.slot,
        nowMs: input.nowMs,
        disc,
      })
    })
  }

  /**
   * One pass over every bay.
   *
   * Synchronous on purpose: `getBays()` is a read of an in-memory
   * map and every publish it triggers is fired and forgotten, so
   * there is nothing here to await and nothing a slow broker can
   * make the sweep wait for.
   */
  /**
   * The take-the-discs-out reminder, republished each sweep.
   *
   * ⚠️ **Guarded by `shouldPublishLoadedDiscs`, and that guard is
   * the feature.** This topic is RETAINED so the reminder outlives
   * a tower that has been switched off — the one situation where
   * rip-deck can see nothing at all. A daemon that restarts against
   * a dark tower therefore builds no bays and would compute
   * "nothing is loaded", which is an absence of evidence, not an
   * all-clear. Publishing it would quietly erase a standing
   * reminder about three discs. So a summary that is BOTH empty and
   * blind is not published, and the broker keeps the last thing
   * anyone actually knew.
   *
   * Republished every sweep rather than on change, matching
   * `activity`'s heartbeat argument: `updated_at` is then how a
   * reader tells "still true" from "the publisher went away".
   */
  const publishLoadedDiscsIfKnown = (input: {
    watcher: RunningWatcher
    nowMs: number
  }): void => {
    const summary = input.watcher.getLoadedDiscs()

    if (!shouldPublishLoadedDiscs(summary)) return

    safely("loaded discs", async () => {
      await mqtt?.publishLoadedDiscs({
        payload: buildLoadedDiscsPayload({
          summary,
          nowMs: input.nowMs,
        }),
      })
    })
  }

  const sweep = (watcher: RunningWatcher): void => {
    const bays = watcher.getBays()
    const nowMs = now()

    // Read once per sweep, not once per bay: the two tables have
    // different lifetimes — a bay is remembered across a
    // restart, a sighting is only ever as old as the last poll —
    // and a bay whose drive is off the bus still has to publish
    // the disc it is holding.
    const presentDriveIds = new Set(
      watcher
        .getBaySightings()
        .filter((sighting) => sighting.isDrivePresent)
        .map((sighting) => sighting.driveId),
    )

    for (const bay of bays) {
      publishBayState({
        bay,
        // A bay with no sighting at all has never had a probe
        // answer for it, which is not a present drive.
        isDrivePresent: presentDriveIds.has(bay.driveId),
        nowMs,
      })
    }

    publishDiscoveryIfChanged()

    publishLoadedDiscsIfKnown({ watcher, nowMs })

    const snapshot = summariseBayActivity(bays)
    const folded = foldActivity({
      memory,
      snapshot,
      nowMs,
      heartbeatMs,
    })

    memory = folded.memory

    if (!folded.isPublishDue) return

    safely("activity", async () => {
      await mqtt?.publishActivity({
        payload: buildActivityPayload({
          snapshot,
          memory,
          nowMs,
        }),
      })
    })
  }

  /**
   * A terminal outcome, announced.
   *
   * `no_media` is the one kind that stays quiet: the disc left
   * before anything could be done with it, so there is no rip to
   * report. Everything else — including `needs_attention`, where
   * nothing was ripped at all — reports as a rip that did not
   * produce a disc, which is what the automation's `result ==
   * 'fail'` branch already says correctly.
   */
  const publishOutcome = (event: {
    driveId: string
    slot: number | null
    name: string
    outcome: BayOutcome
    jobUuid?: string
  }): void => {
    if (event.outcome.kind === "no_media") return

    const view = viewFor(event)

    const state = jobStateForBay({
      bay: {
        driveId: event.driveId,
        phase: "done",
        sizeSectors: null,
        // The outcome EVENT carries neither, and this bay is
        // synthesised from that event alone. The disc's name
        // reaches this module by its own route (`onBayIdentified`
        // → `view.identity`); nothing here may guess at it, and
        // that goes for the disc's TYPE too.
        discName: null,
        discType: null,
        destinationPath: null,
        outcome: event.outcome,
        // A rip this process ran to its end, which is what an
        // outcome event IS — an adopted disc never emits one.
        isAdopted: false,
        latchedAtMs: now(),
        jobUuid: null,
        // Tray memory is the watcher's, and this bay is a
        // synthetic stand-in for one event — it has never been
        // asked to move a drawer.
        lastTrayCommand: null,
        startCount: 0,
        emptyObservationCount: 0,
        // Synthetic bay from a terminal outcome event — the settle
        // flag is a poll-loop fact and irrelevant here.
        hasSettledEmpty: false,
        // Same: the power-cycle memory is the poll loop's, not this
        // one-event stand-in's.
        lastFinished: null,
        updatedAtMs: now(),
      },
      outcome: event.outcome,
    })

    if (state === null) return

    safely("rip event", async () => {
      await mqtt?.publishRipEvent({
        job: buildBayJob({
          bay: {
            driveId: event.driveId,
            phase: "done",
            sizeSectors: null,
            // See above: synthesised from the event, which
            // carries none of them.
            discName: null,
            discType: null,
            destinationPath: null,
            outcome: event.outcome,
            isAdopted: false,
            latchedAtMs: now(),
            jobUuid: event.jobUuid ?? null,
            lastTrayCommand: null,
            startCount: 0,
            emptyObservationCount: 0,
            hasSettledEmpty: false,
            lastFinished: null,
            updatedAtMs: now(),
          },
          view,
          state,
        }),
        verdict: verdictForOutcome(event.outcome),
        driveLabel: view.name,
        // The number on the front of the tower, and the only bay
        // name worth speaking — `view.name` is a drive model.
        slot: view.slot,
      })
    })
  }

  /**
   * One inbound `cmd/drive` message, answered on `resp/drive`.
   *
   * Awaited rather than fired and forgotten — unlike every
   * publish in this module — because the reply IS the feature.
   * A tray command that reports nothing is the bug this exists
   * to prevent, so the one thing that must not happen here is a
   * silent return, which is why the catch publishes too.
   */
  const handleTrayCommand = async (input: {
    watcher: RunningWatcher
    payload: string
  }): Promise<void> => {
    const parsed = parseTrayCommand(input.payload)

    if (!parsed.isValid) {
      await mqtt?.publishCommandResponse({
        payload: buildTrayCommandRejection({
          requestId: parsed.requestId,
          reason: parsed.reason,
          atMs: now(),
        }),
      })
      return
    }

    try {
      await mqtt?.publishCommandResponse({
        payload: await input.watcher.runTrayCommand({
          request: parsed.request,
          requestId: parsed.requestId,
        }),
      })
    } catch (error) {
      console.error("[mqtt] tray command failed", error)

      await mqtt
        ?.publishCommandResponse({
          payload: buildTrayCommandRejection({
            requestId: parsed.requestId,
            reason:
              error instanceof Error
                ? error.message
                : String(error),
            atMs: now(),
          }),
        })
        .catch(() => {})
    }
  }

  const wrapHandlers = (
    handlers: WatcherHandlers,
  ): WatcherHandlers => ({
    // Spread FIRST so a handler this module has no interest in
    // is passed through rather than silently dropped. Listing
    // them by hand is how `onTickComplete` — the signal the API
    // feed reads its whole roster on — would have been lost on
    // the one path that wraps it in production.
    ...handlers,

    onBayNote: (event) => {
      viewFor(event)
      handlers.onBayNote?.(event)
    },

    onBayIdentified: (event) => {
      viewFor(event).identity = event.identity
      handlers.onBayIdentified?.(event)
    },

    onBayProgress: (event) => {
      viewFor(event).progress = event.progress
      handlers.onBayProgress?.(event)
    },

    onBayOutcome: (event) => {
      const view = viewFor(event)
      view.outcome = event.outcome
      view.jobUuid = event.jobUuid ?? view.jobUuid

      // Before the console handler, and never awaited: a handler
      // that throws must not be able to eat the announcement,
      // and the announcement must not be able to delay the log.
      publishOutcome(event)

      handlers.onBayOutcome?.(event)

      // A finished disc is no longer being ripped, and the
      // power-off automation should not have to wait out a
      // sweep to learn it.
      view.identity = null
      view.progress = null
    },
  })

  return {
    isEnabled: () => mqtt?.isEnabled === true,

    withPublishing: (input) => {
      registryPath = input.config.registryPath

      return {
        ...input,
        handlers: wrapHandlers(input.handlers ?? {}),
        // Fire-and-forget over the same "a rip — or a button — never
        // waits on the broker" rule as every publish here. `safely`
        // no-ops while `mqtt` is null (before connect, or a broker
        // that refused us), so an Open press on an off tower with no
        // broker still reports; the tower just does not come on.
        publishTowerPowerOn: () => {
          safely("tower power-on", async () => {
            await mqtt?.publishTowerPowerOn()
          })
        },
        // Same bargain as the power-on above: fire and forget, and
        // a no-op with no broker. A dashboard press then reports
        // honestly that it asked, and the tower stays on — which is
        // the safe direction for this particular request.
        publishTowerPowerOff: () => {
          safely("tower power-off", async () => {
            await mqtt?.publishTowerPowerOff()
          })
        },
      }
    },

    start: async ({ watcher }) => {
      try {
        mqtt = await createMqtt()
      } catch (error) {
        // The whole point of this catch. A broker that refuses
        // us must cost the announcements and nothing else.
        console.error(
          "[mqtt] could not connect — publishing is OFF for " +
            "this session. Ripping is unaffected.",
          error,
        )
        return
      }

      if (!mqtt.isEnabled) return

      // Registry first, so the nine bays get their slot numbers
      // and human names into discovery before any of them has
      // ever emitted an event.
      const registry =
        registryPath === null
          ? null
          : await loadRegistry(registryPath).catch(
              () => null,
            )

      for (const entry of registry?.entries ?? []) {
        views.set(
          entry.usbPortPath,
          createBayView({
            slot: entry.slot,
            name: entry.name,
          }),
        )
      }

      publishDiscoveryIfChanged()

      // Subscribed AFTER discovery so a command that arrives in
      // the first millisecond finds a broker we have already
      // told Home Assistant about — and wrapped, because a
      // broker that refuses the SUBSCRIBE must cost the button
      // and not the nine rips.
      await mqtt
        .subscribeToDriveCommands({
          handler: async ({ payload }) => {
            await handleTrayCommand({ watcher, payload })
          },
        })
        .catch((error: unknown) => {
          console.error(
            "[mqtt] could not subscribe to tray commands — " +
              "the eject button will do nothing this session.",
            error,
          )
        })

      memory = createActivityMemory({ nowMs: now() })

      // `isKeepingProcessAlive` is deliberately left false: the
      // watcher's own timer is what holds `rip-deck watch` open,
      // and a publisher that could keep a finished process alive
      // is the exact failure `unrefTimers.ts` exists to prevent.
      sweepSubscription = unrefInterval({
        periodMs: sweepIntervalMs,
      })
        .pipe(
          exhaustMap(() =>
            defer(() => {
              sweep(watcher)
              return EMPTY
            }).pipe(catchError(() => EMPTY)),
          ),
        )
        .subscribe()

      sweep(watcher)
    },

    stop: async () => {
      sweepSubscription?.unsubscribe()
      sweepSubscription = null

      // Publishes the retained `offline` availability, which
      // takes every discovered entity `unavailable`. That is
      // what stops the power-off automation from acting on a
      // last-known "0 active rips" left behind by a daemon that
      // is no longer watching anything.
      await mqtt?.close().catch(() => {})
      mqtt = null
    },
  }
}

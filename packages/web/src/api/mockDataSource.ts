import {
  type DiscType,
  type JobState,
  makeVerdict,
  type VerdictConfidence,
  type VerdictKind,
} from "@rip-deck/contracts"

import {
  DEFAULT_FIXTURE,
  type FixtureName,
  isFixtureName,
} from "../fixture"
import {
  TRAY_REFUSED_STATES,
  trayReportToActionResult,
} from "../format"
import type {
  ActionResult,
  BayAction,
  BayView,
  Drive,
  DriveAlertPayload,
  Host,
  LoadedDiscsView,
  Rip,
  RipDeckDataSource,
  RipDeckState,
  TowerAlert,
  TowerView,
  TrayBayReport,
  TrayBayResultKind,
  TrayCommandCounts,
  TrayCommandWord,
} from "../types"

/**
 * Mock data source — bundled fixtures, NO backend required.
 *
 * Ported from the ARM viewer's `mockDataSource.ts`, keeping the
 * two things HANDOFF §8 says to keep: the module-level mutable
 * drift state, so successive polls look alive, and `minsAgo()`
 * emitting LOCAL wall-clock, because the daemon's
 * `formatLocalTimestamp` does too and a `toISOString()` here
 * would read hours into the future.
 *
 * The SCENARIOS are not this file's invention. They are
 * `packages/daemon/src/api/fixtures.ts`, name for name and
 * number for number — same seven names, same bay labels, same
 * drive ids, same titles, same slots. That file is the source of
 * truth; this is its browser-side twin, transcribed rather than
 * imported because `@rip-deck/daemon` must not reach the browser
 * bundle (see `src/types.ts`). `mockDataSource.test.ts` pins the
 * name list and every state below so a divergence is a red test
 * and not a demo that shows something the rack cannot do.
 *
 * Every scenario here exists because it is a state rip-deck was
 * BUILT for:
 *
 *  - `disc_dirty` vs `disc_scratched` — same symptom, opposite
 *    advice ("clean it" vs "source another copy"). Getting that
 *    backwards is how a tool loses the owner's trust.
 *  - a `hub_fault` across four bays, which must read as ONE
 *    problem with the hub rather than four bad discs.
 *  - `suspected` vs `confirmed`, the two-drive rule made visible.
 *  - a RISING ETA, a signal and not a cosmetic annoyance.
 *  - a quarantined drive with its clear control, because
 *    quarantine is deliberately never self-healing.
 *  - ZERO drives present, which is normal (F3) — the tower is
 *    switched off — and must never paint the rack red.
 *  - discs HELD at startup beside a genuinely FAILED rip, the
 *    pair this dashboard most has to keep apart, and the exact
 *    state the owner's tower is in right now.
 */

const HOST_LABEL = "tower"
const TOPIC_BASE = "rip-deck/tower"

const ALL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

/**
 * `rip/bayLedger.ts`, transcribed.
 *
 * Word for word, because it is the sentence a human reads off
 * the card — and because `packages/web/README.md` is right that
 * this file mirrors the daemon rather than importing it, so a
 * paraphrase here would silently become a second, worse version
 * of the daemon's wording. `mockDataSource.test.ts` pins the
 * phrases the card must show.
 */
const UNKNOWN_AT_STARTUP_DETAIL =
  "There was already a disc in this drive when Rip-Deck " +
  "started, and Rip-Deck has no bay memory at all yet — so it " +
  "cannot tell a fresh disc from one the last daemon already " +
  "ripped. Refusing to rip it again on a guess: a duplicate " +
  "90 GB backup costs hours and this costs a button press. " +
  "Press Rip to rip it anyway, or take the disc out if it is " +
  "already backed up. Happens once per state directory."

/**
 * A little in-memory state so successive polls look alive.
 *
 * Module-level and mutable on purpose (HANDOFF §8): a mock that
 * returns the identical document every poll cannot show that the
 * bar moves, and "the bar moves" is most of what a rip dashboard
 * has to get right.
 */
const drift = {
  /** Overall percent of the bay-1 rip, advanced each poll. */
  leadPercent: 43.2,
  /** Bays the operator has cancelled, by drive id. */
  cancelled: new Set<string>(),
  /** Bays the operator has told to keep trying. */
  keepTrying: new Set<string>(),
  /** Quarantines the operator has cleared. */
  quarantineCleared: new Set<string>(),
  /**
   * Trays the operator has opened.
   *
   * Opening one makes the bay read EMPTY, and after
   * `rearmEmptyObservations` (~10 s) the watcher re-arms it —
   * which is the documented manual override for a held disc
   * (`docs/eject-and-durable-bay-state.md` §4). The mock does it
   * instantly rather than modelling ten seconds of polling, so
   * the escape hatch can actually be clicked here.
   */
  trayOpened: new Set<string>(),
  /**
   * The last tray command each bay was sent, as the daemon would
   * remember it — the input `nextTrayCommandFor` infers from.
   *
   * Kept even for `close_bay`, which changes nothing observable:
   * that IS the field's whole reason to exist. Without it a
   * closed empty bay and an open empty bay are the same document
   * and the ⏏ toggle can never point anywhere but "open".
   */
  lastTrayCommand: new Map<
    string,
    "open_bay" | "close_bay"
  >(),
  /**
   * Bays the operator has said he took the disc out of.
   *
   * The daemon's `BayState.isLoadedDismissed`, mirrored: a
   * `clear_loaded` press drops a bay out of the reminder even
   * though its drive still reports the disc, because on this
   * hardware it reports it for as long as it stays powered
   * ([decision](docs/decisions/2026-08-20-mark-as-taken-out-trusts-the-operator-over-the-drive.md)).
   * Display-only here too — the bay's own card is untouched.
   */
  loadedDismissed: new Set<string>(),
  /**
   * Which scenario the page last asked for.
   *
   * `runTrayCommand` has to know which bays exist before it can
   * report on them, and the mock has no other memory of the
   * document it just served.
   */
  fixture: DEFAULT_FIXTURE,
}

/** Reset the drift. Exported for tests, never called by the app. */
export const resetMockDrift = (): void => {
  drift.leadPercent = 43.2
  drift.cancelled.clear()
  drift.keepTrying.clear()
  drift.quarantineCleared.clear()
  drift.trayOpened.clear()
  drift.lastTrayCommand.clear()
  drift.loadedDismissed.clear()
  drift.fixture = DEFAULT_FIXTURE
}

const pad = (value: number): string =>
  String(value).padStart(2, "0")

/**
 * A timestamp `mins` minutes ago, in the daemon's
 * `YYYY-MM-DD HH:MM:SS` shape.
 *
 * LOCAL wall-clock, not `toISOString()`. The daemon's
 * `formatLocalTimestamp` writes local time and the dashboard
 * parses it as local; a UTC string here reads hours in the
 * future and every elapsed figure on the page goes negative.
 */
const minsAgo = (mins: number): string => {
  const at = new Date(Date.now() - mins * 60_000)

  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-` +
    `${pad(at.getDate())} ${pad(at.getHours())}:` +
    `${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  )
}

const FNV_OFFSET_BASIS = 2166136261
const FNV_PRIME = 16777619

/**
 * The daemon's job-id surrogate, reproduced exactly.
 *
 * `armView.toArmJobId`. The viewer types `job_id` as a number
 * (ARM's rowid) and joins a rip to its drive on it, while
 * rip-deck ids are UUIDs — so a stable numeric hash travels in
 * that slot and the real id rides alongside as `job_uuid`.
 * Reproduced rather than approximated because it is a React key:
 * a value that changed between the mock and the daemon would
 * remount every card the moment the app is pointed at a server.
 */
const toArmJobId = (jobId: string): number => {
  let hash = FNV_OFFSET_BASIS

  for (let index = 0; index < jobId.length; index += 1) {
    hash ^= jobId.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }

  return hash >>> 0
}

/** `topics.driveSlug` — MQTT-safe slug for a drive id. */
const driveSlug = (driveId: string): string =>
  driveId.toLowerCase().replace(/[^a-z0-9]+/g, "_")

const bayLabel = (slot: number): string =>
  `${pad(slot)} - Pioneer BDR-211M`

const bayDriveId = (slot: number): string =>
  `usb-2-1-1-2-4-4-${slot}`

const devPathOf = (slot: number): string =>
  `/dev/sr${9 - slot}`

/** `armView.toArmKind` — `cd` is ARM's `music`; `uhd` stays. */
const toArmKind = (discType: DiscType): string =>
  discType === "cd" ? "music" : discType

/** `armView.toArmStatus`. */
const toArmStatus = (state: JobState): string => {
  if (state === "completed") return "success"
  if (state === "failed") return "fail"
  if (
    state === "ripping" ||
    state === "throttled" ||
    state === "stalled"
  ) {
    return "ripping"
  }

  return state
}

const isActiveState = (state: JobState): boolean =>
  state === "ripping" ||
  state === "throttled" ||
  state === "stalled"

/** `drive.discTypeLabel`. */
const discTypeLabelOf = (
  discType: DiscType,
): string | null => {
  switch (discType) {
    case "dvd":
      return "DVD"
    case "bluray":
      return "Blu-ray"
    case "uhd":
      return "4K"
    default:
      return null
  }
}

/**
 * Roughly what one disc measures, in 512-byte sectors.
 *
 * Real capacities, not round numbers, because this is the field
 * `nextTrayCommandFor` reads as "the tray is shut" — and a
 * fixture that reported a 4K disc as 48 million sectors would
 * make the browser mock disagree with the rack about which disc
 * is which the day anything starts fingerprinting on size
 * (`bayLedger.ts` already does, and says so is weak).
 */
const discSectorsOf = (discType: DiscType): number => {
  switch (discType) {
    case "uhd":
      return 128_000_000
    case "dvd":
      return 9_200_000
    case "cd":
      return 1_400_000
    default:
      return 48_000_000
  }
}

/** One bay's fixture inputs, before projection. */
type MockBay = {
  slot: number
  isQuarantined?: boolean
  quarantineReason?: string | null
  job?: {
    state?: JobState
    title?: string
    discType?: DiscType
    verdictKind?: VerdictKind
    confidence?: VerdictConfidence
    evidence?: string[]
    totalFraction?: number
    currentLabel?: string | null
    totalLabel?: string | null
    etaSeconds?: number | null
    etaTrend?: "falling" | "steady" | "rising" | null
    throughputBytesPerSec?: number | null
    readErrorCount?: number
    elapsedMins?: number
    /**
     * Adopted from the bay ledger rather than watched.
     *
     * `towerFeed.buildJob` sets `identity: null` for one of
     * these — the disc's real name never leaves the watcher, and
     * scraping it back out of the outcome sentence is the
     * `MSG:5072` mistake. So an adopted bay is genuinely
     * nameless on `/json`, and the card has to render that
     * honestly rather than printing the word "disc".
     */
    isAdopted?: boolean
  }
}

const DEFAULT_QUARANTINE_REASON =
  "Crashed 3 times without staying up."

/**
 * Project one fixture bay into the ARM-shaped rip, the
 * ARM-shaped drive, and the rip-deck-native bay view — the three
 * things `/json` carries for a bay.
 */
const projectBay = (
  bay: MockBay,
): {
  rip: Rip | null
  drive: Drive
  bayView: BayView
  nowMs: number
} => {
  const nowMs = Date.now()
  const driveId = bayDriveId(bay.slot)
  const label = bayLabel(bay.slot)
  const devPath = devPathOf(bay.slot)

  const isQuarantined =
    (bay.isQuarantined ?? false) &&
    !drift.quarantineCleared.has(driveId)

  const quarantineReason = isQuarantined
    ? (bay.quarantineReason ?? DEFAULT_QUARANTINE_REASON)
    : null

  const drive: Drive = {
    name: devPath.split("/").pop() ?? null,
    mount: devPath,
    current: null,
    previous: null,
    maker: "PIONEER",
    model: "BD-RW BDR-211M",
    serial_id: `FIXTURE00${bay.slot}`,
    drive_id: driveId,
    slot: bay.slot,
    is_quarantined: isQuarantined,
    quarantine_reason: quarantineReason,
  }

  const idleBayView: BayView = {
    drive_id: driveId,
    label,
    slot: bay.slot,
    dev_path: devPath,
    is_present: true,
    // An idle bay has nothing in it. `towerFeed` reads this off
    // the disc's own facts, so "no disc" is null rather than 0.
    disc_size_sectors: null,
    last_tray_command:
      drift.lastTrayCommand.get(driveId) ?? null,
    is_quarantined: isQuarantined,
    quarantine_reason: quarantineReason,
    state: {
      drive: label,
      slot: bay.slot,
      state: "idle",
      job_id: null,
      title: null,
      disctype: null,
      progress_percent: 0,
      eta_seconds: null,
      eta_trend: null,
      throughput_bytes_per_sec: null,
      read_error_count: 0,
      verdict: "ok",
      updated_at: nowMs,
    },
    state_topic: `${TOPIC_BASE}/drive/${driveSlug(driveId)}`,
    alert: null,
    alert_topic: `${TOPIC_BASE}/drive/${driveSlug(driveId)}/alert`,
    verdict_confidence: null,
    is_announceable: false,
    actions: isQuarantined ? ["clear_quarantine"] : [],
  }

  // An opened tray is an empty bay. The disc is in the
  // operator's hand, so there is nothing to hold and nothing to
  // show — which is precisely how a held disc is released.
  if (!bay.job || drift.trayOpened.has(driveId)) {
    return { rip: null, drive, bayView: idleBayView, nowMs }
  }

  const jobUuid = `fixture-job-${bay.slot}`

  // The operator's cancel is the one drift that changes a job's
  // STATE rather than its numbers, so it is applied first and
  // everything below reads from the result.
  const state: JobState = drift.cancelled.has(driveId)
    ? "cancelled"
    : (bay.job.state ?? "ripping")

  const isActive = isActiveState(state)
  const discType = bay.job.discType ?? "bluray"
  const title = bay.job.title ?? "Ivanhoe"
  const verdictKind = bay.job.verdictKind ?? "ok"

  const verdict = makeVerdict(
    verdictKind,
    bay.job.confidence ?? "suspected",
    bay.job.evidence ?? [],
  )

  const totalFraction = bay.job.totalFraction ?? 0.43
  const readErrorCount = bay.job.readErrorCount ?? 0
  const elapsedMins = bay.job.elapsedMins ?? 8

  // `??` would be wrong for these three: a scenario overriding
  // them to NULL is saying "there is no rate", which is exactly
  // what a stalled bay looks like, and `?? 900` would quietly
  // put a confident "~15m left" on a drive that has stopped
  // answering. Absent and null are different readings here, so
  // the check is against `undefined`.
  const etaSeconds =
    bay.job.etaSeconds === undefined
      ? 900
      : bay.job.etaSeconds
  const etaTrend =
    bay.job.etaTrend === undefined
      ? "falling"
      : bay.job.etaTrend
  const throughputBytesPerSec =
    bay.job.throughputBytesPerSec === undefined
      ? 21 * 1024 * 1024
      : bay.job.throughputBytesPerSec

  const isKeepTryingRequested =
    drift.keepTrying.has(driveId)
  const isAdopted = bay.job.isAdopted ?? false

  // `armView.toArmPercent`: 100 when complete; null while an
  // active rip has made no forward progress at all, which is the
  // AACS/BD+ preamble and renders as a sweep rather than an
  // empty bar; one decimal otherwise, matching makemkv.
  const percent =
    state === "completed"
      ? 100
      : isActive && totalFraction <= 0
        ? null
        : Math.round(totalFraction * 1000) / 10

  const rip: Rip = {
    job_id: toArmJobId(jobUuid),
    status: toArmStatus(state),
    kind: toArmKind(isAdopted ? "unknown" : discType),
    // Null for an adopted bay: `armView` reads
    // `identity?.title ?? identity?.volumeLabel`, and
    // `towerFeed` gives an adopted job no identity at all.
    label: isAdopted ? null : title,
    drive: devPath,
    // Null for an adopted bay, like `towerFeed.buildJob`.
    path: isAdopted ? null : `/media/Disc-Rips/${title}`,
    percent,
    // Absent vs null again, for the same reason as the ETA
    // below: a scenario setting both labels to NULL is saying
    // "this bay is not in a stage", which is what a bay that
    // never started a rip looks like. `??` alone would restore
    // "Saving file 3 of 78" to it.
    stage:
      bay.job.currentLabel === undefined &&
      bay.job.totalLabel === undefined
        ? "Saving file 3 of 78"
        : (bay.job.currentLabel ??
          bay.job.totalLabel ??
          ""),
    active: isActive,
    // No `/logs` endpoint exists yet, and the card hides its
    // Logs button when this is null — better than a button that
    // 501s. The capture's name travels as `job_uuid`.
    logfile: null,
    // Nothing ever sets this. rip-deck never eject-LOOPS — no
    // auto-eject in the rip cycle — but it does open a tray on
    // request (`open_bay`), and that is not this flag.
    ejected: false,
    poster: null,
    drive_name: label,
    // Reading the tray means an ioctl, and the parent process
    // must never make a device call.
    tray: "unknown",
    start: minsAgo(elapsedMins),
    stop:
      state === "completed" ||
      state === "failed" ||
      state === "cancelled"
        ? minsAgo(0)
        : null,

    job_uuid: jobUuid,
    drive_id: driveId,
    slot: bay.slot,
    disctype: isAdopted ? "unknown" : discType,
    disctype_label: isAdopted
      ? null
      : discTypeLabelOf(discType),
    volume_label: isAdopted
      ? null
      : title.toUpperCase().replace(/ /g, "_"),
    eta_seconds: etaSeconds,
    eta_trend: etaTrend,
    throughput_bytes_per_sec: throughputBytesPerSec,
    read_error_count: readErrorCount,
    verdict: verdict.kind,
    verdict_message: verdict.message,
    verdict_confidence: verdict.confidence,
    failure_reason:
      state === "failed" ? "read_errors" : null,
    is_adopted: isAdopted,
    is_keep_trying_requested: isKeepTryingRequested,
  }

  drive.current = isActive ? rip.job_id : null
  drive.previous =
    state === "completed" ||
    state === "failed" ||
    state === "cancelled"
      ? rip.job_id
      : null

  const alert: DriveAlertPayload | null =
    verdict.kind === "ok"
      ? null
      : {
          drive: label,
          slot: bay.slot,
          verdict: verdict.kind,
          action: verdict.action,
          message: verdict.message,
          evidence: verdict.evidence,
          is_keep_trying_sensible:
            verdict.isKeepTryingSensible,
        }

  // `towerView.buildBayActions`, reproduced. Quarantine first
  // because it is true regardless of what the bay is doing.
  const actions: BayAction[] = []

  if (isQuarantined) actions.push("clear_quarantine")

  const isTroubled = verdict.kind !== "ok"

  if (isActive && isTroubled && !isKeepTryingRequested) {
    actions.push("keep_trying", "give_up")
  }

  if (
    isTroubled &&
    verdict.subject === "disc" &&
    verdict.confidence === "suspected"
  ) {
    actions.push("retry_in_another_drive")
  }

  if (isActive) actions.push("cancel")

  const bayView: BayView = {
    ...idleBayView,
    // A job means a disc was read, and a drive cannot read a
    // disc through an open drawer — which is the one FACT the ⏏
    // toggle gets to stand on (`format.nextTrayCommandFor`).
    disc_size_sectors: discSectorsOf(discType),
    state: {
      ...idleBayView.state,
      state,
      job_id: jobUuid,
      title: isAdopted ? null : title,
      disctype: isAdopted ? null : discType,
      progress_percent: Math.round(totalFraction * 100),
      eta_seconds: rip.eta_seconds,
      eta_trend: rip.eta_trend,
      throughput_bytes_per_sec:
        rip.throughput_bytes_per_sec,
      read_error_count: readErrorCount,
      verdict: verdict.kind,
    },
    alert,
    verdict_confidence: verdict.confidence,
    // Only `confirmed`, non-`ok` verdicts are allowed to
    // announce — `isAnnounceable`. `suspected` shows on the card
    // and offers a retry; it never wakes anybody up.
    is_announceable:
      verdict.confidence === "confirmed" &&
      verdict.kind !== "ok",
    actions,
  }

  return { rip, drive, bayView, nowMs }
}

/**
 * Group every non-`ok` verdict into one alert per kind.
 *
 * `towerView.buildTowerAlerts`. Grouping is presentation, not
 * diagnosis — nothing here invents or upgrades a verdict. It
 * exists because a hub fault is ONE problem, and telling the
 * owner to clean four discs because a hub lost power is exactly
 * the confidently-wrong alert the verdict model was built to
 * prevent.
 */
const buildTowerAlerts = (
  bays: BayView[],
): TowerAlert[] => {
  const alertsByKind = new Map<VerdictKind, TowerAlert>()

  for (const bay of bays) {
    const { alert } = bay

    if (!alert) continue

    const existing = alertsByKind.get(alert.verdict)
    const confidence = bay.verdict_confidence ?? "suspected"

    if (!existing) {
      alertsByKind.set(alert.verdict, {
        verdict: alert.verdict,
        subject: makeVerdict(alert.verdict, confidence, [])
          .subject,
        action: alert.action,
        message: alert.message,
        confidence,
        is_announceable: bay.is_announceable,
        drive_ids: [bay.drive_id],
        labels: [bay.label],
      })

      continue
    }

    existing.drive_ids.push(bay.drive_id)
    existing.labels.push(bay.label)

    // One bay's confirmation is enough to confirm the trouble;
    // the other bays are more evidence for it, not against it.
    if (confidence === "confirmed") {
      existing.confidence = "confirmed"
    }

    existing.is_announceable =
      existing.is_announceable || bay.is_announceable
  }

  return [...alertsByKind.values()]
}

const buildState = (input: {
  fixture: FixtureName
  bays: MockBay[]
  /** A flapping USB bus, for the `usb-flap` fixture. */
  usbAlert?: TowerAlert | null
}): RipDeckState => {
  const nowMs = Date.now()
  const projected = input.bays.map(projectBay)

  const rips = projected
    .flatMap(({ rip }) => (rip === null ? [] : [rip]))
    // Newest first — the cards assume the list is already in
    // that order and take the first match per bay.
    .reverse()

  const bayViews = projected.map(({ bayView }) => bayView)

  const host: Host = {
    host: HOST_LABEL,
    rips,
    drives: projected.map(({ drive }) => drive),
    // TRUE for an empty rack. Zero drives means the owner
    // switched the tower off, which is a normal state — not a
    // fault, and not something to paint red.
    ok: true,
    err: "",
  }

  const ripDeck: TowerView = {
    schema_version: 1,
    host: HOST_LABEL,
    generated_at: nowMs,
    is_fake: true,
    fixture: input.fixture,
    is_mqtt_enabled: true,
    is_tower_present: bayViews.length > 0,
    drive_count: bayViews.length,
    active_count: rips.filter((rip) => rip.active).length,
    bays: bayViews,
    alerts: buildTowerAlerts(bayViews),
    usb_alert: input.usbAlert ?? null,
    // Folded from the same bays the daemon folds, so a fixture
    // showing three held discs also shows the reminder about
    // them rather than needing its own hand-written copy.
    loaded_discs: buildMockLoadedDiscs(bayViews),
    last_rip: null,
    last_rip_topic: `${TOPIC_BASE}/rip/last`,
    availability_topic: `${TOPIC_BASE}/availability`,
    error: "",
  }

  return { hosts: [host], ripDeck }
}

/** Every bay idle, so a scenario only has to name its outliers. */
const idleBays = (slots: number[]): MockBay[] =>
  slots.map((slot) => ({ slot }))

/**
 * The tower switched off.
 *
 * Not an error and not an empty-state apology: the owner powers
 * the rack independently of the host, so zero bays is how he
 * normally leaves it (F3).
 */
const buildEmpty = (): RipDeckState =>
  buildState({ fixture: "empty", bays: [] })

/** Nine concurrent rips — the owner's headline request. */
const buildNineRips = (): RipDeckState =>
  buildState({
    fixture: "nine-rips",
    bays: ALL_SLOTS.map((slot) => ({
      slot,
      job: {
        title: `Fixture Disc ${slot}`,
        elapsedMins: slot * 1.5,
        // Bay 1 carries the drift so the page visibly moves.
        totalFraction:
          slot === 1 ? drift.leadPercent / 100 : slot / 10,
        etaSeconds: 3_600 - slot * 300,
      },
    })),
  })

/** One bay per verdict kind — every card the UI must render. */
const buildVerdicts = (): RipDeckState => {
  const kinds: VerdictKind[] = [
    "ok",
    "disc_dirty",
    "disc_scratched",
    "disc_marginal_slow",
    "drive_failing",
    "enumeration_flap",
    "key_expired",
    "hub_fault",
    "unknown",
  ]

  return buildState({
    fixture: "verdicts",
    bays: kinds.map((kind, index) => ({
      slot: index + 1,
      job: {
        title: `Fixture ${kind}`,
        verdictKind: kind,
        confidence:
          kind === "ok" ? "suspected" : "confirmed",
        evidence:
          kind === "ok"
            ? []
            : [`Fixture evidence for ${kind}`],
        readErrorCount:
          kind === "disc_dirty" || kind === "disc_scratched"
            ? 12
            : 0,
        elapsedMins: (index + 1) * 1.5,
      },
    })),
  })
}

/**
 * A hub fault across four bays.
 *
 * Every affected bay carries the SAME hub verdict — not four
 * disc verdicts — and the tower view must group them into one
 * alert. Telling the owner to clean four discs because a hub
 * lost power is the failure this whole model exists to prevent.
 */
const buildHubFault = (): RipDeckState => {
  const faultedSlots = [4, 5, 6, 7]

  return buildState({
    fixture: "hub-fault",
    bays: ALL_SLOTS.map((slot) =>
      faultedSlots.includes(slot)
        ? {
            slot,
            job: {
              state: "stalled" as JobState,
              title: `Fixture Disc ${slot}`,
              verdictKind: "hub_fault" as VerdictKind,
              confidence: "confirmed" as VerdictConfidence,
              evidence: [
                "4 drives under hub 2-1.1.2.4 stopped " +
                  "together within 60s",
              ],
              etaSeconds: null,
              etaTrend: null,
              elapsedMins: slot * 1.5,
            },
          }
        : { slot },
    ),
  })
}

/**
 * A flapping USB bus — the "change your cable" banner.
 *
 * Two discs sit HELD (the flap is what held them), which is the
 * point of previewing this: the banner has to show ABOVE those
 * held cards, not be filtered out by the per-bay alert rules that
 * hide troubles confined to held bays. This is exactly the
 * situation the dedicated `usb_alert` field exists for.
 */
const buildUsbFlap = (): RipDeckState => {
  const heldSlots = [7, 8]

  return buildState({
    fixture: "usb-flap",
    bays: ALL_SLOTS.map((slot) =>
      heldSlots.includes(slot)
        ? {
            slot,
            job: {
              state: "needs_attention" as JobState,
              title: `Fixture Disc ${slot}`,
              verdictKind: "unknown" as VerdictKind,
              confidence: "suspected" as VerdictConfidence,
              evidence: [],
              etaSeconds: null,
              etaTrend: null,
              elapsedMins: 0,
            },
          }
        : { slot },
    ),
    usbAlert: {
      verdict: "hub_fault",
      subject: "hub",
      action: "check_hub",
      message:
        "The USB connection to the tower keeps dropping and " +
        "reconnecting. Discs cannot be read reliably while this " +
        "is happening — a drive that flaps mid-read is why a " +
        'disc lands as "could not read a name". Try a different ' +
        "USB cable or port; a passive extension, or two cables " +
        "joined, is the usual cause.",
      confidence: "confirmed",
      is_announceable: false,
      drive_ids: ["2-2.3", "2-2.4"],
      labels: [
        "07 - Pioneer BDR-211M",
        "08 - Pioneer BDR-211M",
      ],
    },
  })
}

/**
 * The two-drive rule, made visible.
 *
 * Bay 2 saw a dirty disc once — `suspected`, so it renders a
 * card and offers "retry in another drive". Bay 8 is the second
 * drive that agreed, so the same verdict is `confirmed` there,
 * and only that one may announce.
 */
const buildConfidence = (): RipDeckState =>
  buildState({
    fixture: "confidence",
    bays: [
      ...idleBays([1]),
      {
        slot: 2,
        job: {
          title: "Ivanhoe",
          verdictKind: "disc_dirty",
          confidence: "suspected",
          evidence: ["Errors scattered across 9 regions"],
          readErrorCount: 9,
        },
      },
      ...idleBays([3, 4, 5, 6, 7]),
      {
        slot: 8,
        job: {
          title: "Ivanhoe",
          verdictKind: "disc_dirty",
          confidence: "confirmed",
          evidence: [
            "Errors scattered across 11 regions",
            "Second drive agrees — the disc, not the drive",
          ],
          readErrorCount: 11,
        },
      },
      ...idleBays([9]),
    ],
  })

/**
 * A rising ETA.
 *
 * A signal in its own right (C6): the same d(progress)/dt
 * collapse the health engine watches, visible to the owner
 * before the rip fails. The bay is NOT failed and NOT alarmed —
 * a rising ETA on a healthy disc happens, so the card shows the
 * trend and the verdict stays `ok`.
 */
const buildRisingEta = (): RipDeckState =>
  buildState({
    fixture: "rising-eta",
    bays: [
      ...idleBays([1, 2]),
      {
        slot: 3,
        job: {
          title: "Ivanhoe",
          totalFraction: 0.11,
          etaSeconds: 5_400,
          etaTrend: "rising",
          throughputBytesPerSec: 15.5 * 1024 * 1024,
        },
      },
      ...idleBays([4, 5, 6, 7, 8, 9]),
    ],
  })

/**
 * A quarantined drive.
 *
 * Out of service until a human clears it — deliberately not
 * self-healing, because an automatic un-quarantine re-enters the
 * same crash loop later, at night, with nobody watching. The bay
 * therefore always offers `clear_quarantine`.
 */
const buildQuarantined = (): RipDeckState =>
  buildState({
    fixture: "quarantined",
    bays: [
      ...idleBays([1, 2, 3, 4]),
      {
        slot: 5,
        isQuarantined: true,
        quarantineReason:
          "Crashed 3 times without staying up. Taken out of " +
          "service — clear it once the drive has been looked " +
          "at.",
      },
      { slot: 6, job: { title: "Fixture Disc 6" } },
      ...idleBays([7, 8, 9]),
    ],
  })

/**
 * Three discs held at startup, and one that actually failed.
 *
 * ⚠️ Not a hypothetical: this is the owner's tower on
 * 2026-07-26. `rip-deck:0.4.0` came up with the three Troy discs
 * still in slots 7–9, found no `bays.json`, and took
 * `adoptBayAtStartup`'s fail-closed branch on all three — held,
 * flagged, not ripped. That is the intended outcome and it is
 * what stopped 225 GB of duplicate ripping
 * (`docs/eject-and-durable-bay-state.md` §5).
 *
 * Slot 1 carries a genuinely FAILED rip on purpose. These two
 * states are the pair this dashboard most has to keep apart, and
 * a fixture containing only one of them proves nothing about
 * whether they read differently — "this disc failed to rip"
 * wants another copy of the disc, "rip-deck does not know whether
 * this was ripped, so it did not" wants a button press.
 *
 * Mirrors `buildHeldAtStartup` in
 * `packages/daemon/src/api/fixtures.ts`, which is the source of
 * truth. README warns that the mirroring is by transcription, so
 * a change there will NOT turn this suite red on its own.
 */
const buildHeldBay = (input: {
  slot: number
  title: string
  discType: DiscType
}): MockBay => ({
  slot: input.slot,
  job: {
    state: "needs_attention",
    title: input.title,
    discType: input.discType,
    // What `towerFeed.buildVerdict` stamps on a bay no health
    // engine judged. NEVER `confirmed`: only a confirmed verdict
    // may announce, and announcing one nothing computed is the
    // confidently-wrong alert the model exists to prevent.
    verdictKind: "unknown",
    confidence: "suspected",
    evidence: [UNKNOWN_AT_STARTUP_DETAIL],
    // Nothing ran, so there are no numbers. A held bay showing
    // 43% and "~15m left" would describe a rip that never
    // started.
    totalFraction: 0,
    currentLabel: null,
    totalLabel: null,
    etaSeconds: null,
    etaTrend: null,
    throughputBytesPerSec: null,
    elapsedMins: 0,
  },
})

const buildHeldAtStartup = (): RipDeckState =>
  buildState({
    fixture: "held-at-startup",
    bays: [
      {
        slot: 1,
        job: {
          state: "failed",
          title: "Fixture Scratched Disc",
          verdictKind: "disc_scratched",
          confidence: "confirmed",
          evidence: [
            "Errors concentrated in one continuous band",
          ],
          readErrorCount: 41,
          totalFraction: 0.62,
          etaSeconds: null,
          etaTrend: null,
          throughputBytesPerSec: null,
        },
      },
      ...idleBays([2, 3, 4, 5, 6]),
      buildHeldBay({
        slot: 7,
        title: "TROY - BONUS DISC",
        discType: "bluray",
      }),
      buildHeldBay({
        slot: 8,
        title: "TROY - DIRECTOR'S CUT",
        discType: "uhd",
      }),
      buildHeldBay({
        slot: 9,
        title: "TROY - THEATRICAL CUT",
        discType: "uhd",
      }),
    ],
  })

/**
 * Three rips that FINISHED, and that nothing measured.
 *
 * ⚠️ The live rack, 2026-07-26, `rip-deck:0.5.0`. The owner's
 * three Troy discs are 225 GB of successful, verified backups
 * adopted from the bay ledger, and this dashboard presented them
 * as a fault: a full-width red banner, a yellow "needs
 * attention" heading, and a **Retry in another drive** button on
 * each — an invitation to re-rip the exact discs the ledger
 * exists to protect.
 *
 * The conflation was `verdict !== "ok"` meaning trouble.
 * `towerFeed` stamps `unknown` on every bay it did not measure,
 * and its header explains at length why `ok` there would be a
 * lie. `unknown` means "nothing judged this rip" — a statement
 * about rip-deck's instrumentation, not about the disc.
 *
 * So this scenario holds that line: a `completed` job reads as
 * completed whatever its verdict. Calm, out of the attention
 * bucket, no banner, no re-rip control. The bays are adopted, so
 * `identity` is null and the cards have no disc name — the
 * honest state, not a bug to paper over by scraping the outcome
 * sentence.
 *
 * Mirrors `buildUnmeasured` in
 * `packages/daemon/src/api/fixtures.ts`.
 */
const buildUnmeasuredBay = (slot: number): MockBay => ({
  slot,
  job: {
    state: "completed",
    isAdopted: true,
    verdictKind: "unknown",
    confidence: "suspected",
    evidence: [
      "held on startup: the bay ledger already had this " +
        "disc",
      "`rip-deck watch` does not run the health engine yet, " +
        "so nothing has judged this rip.",
    ],
    totalFraction: 1,
    // The ledger recorded no stage. The default would put
    // "Saving file 3 of 78" on a rip that finished last night.
    currentLabel: null,
    totalLabel: null,
    throughputBytesPerSec: null,
    etaSeconds: null,
    etaTrend: null,
  },
})

const buildUnmeasured = (): RipDeckState =>
  buildState({
    fixture: "unmeasured",
    bays: [
      ...idleBays([1, 2, 3, 4, 5, 6]),
      buildUnmeasuredBay(7),
      buildUnmeasuredBay(8),
      buildUnmeasuredBay(9),
    ],
  })

export const createFixtureState = (
  fixture: FixtureName,
): RipDeckState => {
  switch (fixture) {
    case "empty":
      return buildEmpty()
    case "nine-rips":
      return buildNineRips()
    case "verdicts":
      return buildVerdicts()
    case "hub-fault":
      return buildHubFault()
    case "confidence":
      return buildConfidence()
    case "rising-eta":
      return buildRisingEta()
    case "quarantined":
      return buildQuarantined()
    case "held-at-startup":
      return buildHeldAtStartup()
    case "unmeasured":
      return buildUnmeasured()
    case "usb-flap":
      return buildUsbFlap()
  }
}

const MOCK_LOG = `MSG:1005,0,1,"MakeMKV v1.18.1 started","%1 started","MakeMKV v1.18.1"
DRV:0,2,999,12,"BD-RE PIONEER BD-RW BDR-211M 1.20","IVANHOE","/dev/sr0"
PRGT:0,5018,"Scanning CD-ROM devices"
PRGV:0,0,65536
PRGT:0,5085,"Decrypting"
PRGV:65536,65536,65536
PRGT:0,5069,"Copying file"
PRGV:28180,28180,65536
MSG:5072,0,1,"Backup done","%1","Backup done"
# every PRGT stage restarts PRGV from zero — anything derived
# across a stage boundary is two series added together (§2.4).`

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(value), ms)
  })

/* ------------------------------------------------------------ *
 * The tray endpoint, simulated.
 *
 * `decideTrayBayAction` transcribed onto what `/json` carries,
 * so the ⏏ toggle can be built and demonstrated with no daemon
 * at all. Transcribed rather than imported for the same reason
 * as everything else in this file (see the header), and the
 * branch ORDER is copied deliberately: the refusal that protects
 * a running rip is first there and is first here, so a mock
 * cannot teach a UI unit that a ripping bay opens.
 *
 * ⚠️ The default scenario is `nine-rips` — nine bays mid-rip —
 * so pressing ⏏ on any of them in the browser produces a real
 * `refused_ripping` with the daemon's own sentence. That is on
 * purpose: the refusal is the state the toggle most has to
 * render well, and a mock where every press succeeds is a mock
 * that hides it.
 * ------------------------------------------------------------ */

/** Job states meaning rip-deck is finished with what is in there. */
const LATCHED_MOCK_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "needs_attention",
])

const decideMockTrayResult = (input: {
  command: TrayCommandWord
  bay: BayView
  /** Resolved by the caller over the whole fixture, like the daemon. */
  openScope: "finished" | "all"
  /** What rip-deck last did to THIS bay's drawer. */
  lastTrayCommand: "open_bay" | "close_bay" | null
  /** `rip_bay` only: the name the operator typed. */
  name?: string | null
}): { result: TrayBayResultKind; detail: string } => {
  const { bay, command, openScope, lastTrayCommand } = input

  if (!bay.is_present) {
    return {
      result: "skipped_not_present",
      detail: "the drive is not on the bus right now",
    }
  }

  // ⚠️ THE REFUSAL, first, exactly as the daemon orders it.
  // Ejecting mid-rip destroys 90 GB and an hour, and it is
  // checked for every command kind including one an operator
  // aimed deliberately.
  if (TRAY_REFUSED_STATES.has(bay.state.state)) {
    return {
      result: "refused_ripping",
      detail:
        `REFUSED — this bay is ${bay.state.state}. Opening ` +
        "the tray now would destroy the rip in progress. " +
        "Nothing was touched.",
    }
  }

  const hasDisc = bay.disc_size_sectors != null

  switch (command) {
    case "rip_bay":
      // The one thing a rip needs and a tray command does not:
      // something to rip. Everything else a held bay is — latched,
      // flagged, quarantined, out of starts — is what the operator
      // is pressing the button to overrule.
      return hasDisc
        ? {
            result: "rip_started",
            detail:
              input.name == null
                ? "reading the disc's own name, then ripping"
                : `ripping as "${input.name}"`,
          }
        : {
            result: "skipped_no_disc",
            detail:
              "there is no disc in this bay to rip. Put one " +
              "in and it will rip on its own.",
          }

    case "open_bay":
      return {
        result:
          bay.state.state === "completed"
            ? "opened"
            : "opened_not_ripped",
        detail: "the tray is open",
      }

    case "close_bay":
      return {
        result: "closed",
        detail: "the tray is shut",
      }

    case "open_trays":
      // `"all"` is the escalation (second press, or nothing
      // finished): open every non-ripping bay, empty ones too.
      if (openScope === "all") {
        return {
          result:
            bay.state.state === "completed"
              ? "opened"
              : "opened_not_ripped",
          detail: "the tray is open",
        }
      }

      // `"finished"` — open only the finished-with-disc bays.
      if (
        !bay.is_quarantined &&
        !LATCHED_MOCK_STATES.has(bay.state.state)
      ) {
        return {
          result: "skipped_not_finished",
          detail:
            "nothing in this bay is finished with, so there " +
            "is nothing to take out",
        }
      }

      // Latched, but the disc has already gone — the operator
      // opened this bay a minute ago and took it.
      if (!hasDisc) {
        return {
          result: "skipped_no_disc",
          detail: "there is no disc in this bay",
        }
      }

      return {
        result:
          bay.state.state === "completed"
            ? "opened"
            : "opened_not_ripped",
        detail: "the tray is open",
      }

    case "close_trays":
      // Close only what rip-deck opened. `lastTrayCommand` is the
      // authority on tray position — disc presence is not.
      return lastTrayCommand === "open_bay"
        ? { result: "closed", detail: "the tray is shut" }
        : {
            result: "skipped_already_closed",
            detail:
              "this bay is not open, so there is nothing to " +
              "close",
          }

    case "power_off":
      // Cutting mains moves no drawer. The refusal above is the
      // whole of this command's per-bay question.
      return {
        result: "skipped_untouched",
        detail:
          "the tower's power was cut; this bay's tray was " +
          "not touched",
      }

    case "clear_loaded":
      // Answered on its own bulk path above and never per bay, the
      // same as the daemon. This case only keeps the switch total;
      // forgetting a disc moves no drawer.
      return {
        result: "skipped_untouched",
        detail:
          "the loaded-discs reminder was cleared; no tray was " +
          "touched",
      }
  }
}

const EMPTY_TRAY_COUNTS: TrayCommandCounts = {
  opened: 0,
  opened_not_ripped: 0,
  closed: 0,
  refused: 0,
  failed: 0,
  skipped: 0,
  rip_started: 0,
}

/** `buildTrayCommandResponse`'s counts, over the same results. */
const countTrayResults = (
  bays: TrayBayReport[],
): TrayCommandCounts => ({
  opened: bays.filter((bay) => bay.result === "opened")
    .length,
  opened_not_ripped: bays.filter(
    (bay) => bay.result === "opened_not_ripped",
  ).length,
  closed: bays.filter((bay) => bay.result === "closed")
    .length,
  refused: bays.filter(
    (bay) => bay.result === "refused_ripping",
  ).length,
  failed: bays.filter((bay) => bay.result === "failed")
    .length,
  skipped: bays.filter((bay) =>
    bay.result.startsWith("skipped_"),
  ).length,
  rip_started: bays.filter(
    (bay) => bay.result === "rip_started",
  ).length,
})

/** `buildTrayCommandMessage`, shortened to what a page shows. */
/**
 * The take-the-discs-out reminder, folded the same way the daemon
 * folds it (`rip/loadedDiscs.ts`): a bay holding a disc rip-deck
 * is finished with.
 *
 * Deliberately a re-implementation and not an import — this file
 * mirrors the daemon rather than depending on it, for the same
 * reason `types.ts` does. `mockDataSource.test.ts` pins the
 * phrases against the daemon's own tests.
 */
const buildMockLoadedDiscs = (
  bays: BayView[],
): LoadedDiscsView => {
  const discs = bays
    .filter(
      (bay) =>
        bay.disc_size_sectors != null &&
        !drift.loadedDismissed.has(bay.drive_id) &&
        (bay.is_quarantined ||
          LATCHED_MOCK_STATES.has(bay.state.state)),
    )
    .map((bay) => ({
      slot: bay.slot,
      label: bay.label,
      title: bay.state.title,
      is_ripped: bay.state.state === "completed",
    }))
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99))

  const isTowerOn = bays.some((bay) => bay.is_present)

  // "1, 7, 8 and 9" — the daemon's `formatBayList`, mirrored. A
  // plain join reads as a CSV rather than as a sentence.
  const names = discs.map((disc) =>
    disc.slot === null ? disc.label : String(disc.slot),
  )

  const where =
    names.length <= 1
      ? names.join("")
      : `${names.slice(0, -1).join(", ")} and ${
          names[names.length - 1]
        }`

  return {
    count: discs.length,
    slots: discs
      .map((disc) => disc.slot)
      .filter((slot): slot is number => slot !== null),
    discs,
    is_tower_on: isTowerOn,
    message:
      discs.length === 0
        ? ""
        : `${
            discs.length === 1
              ? "1 disc is"
              : `${String(discs.length)} discs are`
          } still in the tower — ${
            discs.length === 1 ? "slot" : "slots"
          } ${where}. ${
            isTowerOn
              ? `Press Open trays to get ${
                  discs.length === 1 ? "it" : "them"
                } out.`
              : "The tower is off, so the trays cannot open " +
                "until it is powered back on."
          }`,
    spoken_message:
      discs.length === 0
        ? ""
        : `${String(discs.length)} discs are still in the ` +
          "optical ripper tower.",
    updated_at: Date.now(),
  }
}

const buildMockTrayMessage = (
  bays: TrayBayReport[],
): string => {
  const countOf = (kinds: TrayBayResultKind[]): number =>
    bays.filter((entry) => kinds.includes(entry.result))
      .length

  const sentences: string[] = []
  const refused = countOf(["refused_ripping"])
  const opened = countOf(["opened", "opened_not_ripped"])
  const closed = countOf(["closed"])
  const ripping = countOf(["rip_started"])

  // A refusal is said FIRST — it is the only line that means
  // someone must not do the thing they were about to do.
  if (refused > 0) {
    sentences.push(
      `Refused to open ${String(refused)} ` +
        `${refused === 1 ? "drive" : "drives"}: still ripping.`,
    )
  }

  if (ripping > 0) {
    sentences.push(
      `Ripping ${String(ripping)} ` +
        `${ripping === 1 ? "bay" : "bays"}.`,
    )
  }

  if (opened > 0) {
    sentences.push(`Opened ${String(opened)} drives.`)
  }

  if (closed > 0) {
    sentences.push(`Closed ${String(closed)} drives.`)
  }

  // Never an empty string: silence is indistinguishable from a
  // broken button.
  return sentences.length > 0
    ? `(mock) ${sentences.join(" ")}`
    : "(mock) Nothing to do — no tray moved."
}

export const mockDataSource: RipDeckDataSource = {
  fetchState(fixture) {
    // Advance the lead rip a touch each poll (capped below 100
    // so it stays in progress); makemkv reports one decimal.
    drift.leadPercent = Math.min(
      99.8,
      Math.round((drift.leadPercent + 0.6) * 10) / 10,
    )

    const name =
      typeof fixture === "string" && isFixtureName(fixture)
        ? fixture
        : DEFAULT_FIXTURE

    // Remembered so `runTrayCommand` can report on the bays the
    // page is actually looking at.
    drift.fixture = name

    return delay(createFixtureState(name))
  },

  fetchLog(jobUuid, lines = 600) {
    // The mock has one short capture, so `lines` cannot really
    // truncate anything — but it is echoed rather than ignored,
    // so a modal offering "load all" can be seen asking for it.
    const scope =
      lines === "all"
        ? "whole capture"
        : `last ${String(lines)} lines`

    return delay(
      `# mock ${scope} — ${jobUuid}.robot.log\n${MOCK_LOG}`,
      150,
    )
  },

  runBayAction({ driveId, action }) {
    // Tray words are routed to the real simulation rather than
    // half-modelled here, matching `httpDataSource`: one code
    // path decides what a tray command does, in both sources.
    if (action === "open_bay" || action === "close_bay") {
      return mockDataSource
        .runTrayCommand({ command: action, driveId })
        .then((report) =>
          trayReportToActionResult({ driveId, report }),
        )
    }

    // The mock is where the job actions actually do something,
    // so the controls can be exercised without the transport
    // none of them has yet — see `httpDataSource.runBayAction`.
    switch (action) {
      case "clear_quarantine":
        drift.quarantineCleared.add(driveId)
        break
      case "cancel":
      case "give_up":
        drift.cancelled.add(driveId)
        break
      case "keep_trying":
        drift.keepTrying.add(driveId)
        break
      // No `open_bay` / `close_bay` arm: the early return above
      // routed both to `runTrayCommand`, and TypeScript has
      // already narrowed them out of `action` here.
      case "retry_in_another_drive":
        break
    }

    const result: ActionResult = {
      ok: true,
      msg: `(mock) ${action} on ${driveId}`,
    }

    return delay(result, 150)
  },

  /**
   * A tray command against the scenario currently on screen.
   *
   * ⚠️ It reports on the scenario this source last SERVED, since
   * that is the only record it has of which rack the caller is
   * looking at. The app cannot offer a tray control without
   * having polled first, so the ordering is the app's own — but
   * a test that skips `fetchState` gets the default scenario's
   * bays, which are nine bays mid-rip.
   *
   * Answers the same report `resp/drive` publishes, refusals and
   * all, so the ⏏ toggle and the header's bulk button can be
   * built, styled and demonstrated with no daemon and no tower.
   *
   * The two drift effects are the honest ones: an opened bay
   * reads EMPTY afterwards (the disc is in the operator's hand,
   * which is how a held disc is released), and BOTH commands
   * record `last_tray_command` — including `close_bay`, which
   * changes nothing else observable and is the only reason a
   * closed empty tray can be told from an open one at all.
   */
  runTrayCommand({ command, driveId, name }) {
    const startedAtMs = Date.now()
    const bays = createFixtureState(drift.fixture).ripDeck
      .bays

    const isBulk =
      command === "open_trays" ||
      command === "close_trays" ||
      command === "power_off" ||
      command === "clear_loaded"

    const targeted = isBulk
      ? bays
      : bays.filter((bay) => bay.drive_id === driveId)

    // A single-bay command naming a bay that is not there is a
    // REJECTION, not an empty success — `buildTrayCommandRejection`
    // answers on the same shape so a caller has one place to
    // look and `is_accepted` to branch on.
    if (!isBulk && targeted.length === 0) {
      return delay(
        {
          request_id: null,
          command: null,
          is_accepted: false,
          message: `Tray command refused: no bay is ${String(driveId)}.`,
          started_at: startedAtMs,
          finished_at: startedAtMs,
          counts: EMPTY_TRAY_COUNTS,
          bays: [],
        },
        150,
      )
    }

    // ⚠️ Cutting mains is answered on its own path, exactly as
    // the daemon does: one bay mid-rip refuses the WHOLE press,
    // because there is one power lead. Loaded-but-idle discs are
    // warned about and the tower goes off anyway.
    if (command === "power_off") {
      const ripping = bays.filter((bay) =>
        TRAY_REFUSED_STATES.has(bay.state.state),
      )

      const loaded = bays.filter(
        (bay) =>
          bay.disc_size_sectors != null &&
          (bay.is_quarantined ||
            LATCHED_MOCK_STATES.has(bay.state.state)),
      )

      return delay(
        ripping.length > 0
          ? {
              request_id: null,
              command,
              is_accepted: true,
              message:
                "(mock) NOT powering the tower off — a rip " +
                "is still running.",
              spoken_message:
                "Not turning the optical ripper tower off. " +
                "A rip is still running, and cutting power " +
                "now would lose it.",
              started_at: startedAtMs,
              finished_at: Date.now(),
              counts: {
                ...EMPTY_TRAY_COUNTS,
                refused: ripping.length,
              },
              bays: ripping.map((bay) => ({
                drive_id: bay.drive_id,
                slot: bay.slot,
                label: bay.label,
                result: "refused_ripping" as const,
                detail:
                  `REFUSED — this bay is ${bay.state.state}.` +
                  " Nothing was touched.",
              })),
            }
          : {
              request_id: null,
              command,
              is_accepted: true,
              message:
                "(mock) Turning the optical ripper tower " +
                `off.${
                  loaded.length === 0
                    ? ""
                    : ` ⚠️ ${String(loaded.length)} disc(s)` +
                      " still loaded, and an unpowered drive" +
                      " will not open its tray."
                }`,
              spoken_message:
                "Turning the optical ripper tower off.",
              started_at: startedAtMs,
              finished_at: Date.now(),
              counts: EMPTY_TRAY_COUNTS,
              bays: [],
            },
        150,
      )
    }

    // ⚠️ Forgetting the loaded discs is its own path, exactly as
    // the daemon does: it moves no tray and reports through the
    // message alone.
    //
    // The banner DOES empty here, including for bays whose drive
    // is present and still reporting its disc — which is the
    // whole of the fix, and what this demo used to get wrong in
    // the same way the daemon did. The bay's own card is left
    // exactly where it was, because the press is about the
    // reminder and never about the rip.
    if (command === "clear_loaded") {
      const loaded = bays.filter(
        (bay) =>
          bay.disc_size_sectors != null &&
          !drift.loadedDismissed.has(bay.drive_id) &&
          (bay.is_quarantined ||
            LATCHED_MOCK_STATES.has(bay.state.state)),
      )

      for (const bay of loaded) {
        drift.loadedDismissed.add(bay.drive_id)
      }

      return delay(
        {
          request_id: null,
          command,
          is_accepted: true,
          message:
            loaded.length === 0
              ? "(mock) Nothing was loaded, so there was no " +
                "reminder to clear."
              : `(mock) Cleared the reminder — ${String(
                  loaded.length,
                )} disc(s) marked as taken out.`,
          spoken_message: "",
          started_at: startedAtMs,
          finished_at: Date.now(),
          counts: EMPTY_TRAY_COUNTS,
          bays: [],
        },
        150,
      )
    }

    // Tray memory for this demo session: what the operator has
    // opened/closed so far. `open_trays` escalation and
    // `close_trays` both read it, exactly like the daemon.
    const lastTrayOf = (
      bay: BayView,
    ): "open_bay" | "close_bay" | null =>
      drift.lastTrayCommand.get(bay.drive_id) ?? null

    // The escalation, resolved over the whole fixture: the first
    // press opens the finished-with-disc bays, and once they are
    // all open the next widens to "all".
    const finishedBays = bays.filter(
      (bay) =>
        bay.is_present &&
        bay.disc_size_sectors != null &&
        (bay.is_quarantined ||
          LATCHED_MOCK_STATES.has(bay.state.state)),
    )
    const openScope: "finished" | "all" =
      finishedBays.length > 0 &&
      !finishedBays.every(
        (bay) => lastTrayOf(bay) === "open_bay",
      )
        ? "finished"
        : "all"

    const reported: TrayBayReport[] = targeted.map(
      (bay) => {
        const { result, detail } = decideMockTrayResult({
          bay,
          command,
          openScope,
          lastTrayCommand: lastTrayOf(bay),
          // Same trim the daemon does: blank is no name, never a
          // disc called "".
          name:
            name === undefined || name.trim() === ""
              ? null
              : name.trim(),
        })

        if (
          result === "opened" ||
          result === "opened_not_ripped"
        ) {
          drift.trayOpened.add(bay.drive_id)
          drift.lastTrayCommand.set(
            bay.drive_id,
            "open_bay",
          )
        }

        if (result === "closed") {
          drift.lastTrayCommand.set(
            bay.drive_id,
            "close_bay",
          )
        }

        return {
          drive_id: bay.drive_id,
          slot: bay.slot,
          label: bay.label,
          result,
          detail,
        }
      },
    )

    return delay(
      {
        request_id: null,
        command,
        // TRUE even when every bay was refused: the daemon heard
        // the command and answered it. Whether a tray moved is
        // the per-bay `result`, and conflating the two is how a
        // caller reports "failed" about a bay it correctly
        // protected.
        is_accepted: true,
        message: buildMockTrayMessage(reported),
        started_at: startedAtMs,
        finished_at: Date.now(),
        counts: countTrayResults(reported),
        bays: reported,
      },
      150,
    )
  },
}

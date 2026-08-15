import {
  isAnnounceable,
  isJobActive,
  type Verdict,
  type VerdictAction,
  type VerdictConfidence,
  type VerdictKind,
  type VerdictSubject,
} from "@rip-deck/contracts"
import {
  buildDriveAlertPayload,
  buildRipEventPayload,
  type DriveAlertPayload,
  type RipEventPayload,
} from "../mqtt/announcement.ts"
import { createTopicConfig } from "../mqtt/config.ts"
import {
  buildDriveStatePayload,
  type DriveStatePayload,
} from "../mqtt/driveState.ts"
import {
  buildTopics,
  driveSlug,
  type TopicConfig,
} from "../mqtt/topics.ts"
import {
  buildLoadedDiscsPayload,
  type LoadedDiscsPayload,
  summariseLoadedDiscs,
} from "../rip/loadedDiscs.ts"
import type {
  BaySnapshot,
  TowerSnapshot,
} from "./snapshot.ts"

/**
 * The rip-deck-native view of the tower — Stage 4's half of
 * "MQTT parity".
 *
 * Parity is achieved by CONSTRUCTION, not by agreement: every
 * per-bay body here is the very same object the MQTT bridge
 * publishes, produced by the very same builder in
 * `packages/daemon/src/mqtt/`. Re-deriving the shapes here would
 * mean two sources of truth for a payload that Home Assistant
 * already reads, and the first divergence would be silent.
 *
 * Two deliberate differences from what goes on the wire, both
 * required and both tested:
 *
 *  1. `/json` shows a `suspected` verdict; MQTT does not publish
 *     it. Only `confirmed` (two drives agreeing) may announce —
 *     a suspected disc verdict is a card with a "retry in
 *     another drive" affordance, not something worth
 *     interrupting anyone over. `is_announceable` says which is
 *     which, per bay.
 *  2. `/json` is a snapshot of ALL bays at once; MQTT is a
 *     stream of per-bay retained topics. The owner has asked for
 *     nine concurrent rips, so the view is a list, never "the
 *     current job".
 *
 * `rip/event`'s payload is NOT reshaped here.
 * `automation.job_status_announcement` is shared with the 3D and
 * 2D print pipelines and its spec says replacing the disc
 * pipeline changes only the SOURCE TOPIC — so `last_rip` carries
 * `buildRipEventPayload`'s output byte for byte.
 */

/** What the UI may offer for a bay. Names only — no endpoint. */
export type BayAction =
  /** Supervision quarantine is cleared by a human, never
   *  automatically (see `DriveSupervisionState`). */
  | "clear_quarantine"
  /** D4: let a struggling rip keep chugging. */
  | "keep_trying"
  | "give_up"
  /** A suspected DISC verdict wants a second drive's opinion,
   *  which is what upgrades it to `confirmed`. */
  | "retry_in_another_drive"
  | "cancel"

export type BayView = {
  drive_id: string
  label: string
  slot: number | null
  /** `/dev/srN`. EPHEMERAL — never an identity. */
  dev_path: string | null
  is_present: boolean
  /**
   * The disc in the tray, in 512-byte sectors; null for none.
   *
   * `is_present` is about the DRIVE. This is the only field that
   * says a bay is holding something — which a bay latched on a
   * finished disc needs, because it has no active job to show.
   */
  disc_size_sectors: number | null
  /**
   * The last tray command RIP DECK ITSELF sent this bay.
   *
   * ⚠️ **Not a reading of the hardware, and there is none to be
   * had.** sysfs reports MEDIA, not the door: an open tray and a
   * closed empty tray are the same bytes, and separating them
   * needs a `CDROM_DRIVE_STATUS` ioctl Node cannot issue
   * (`docs/eject-and-durable-bay-state.md` §2). What this field
   * is instead is rip-deck's memory of its own last act — *"the
   * last thing I did was open it"* — which is the most honest
   * basis the dashboard's ⏏ open/close toggle can stand on.
   * `web/src/format.ts` `nextTrayCommandFor` states the
   * inference where it makes it.
   *
   * Null for a bay rip-deck has never moved, and for one it
   * refused or skipped — neither touched a drawer.
   */
  last_tray_command: "open_bay" | "close_bay" | null
  is_quarantined: boolean
  quarantine_reason: string | null
  /** Byte-for-byte the retained `drive/<slug>` payload. */
  state: DriveStatePayload
  state_topic: string
  /**
   * Byte-for-byte the `drive/<slug>/alert` payload — but present
   * for `suspected` verdicts too, which MQTT withholds. Null
   * when the verdict is `ok`, which is the default and needs no
   * card.
   */
  alert: DriveAlertPayload | null
  alert_topic: string
  verdict_confidence: VerdictConfidence | null
  /** True when MQTT would also publish this alert. */
  is_announceable: boolean
  actions: BayAction[]
}

/**
 * One trouble, and every bay it touches.
 *
 * Grouping is presentation, not diagnosis: nothing here invents
 * or upgrades a verdict. It exists because a hub fault is ONE
 * problem — "several drives on the same USB hub stopped
 * responding together" — and listing it four times as four disc
 * problems is precisely the confidently-wrong reading the
 * verdict model was built to prevent.
 */
export type TowerAlert = {
  verdict: VerdictKind
  subject: VerdictSubject
  action: VerdictAction
  message: string
  confidence: VerdictConfidence
  is_announceable: boolean
  drive_ids: string[]
  labels: string[]
}

export type TowerView = {
  schema_version: 1
  host: string
  /** Epoch ms, so a stale dashboard is visibly stale. */
  generated_at: number
  /** True when this is a fixture, so nobody mistakes it. */
  is_fake: boolean
  fixture: string | null
  is_mqtt_enabled: boolean
  /**
   * F3: FALSE is normal, not an error. The owner powers the
   * tower independently; an empty rack means "switched off",
   * and rendering it as a fault trains him to ignore faults.
   */
  is_tower_present: boolean
  drive_count: number
  /** Bays with a live `makemkvcon` child right now. */
  active_count: number
  bays: BayView[]
  alerts: TowerAlert[]
  /**
   * A flapping USB bus, or null when it is steady.
   *
   * Its OWN field, deliberately kept out of `alerts`: `alerts` is
   * an aggregation of per-BAY verdicts, and the dashboard filters
   * it to alerts touching a non-held bay. A flap is exactly the
   * thing that HOLDS bays, so folding it into `alerts` would let
   * its own symptom hide it. It is also job-independent — it fires
   * on an idle tower sitting on a bad cable, when there are no bay
   * verdicts to aggregate at all.
   */
  usb_alert: TowerAlert | null
  /**
   * The discs still sitting in the tower, waiting for a human.
   *
   * A CHORE, not an alert — nothing is wrong and nothing is
   * urgent, it just stays true until somebody walks over to the
   * rack. Its own field for the same reason `usb_alert` has one:
   * `alerts` aggregates per-BAY verdicts, and this is a tower-wide
   * fact that is loudest precisely when there are no bay verdicts
   * at all, because the tower has been switched off.
   *
   * Folded from the same `bays` below, so `/json` needs no second
   * source — but note that the MQTT copy is RETAINED and this one
   * is not: a dashboard reload re-reads a live daemon, while the
   * reminder has to outlive one. See `rip/loadedDiscs.ts`.
   */
  loaded_discs: LoadedDiscsPayload
  /** Byte-for-byte the retained `rip/last` payload. */
  last_rip: RipEventPayload | null
  last_rip_topic: string
  availability_topic: string
  /** Empty string when healthy. Never set by an empty rack. */
  error: string
}

const buildBayActions = (bay: BaySnapshot): BayAction[] => {
  const actions: BayAction[] = []

  if (bay.supervision.isQuarantined) {
    actions.push("clear_quarantine")
  }

  const { job } = bay

  if (!job) return actions

  const isActive = isJobActive(job.state)
  const isTroubled = job.verdict.kind !== "ok"

  if (
    isActive &&
    isTroubled &&
    !job.isKeepTryingRequested
  ) {
    actions.push("keep_trying", "give_up")
  }

  if (
    isTroubled &&
    job.verdict.subject === "disc" &&
    job.verdict.confidence === "suspected"
  ) {
    actions.push("retry_in_another_drive")
  }

  if (isActive) actions.push("cancel")

  return actions
}

const buildBayView = (input: {
  bay: BaySnapshot
  topics: ReturnType<typeof buildTopics>
  nowMs: number
}): BayView => {
  const { bay, topics, nowMs } = input
  const slug = driveSlug(bay.driveId)
  const verdict: Verdict | null = bay.job?.verdict ?? null

  return {
    drive_id: bay.driveId,
    label: bay.label,
    slot: bay.slot,
    dev_path: bay.devPath,
    is_present: bay.isPresent,
    disc_size_sectors: bay.discSizeSectors,
    last_tray_command:
      bay.disc?.bay.lastTrayCommand ?? null,
    is_quarantined: bay.supervision.isQuarantined,
    quarantine_reason: bay.supervision.quarantineReason,
    state: buildDriveStatePayload({
      job: bay.job,
      driveLabel: bay.label,
      slot: bay.slot,
      nowMs,
      // The tray, so `state` here really is byte-for-byte the
      // retained `drive/<slug>` payload the comment above
      // promises. Omitting it left `/json` without `has_disc`,
      // `is_holding_finished_disc`, `disc_name`,
      // `destination_path`, `is_present`, `disc_size_sectors`
      // and `is_adopted` — the seven fields that tell a bay
      // holding a finished disc apart from an empty one, which
      // is the situation that whole half of the payload was
      // added to correct. `undefined` (a producer with no bay
      // table, e.g. a fixture) still OMITS them rather than
      // claiming `has_disc: false` on its behalf.
      disc: bay.disc ?? undefined,
    }),
    state_topic: topics.driveState(slug),
    alert:
      verdict && verdict.kind !== "ok"
        ? buildDriveAlertPayload({
            verdict,
            driveLabel: bay.label,
            slot: bay.slot,
          })
        : null,
    alert_topic: topics.driveAlert(slug),
    verdict_confidence: verdict?.confidence ?? null,
    is_announceable: verdict
      ? isAnnounceable(verdict)
      : false,
    actions: buildBayActions(bay),
  }
}

const buildTowerAlerts = (
  bays: BaySnapshot[],
): TowerAlert[] => {
  const alertsByKind = new Map<VerdictKind, TowerAlert>()

  for (const bay of bays) {
    const verdict = bay.job?.verdict

    // `ok` is the default verdict and carries no news.
    if (!verdict || verdict.kind === "ok") continue

    const existing = alertsByKind.get(verdict.kind)

    if (!existing) {
      alertsByKind.set(verdict.kind, {
        verdict: verdict.kind,
        subject: verdict.subject,
        action: verdict.action,
        message: verdict.message,
        confidence: verdict.confidence,
        is_announceable: isAnnounceable(verdict),
        drive_ids: [bay.driveId],
        labels: [bay.label],
      })

      continue
    }

    existing.drive_ids.push(bay.driveId)
    existing.labels.push(bay.label)

    // One bay's confirmation is enough to confirm the trouble;
    // the other bays are additional evidence for it, not
    // counter-evidence.
    if (verdict.confidence === "confirmed") {
      existing.confidence = "confirmed"
    }

    existing.is_announceable =
      existing.is_announceable || isAnnounceable(verdict)
  }

  return [...alertsByKind.values()]
}

/**
 * Turn a flapping bus into the banner that tells the owner to
 * change the cable.
 *
 * Reuses the `hub_fault` KIND — the alert model already has one
 * verdict for "the USB hub or its power, not your discs", which is
 * exactly what a flap is, and it already carries the red hardware
 * tone and the `check_hub` action. Only the MESSAGE is
 * flap-specific, and `TowerAlert.message` is free text per alert,
 * so no new verdict kind is spent. `confidence: "confirmed"`
 * because this is a directly observed fact (drives crossed the bus
 * repeatedly), not an inference from read timings.
 *
 * `is_announceable: false` on purpose: this is a screen banner,
 * not something to read aloud over MQTT every five seconds while
 * the cable stays bad.
 */
const buildUsbAlert = (
  snapshot: TowerSnapshot,
): TowerAlert | null => {
  if (!snapshot.usbStability.isUnstable) return null

  const flapping = new Set(
    snapshot.usbStability.flappingDriveIds,
  )
  const labels = snapshot.bays
    .filter((bay) => flapping.has(bay.driveId))
    .map((bay) => bay.label)

  return {
    verdict: "hub_fault",
    subject: "hub",
    action: "check_hub",
    message:
      "The USB connection to the tower keeps dropping and " +
      "reconnecting. Discs cannot be read reliably while this " +
      "is happening — a drive that flaps mid-read is why a disc " +
      'lands as "could not read a name". Try a different USB ' +
      "cable or port; a passive extension, or two cables joined, " +
      "is the usual cause.",
    confidence: "confirmed",
    is_announceable: false,
    drive_ids: [...snapshot.usbStability.flappingDriveIds],
    labels,
  }
}

export const buildTowerView = (input: {
  snapshot: TowerSnapshot
  nowMs: number
  isFake?: boolean
  fixture?: string | null
  topicConfig?: TopicConfig
}): TowerView => {
  const {
    snapshot,
    nowMs,
    isFake = false,
    fixture = null,
    topicConfig = createTopicConfig(),
  } = input

  const topics = buildTopics(topicConfig)

  return {
    schema_version: 1,
    host: snapshot.host,
    generated_at: nowMs,
    is_fake: isFake,
    fixture,
    is_mqtt_enabled: snapshot.isMqttEnabled,
    is_tower_present: snapshot.bays.some(
      (bay) => bay.isPresent,
    ),
    drive_count: snapshot.bays.length,
    active_count: snapshot.bays.filter(
      (bay) =>
        bay.job !== null && isJobActive(bay.job.state),
    ).length,
    bays: snapshot.bays.map((bay) =>
      buildBayView({ bay, topics, nowMs }),
    ),
    alerts: buildTowerAlerts(snapshot.bays),
    usb_alert: buildUsbAlert(snapshot),
    loaded_discs: buildLoadedDiscsPayload({
      // The watcher's own summary when it provided one — the SAME
      // fold MQTT publishes, phantoms from the on-disk ledger
      // included, so `/json` and the reminder never disagree after
      // a restart against a dark tower
      // ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
      // The fallback below is for a fixture or a watcher-less
      // snapshot, which have no ledger to rebuild from anyway.
      summary:
        snapshot.loadedDiscs ??
        summariseLoadedDiscs(
          // Off `disc.bay` — the watcher's own bay state — and not
          // off the flattened fields beside it. `disc: null` means
          // "this producer was never told about the tray", which is
          // every fixture, and a bay in that state must contribute
          // NOTHING rather than a defaulted `hasDisc: false`. Same
          // rule the tray payload already keeps.
          snapshot.bays.flatMap((bay) =>
            bay.disc === null
              ? []
              : [
                  {
                    slot: bay.slot,
                    label: bay.label,
                    isDrivePresent: bay.isPresent,
                    hasDisc:
                      bay.disc.bay.sizeSectors !== null,
                    isLatched:
                      bay.disc.bay.phase === "done" ||
                      bay.disc.bay.phase === "quarantined",
                    isRipped:
                      bay.disc.bay.outcome?.kind ===
                      "completed",
                    title: bay.disc.bay.discName,
                  },
                ],
          ),
        ),
      nowMs,
    }),
    last_rip: snapshot.lastRip
      ? buildRipEventPayload({
          job: snapshot.lastRip.job,
          verdict: snapshot.lastRip.verdict,
          driveLabel: snapshot.lastRip.driveLabel,
        })
      : null,
    last_rip_topic: topics.ripLast,
    availability_topic: topics.availability,
    error: snapshot.collectorError,
  }
}

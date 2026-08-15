import type {
  Job,
  JobState,
  VerdictKind,
} from "@rip-deck/contracts"
import type { BayState } from "../rip/watcher.ts"

/**
 * Live per-bay state, published RETAINED to
 * `<base>/drive/<slug>`.
 *
 * Retained on purpose: a dashboard or a restarted Home
 * Assistant must be able to read what every bay is doing right
 * now without waiting for the next progress tick. That is the
 * opposite of `rip/event`, which must never be retained.
 *
 * Field names are snake_case to match the `rip/event` contract
 * (H2) — one house style across every topic we publish, so an
 * automation author never has to remember which topic uses
 * which convention.
 *
 * ## Two halves, and why the second one had to be added
 *
 * `state` is the JOB half, and a job is the wrong instrument for
 * the question "is there a disc in there". A bay that finished a
 * rip has no job — `toJobState` is right to give it none, and a
 * card is better absent than invented — but the bay published
 * `"idle"`, so **an empty bay and a bay holding a finished disc
 * were the same word on the wire**. They are opposite physical
 * situations: one needs nothing, the other has a disc a human
 * must take out. Three Troy discs sat latched `completed` in
 * slots 7-9 across restarts while Home Assistant's list of
 * loaded slots rendered `[]`.
 *
 * The fix is the PHYSICAL half below, added alongside `state`
 * rather than folded into it:
 *
 *  - **Additive, deliberately.** `state` already feeds
 *    `sensor.<node>_<slug>_status` and its `value_template`
 *    (`discovery.ts`). Changing what `state` says for a
 *    situation that already publishes would silently rewrite
 *    what an existing HA template sees; adding fields cannot.
 *    They arrive as entity attributes, because the status
 *    sensor sets `json_attributes_topic` to this same topic.
 *  - **Booleans, not a new `state` word,** for the same reason
 *    the API's `BayView` uses `is_present` + `disc_size_sectors`
 *    rather than one enum: presence of the DRIVE, presence of a
 *    DISC and what rip-deck did with it are three independent
 *    facts, and an enum would have to invent a precedence
 *    between them. Booleans let a consumer ask exactly the
 *    question it has.
 */

/** No job attached; the bay is idle or just holding a disc. */
export type DriveActivity = JobState | "idle"

/**
 * The physical half of a bay: what is actually in the tray.
 *
 * Every field is read straight off the bay table — none of it is
 * derived from a job, and none of it is parsed out of a
 * sentence. That is the point: the bay remembers a held disc's
 * name and folder as FIELDS (`bayLedger.ts` v2), so they survive
 * a restart, and a bay adopted at startup has them when it has
 * no job at all.
 */
export type DriveDiscState = {
  /**
   * The drive answered the LAST probe.
   *
   * About the DRIVE, never the disc. False is routine on this
   * tower — a USB re-enumeration or a powered-off rack — and it
   * does NOT mean the tray emptied: the bay keeps its disc
   * memory precisely so a drive that comes back is not treated
   * as a fresh bay that re-rips what it is already holding.
   */
  is_present: boolean
  /**
   * The disc in the tray, in 512-byte sectors; null for none.
   *
   * Named to match the API's `BayView.disc_size_sectors`, which
   * is the same number off the same field.
   */
  disc_size_sectors: number | null
  /**
   * There is a disc in this bay.
   *
   * Redundant with `disc_size_sectors !== null` and published
   * anyway: this is read by HA Jinja templates, where a
   * null-check on an attribute that may also be absent is the
   * step that gets written wrong.
   */
  has_disc: boolean
  /**
   * A disc is loaded and rip-deck is DONE with it.
   *
   * The trapped-disc signal, and the whole reason this half of
   * the payload exists. "Finished" means rip-deck will do nothing
   * further with this disc — **not** that the rip succeeded. A
   * failed rip and a quarantined bay both leave the disc sitting
   * in the tray for a human, which is the same physical
   * situation and the same warning; `state` and `verdict` say
   * which of the three it was.
   */
  is_holding_finished_disc: boolean
  /**
   * This disc was finished with by an EARLIER daemon.
   *
   * True only for a bay adopted from the ledger at startup.
   * Worth publishing rather than inferring, because it is also
   * the explanation for the one hole a consumer will otherwise
   * trip over: an adopted bay has no job, so `title` is null
   * while `disc_name` is not.
   */
  is_adopted: boolean
  /** The disc's own name, as `identifyDisc` read it. */
  disc_name: string | null
  /** Where this bay's rip landed. Null until one has. */
  destination_path: string | null
}

/** What a caller has to hold to describe the tray. */
export type BayDiscFacts = {
  bay: BayState
  /**
   * The drive answered the last probe.
   *
   * Passed in rather than read off `BayState`, because it is not
   * there to read: a sighting is only ever as old as the last
   * poll and is deliberately kept out of the state the ledger
   * persists.
   */
  isDrivePresent: boolean
}

/**
 * The tray, as the wire describes it.
 *
 * A latched terminal phase is `done` OR `quarantined`: `done` is
 * a disc this daemon (or an earlier one) finished with, and
 * `quarantined` is one it refused to keep starting. Both end
 * with a disc in the tray and nothing else going to happen to
 * it.
 */
export const buildDriveDiscState = ({
  bay,
  isDrivePresent,
}: BayDiscFacts): DriveDiscState => {
  const hasDisc = bay.sizeSectors !== null

  const isLatched =
    bay.phase === "done" || bay.phase === "quarantined"

  return {
    is_present: isDrivePresent,
    disc_size_sectors: bay.sizeSectors,
    has_disc: hasDisc,
    is_holding_finished_disc: hasDisc && isLatched,
    is_adopted: bay.isAdopted,
    disc_name: bay.discName,
    destination_path: bay.destinationPath,
  }
}

export type DriveStatePayload = {
  drive: string
  slot: number | null
  state: DriveActivity
  job_id: string | null
  title: string | null
  disctype: string | null
  /** 0–100, rounded. The whole backup, not the current file. */
  progress_percent: number
  /** Null until a rate exists — see the ETA-trend note below. */
  eta_seconds: number | null
  /**
   * `rising` is a signal, not decoration (C6): it is the same
   * d(progress)/dt collapse the health engine watches, visible
   * to the owner before the rip fails.
   */
  eta_trend: "falling" | "steady" | "rising" | null
  throughput_bytes_per_sec: number | null
  /** Non-zero blocks success — never publish it as healthy. */
  read_error_count: number
  verdict: VerdictKind
  /** Epoch milliseconds, so a stale card is visibly stale. */
  updated_at: number
} & Partial<DriveDiscState>

export const buildDriveStatePayload = (input: {
  /** Null when the bay has no job attached. */
  job: Job | null
  /** Display label for the bay, e.g. "07 - Pioneer BDR-211M". */
  driveLabel: string
  slot: number | null
  nowMs: number
  /**
   * The tray, for a caller that holds the bay table.
   *
   * Optional, and the fields are OMITTED when it is absent
   * rather than defaulted: `has_disc: false` from a caller that
   * was never told about the tray is a claim, and the situation
   * this whole half of the payload exists to fix is exactly a
   * false "nothing loaded". Absent reads as "this producer did
   * not say", which is the truth. Every publish to
   * `drive/<slug>` passes it (`watchMqtt.ts`).
   */
  disc?: BayDiscFacts
}): DriveStatePayload => {
  const { job, driveLabel, slot, nowMs } = input

  const disc =
    input.disc === undefined
      ? {}
      : buildDriveDiscState(input.disc)

  if (!job) {
    return {
      drive: driveLabel,
      slot,
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
      ...disc,
    }
  }

  return {
    drive: driveLabel,
    slot,
    state: job.state,
    job_id: job.id,
    title: job.identity?.title ?? null,
    disctype: job.identity?.discType ?? null,
    progress_percent: Math.round(
      job.progress.totalFraction * 100,
    ),
    eta_seconds: job.progress.etaSeconds,
    eta_trend: job.progress.etaTrend,
    throughput_bytes_per_sec:
      job.progress.throughputBytesPerSec,
    read_error_count: job.readErrorCount,
    verdict: job.verdict.kind,
    updated_at: nowMs,
    ...disc,
  }
}

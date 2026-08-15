/**
 * Disc- and drive-health model.
 *
 * The headline requirement: never report success on a rip that
 * had read errors, and say *why* a rip is struggling in
 * language that maps to a physical action.
 *
 * Two rules keep this trustworthy rather than annoying:
 *
 *  1. `ok` is the default. Every other verdict requires
 *     positive evidence.
 *  2. Only `confirmed` confidence is allowed to announce. A
 *     disc verdict seen on a single drive shows in the UI and
 *     offers "retry in another drive"; two drives agreeing
 *     upgrades it to `confirmed`. That makes "always re-test in
 *     a second drive before blaming the disc" mechanical rather
 *     than a habit we have to remember.
 */

/** The closed verdict set. Adding a case is a deliberate act. */
export type VerdictKind =
  | "ok"
  | "hub_fault"
  | "key_expired"
  | "drive_failing"
  | "enumeration_flap"
  | "disc_scratched"
  | "disc_dirty"
  | "disc_marginal_slow"
  | "unknown"

/** What the owner should physically do about it. */
export type VerdictAction =
  | "none"
  | "clean_disc"
  | "replace_disc"
  | "check_drive"
  | "check_hub"
  | "refresh_key"

/**
 * `suspected` renders in the UI and offers a retry.
 * `confirmed` is additionally allowed to announce over MQTT.
 */
export type VerdictConfidence = "suspected" | "confirmed"

/** Whether a verdict blames the disc or the hardware. */
export type VerdictSubject =
  | "disc"
  | "drive"
  | "hub"
  | "system"

export type Verdict = {
  kind: VerdictKind
  action: VerdictAction
  confidence: VerdictConfidence
  subject: VerdictSubject
  /** Plain language, written to be read on a phone. */
  message: string
  /** Why we think so — shown under the message, for trust. */
  evidence: string[]
  /** True when the rip can usefully be left to keep chugging. */
  isKeepTryingSensible: boolean
}

type VerdictTemplate = {
  action: VerdictAction
  subject: VerdictSubject
  message: string
  isKeepTryingSensible: boolean
}

/**
 * Verdict presentation, in one place.
 *
 * Messages name the physical object and the physical action.
 * "Read errors detected" is useless at 2am; "clean the disc" is
 * not.
 */
export const VERDICT_TEMPLATES: Record<
  VerdictKind,
  VerdictTemplate
> = {
  ok: {
    action: "none",
    subject: "disc",
    message: "Reading normally.",
    isKeepTryingSensible: true,
  },
  hub_fault: {
    action: "check_hub",
    subject: "hub",
    message:
      "Several drives on the same USB hub stopped responding " +
      "together — this is the hub or its power, not your discs.",
    isKeepTryingSensible: false,
  },
  key_expired: {
    action: "refresh_key",
    subject: "system",
    message:
      "MakeMKV's key has expired. Every rip will fail until " +
      "it is refreshed.",
    isKeepTryingSensible: false,
  },
  drive_failing: {
    action: "check_drive",
    subject: "drive",
    message:
      "This drive is struggling with discs that read fine " +
      "elsewhere. Suspect the drive, not the disc.",
    isKeepTryingSensible: false,
  },
  enumeration_flap: {
    action: "check_drive",
    subject: "drive",
    message:
      "This drive keeps disconnecting and reappearing. Check " +
      "its cable and power before trusting any rip from it.",
    isKeepTryingSensible: false,
  },
  disc_scratched: {
    action: "replace_disc",
    subject: "disc",
    message:
      "Scratched — the damage is in one continuous band, so " +
      "cleaning will not help. Source another copy.",
    isKeepTryingSensible: true,
  },
  disc_dirty: {
    action: "clean_disc",
    subject: "disc",
    message:
      "Dirty — errors are scattered across the disc, which is " +
      "what fingerprints and smudges look like. Clean it and " +
      "try again.",
    isKeepTryingSensible: true,
  },
  disc_marginal_slow: {
    action: "none",
    subject: "disc",
    message:
      "Slow but reading cleanly. Some pressings just are. " +
      "Leaving it to run is fine.",
    isKeepTryingSensible: true,
  },
  unknown: {
    action: "none",
    subject: "disc",
    message:
      "Not enough information to judge this rip yet.",
    isKeepTryingSensible: true,
  },
}

export const makeVerdict = (
  kind: VerdictKind,
  confidence: VerdictConfidence,
  evidence: string[],
): Verdict => {
  const template = VERDICT_TEMPLATES[kind]

  return {
    kind,
    action: template.action,
    confidence,
    subject: template.subject,
    message: template.message,
    evidence,
    isKeepTryingSensible: template.isKeepTryingSensible,
  }
}

/** Only confirmed, non-ok verdicts are allowed to announce. */
export const isAnnounceable = (verdict: Verdict): boolean =>
  verdict.confidence === "confirmed" &&
  verdict.kind !== "ok"

/**
 * Version stamped onto every persisted sample and feature row.
 *
 * Load-bearing rather than ceremonial: the whole point of these
 * rows is to be queried MONTHS later, across jobs recorded by
 * different builds. Without a version, a later change to how
 * `driveThroughputBytesPerSec` is derived silently mixes two
 * different quantities into one column and the tuning query
 * quietly answers the wrong question. Bump it whenever the
 * meaning of any field changes, not merely when a field is
 * added.
 */
export const HEALTH_FEATURE_SCHEMA_VERSION = 1

/** ETA direction over the recent window. */
export type EtaTrend = "falling" | "steady" | "rising"

/**
 * Liveness kinds, duplicated here deliberately.
 *
 * The real union lives in the daemon (`rip/liveness.ts`), and
 * `contracts` must not depend on the daemon. Assignment from
 * the daemon's `LivenessKind` is structural, so the compiler
 * still catches a divergence at the one call site that feeds it.
 */
export type LivenessKindLabel =
  | "starting"
  | "working"
  | "hung"
  | "silent"

/**
 * One observation of a drive, at `sampleIntervalMs` cadence.
 *
 * **This type IS the deliverable.** Every threshold in this
 * system is a guess, and a guess can only be replaced by a
 * measurement that was recorded while a rip was actually
 * running. So each sample is written out whole — raw counters,
 * the deltas derived from them, MakeMKV's parallel view, and the
 * loop's own health — rather than reduced to the handful of
 * numbers today's engine happens to read. Reducing early is what
 * forces a re-rip later, and a re-rip costs 25 minutes and a
 * disc that may no longer be in the house.
 *
 * Three deliberate properties:
 *
 *  1. **Raw counters are kept alongside the deltas.** A derived
 *     figure computed by a build we later find to be wrong can
 *     be recomputed from the raw columns; it cannot be recovered
 *     from its own output.
 *  2. **Nulls are real readings**, meaning "we could not read
 *     this", and are never coerced to 0 — a zero error counter
 *     and an unreadable one are opposite evidence.
 *  3. **Both throughput measurements are recorded.** They are
 *     different physical quantities: the drive-side figure is
 *     what the hardware delivered, the rip-side figure is what
 *     MakeMKV managed to write. A divergence between them is
 *     decrypt or retry overhead, and it is invisible if only one
 *     is stored.
 */
export type HealthSample = {
  schemaVersion: number
  /** Stable identity — the USB-port-path-derived slug. */
  driveId: string
  /** `srN` at sample time. EPHEMERAL; never an identity. */
  kernelName: string
  /** Null when sampling an idle drive, which is the control. */
  jobId: string | null
  /** Monotonic within a job, so a dropped sample is countable. */
  sequence: number
  /** Epoch milliseconds. */
  at: number
  /** Since job start. The x-axis of every later query. */
  elapsedMs: number
  /**
   * Wall time since the previous sample; null on the first.
   *
   * Recorded rather than assumed equal to `sampleIntervalMs`.
   * Every delta below is only meaningful divided by the interval
   * that actually elapsed, and the gap between the two is also
   * the loop's own scheduling jitter — see `maxSchedulingJitterMs`.
   */
  intervalMs: number | null
  /**
   * Wall time since the last read that actually RETURNED
   * counters, which is the span the deltas below cover.
   *
   * Usually equal to `intervalMs` and deliberately separate from
   * it. When a read fails or times out, the next successful one
   * carries a delta spanning both intervals — dividing that by
   * the sampling cadence would report double the real
   * throughput, and a fabricated doubling right after a drive
   * misbehaves is the worst possible moment to be wrong.
   */
  counterIntervalMs: number | null

  // --- Raw sysfs counters, exactly as read. ---------------
  /** `/sys/block/srN/device/ioerr_cnt`, already hex-decoded. */
  ioErrorCount: number | null
  /** Field 1 of `/sys/block/srN/stat`: reads completed. */
  readsCompleted: number | null
  /** Field 3: sectors read (512-byte sectors). */
  sectorsRead: number | null
  /** Field 4: milliseconds spent reading. */
  readTicksMs: number | null
  /** `/sys/block/srN/size`, in 512-byte sectors. */
  sizeSectors: number | null

  // --- Deltas over `intervalMs`. --------------------------
  ioErrorDelta: number | null
  readsCompletedDelta: number | null
  sectorsReadDelta: number | null
  readTicksDeltaMs: number | null

  // --- Derived from the deltas. ---------------------------
  /** Bytes/sec the DRIVE delivered, from `sectorsReadDelta`. */
  driveThroughputBytesPerSec: number | null
  /** Mean milliseconds per read over the interval. */
  avgMsPerRead: number | null
  /**
   * Share of wall time spent inside reads, 0..1 per queue.
   *
   * The invisible-retry signature in one number: a drive at
   * ~1.0 utilisation while `driveThroughputBytesPerSec` has
   * collapsed is spending all its time in reads that return
   * almost nothing, which is exactly what `sr`-layer retries
   * look like from outside. Can exceed 1 when reads overlap.
   */
  readUtilisation: number | null

  // --- MakeMKV's parallel view, when a rip is attached. ---
  /**
   * The current PRGT name.
   *
   * Load-bearing, not decoration. Every PRGT stage restarts PRGV
   * from zero, so any figure aggregated ACROSS a stage boundary
   * is two unrelated series added together — the defect that
   * produced the false "ETA RISING" on a healthy rip. Stamping
   * the stage on every row is what makes a later query able to
   * group correctly instead of repeating that mistake.
   */
  stageLabel: string | null
  /** Since this stage's first sample. */
  stageElapsedMs: number | null
  /** PRGT fraction, 0..1. */
  progressFraction: number | null
  /** PRGC fraction, 0..1. */
  currentFraction: number | null
  bytesWritten: number | null
  /** Bytes/sec as MakeMKV's own progress implies. */
  ripThroughputBytesPerSec: number | null
  etaSeconds: number | null
  etaTrend: EtaTrend | null
  filesAdded: number | null
  /** Read errors reported by MakeMKV so far this job. */
  readErrorCount: number | null

  // --- Liveness, as the rip's own watchdog sees it. -------
  msSinceProgress: number | null
  msSinceEvent: number | null
  livenessKind: LivenessKindLabel | null

  // --- The sampler's own health. --------------------------
  /**
   * `sizeSectors` is the 1 GiB empty-tray sentinel (2097151).
   *
   * A stable value that reaches every check looking like a real
   * disc. Flagged per row so a query can exclude a "rip" of an
   * empty tray rather than averaging it into a baseline.
   */
  isEmptyTraySentinel: boolean
  /**
   * The counter read did not answer within the watchdog.
   *
   * Not merely a lost row — a sysfs read that fails to return is
   * strong evidence of a drive wedged in SCSI error recovery,
   * which is the single most interesting thing a struggling
   * drive does. Recorded rather than retried away.
   */
  isReadTimedOut: boolean
  /** Any counter at all came back. False means a blind sample. */
  hasCounters: boolean
}

/** A read error observed during a job. */
export type HealthError = {
  driveId: string
  jobId: string | null
  at: number
  source: "kmsg" | "makemkv"
  /** SCSI sense key, when we could extract one. */
  senseKey: number | null
  /** Logical block address, for scatter-vs-band clustering. */
  lba: number | null
  raw: string
}

/**
 * One unbroken run of samples whose ETA was rising.
 *
 * This exists to settle an open design question WITH DATA
 * rather than by opinion. On a perfectly healthy Blu-ray, 49 of
 * 722 progress lines reported a rising ETA — every one of them
 * inside the first 13%, while the drive genuinely slowed from
 * 22.7 to 15.5 MB/s. The ETA really was rising, so the trend
 * detector is correct; what is wrong is treating "rising" as an
 * alarm, because normal intra-disc read-speed variation trips it
 * on every disc, and an alarm that fires 49 times on a healthy
 * rip is not an alarm.
 *
 * The candidate answers are: no alarm at all, an alarm on a rise
 * SUSTAINED beyond some duration, or an alarm on throughput
 * relative to the drive's own baseline. Recording each run's
 * duration, where in the rip it sat, and what throughput did
 * across it makes all three answerable by query — and, crucially,
 * answerable on healthy jobs, which are the ones we have. Widening
 * the tolerance until the number looks nicer is not a fix and is
 * explicitly not what this data is for.
 */
export type EtaRisingRun = {
  startAtMs: number
  endAtMs: number
  durationMs: number
  /** Progress fraction at each end — WHERE in the rip it sat. */
  startFraction: number | null
  endFraction: number | null
  /** Runs never span a PRGT boundary; this is the one stage. */
  stageLabel: string | null
  sampleCount: number
  /** Drive-side throughput across the run. */
  startThroughputBytesPerSec: number | null
  minThroughputBytesPerSec: number | null
  endThroughputBytesPerSec: number | null
  /** Errors that appeared during the run. Usually zero. */
  ioErrorDelta: number
}

/**
 * Per-PRGT-stage summary.
 *
 * Aggregating a whole job into one throughput number is the same
 * mistake that produced the false ETA alarm: "Decrypting" and
 * "Copying file" are different physical activities against the
 * same counter. Split by stage, a query can compare like with
 * like — and the preamble's measured ~25 s cost stops being
 * folded into the copy stage's rate.
 */
export type StageFeature = {
  label: string
  firstAtMs: number
  lastAtMs: number
  durationMs: number
  sampleCount: number
  firstFraction: number | null
  lastFraction: number | null
  throughputP50BytesPerSec: number | null
  ioErrorDelta: number
}

/** How the job ended, stamped onto its feature row. */
export type JobFeatureOutcome = {
  isSuccessful: boolean
  /** `FailureReason` as a string, to keep contracts acyclic. */
  failureReason: string | null
  exitCode: number | null
  verdictKind: VerdictKind | null
}

/**
 * The per-job feature vector — one row per rip.
 *
 * `AGENTS.md` promises that "the full feature vector is persisted
 * per job precisely so tuning is a database query rather than a
 * re-rip". This type is that promise made concrete. The samples
 * are the raw evidence; this is the row you actually GROUP BY,
 * and it is deliberately wide, because the cost of an extra
 * column is bytes and the cost of a missing one is another disc
 * and another 25 minutes.
 *
 * Each family of fields answers a threshold that is currently
 * invented:
 *
 *  - the throughput percentiles answer `seedThroughputBytesPerSec`
 *    and `collapseFractionOfBaseline`;
 *  - `avgMsPerRead*` answers `invisibleRetryAvgMsPerRead`;
 *  - `longestNoProgressMs` answers `stallTimeoutMs` /
 *    `stallKillMs` / `stallGraceMs`, by saying how long a HEALTHY
 *    rip goes quiet — which is the number nobody has;
 *  - the `eta*` family answers the open question above.
 *
 * Do not read a threshold off fewer than ~30 real jobs. With two,
 * you are fitting noise.
 */
export type JobFeatureVector = {
  schemaVersion: number
  jobId: string | null
  driveId: string
  kernelName: string
  discBytes: number
  startedAtMs: number
  endedAtMs: number
  durationMs: number

  // --- Provenance of the measurement itself. --------------
  /** Cadence used. A later change must not silently mix eras. */
  sampleIntervalMs: number
  sampleCount: number
  /**
   * Intervals that ran materially long.
   *
   * The empirical check on the rule this whole architecture
   * exists to enforce: a sampler starved of the event loop is a
   * process that blocked somewhere it promised not to. If this
   * is non-zero on a healthy job, something synchronous got in.
   */
  missedSampleCount: number
  maxSchedulingJitterMs: number
  timedOutReadCount: number
  missingCounterSampleCount: number
  emptyTraySentinelSampleCount: number

  // --- Throughput, drive-side. ----------------------------
  driveThroughputP10BytesPerSec: number | null
  driveThroughputP50BytesPerSec: number | null
  driveThroughputP90BytesPerSec: number | null
  /** p90 of the trimmed middle — what the baseline would take. */
  driveThroughputTrimmedP90BytesPerSec: number | null
  /** Throughput as MakeMKV's own progress implies. */
  ripThroughputP50BytesPerSec: number | null

  // --- Latency and retries. -------------------------------
  avgMsPerReadP50: number | null
  avgMsPerReadP90: number | null
  avgMsPerReadMax: number | null
  readUtilisationP90: number | null

  // --- Errors and stalls. ---------------------------------
  ioErrorTotalDelta: number
  readErrorCount: number
  /** Longest observed gap in MakeMKV's forward progress. */
  longestNoProgressMs: number
  /** Longest observed gap in MakeMKV's output of any kind. */
  longestSilenceMs: number

  // --- The ETA question. ----------------------------------
  etaSampleCount: number
  etaRisingSampleCount: number
  etaRisingShare: number
  longestEtaRisingRunMs: number
  /** Progress-fraction span of the widest rising run. */
  maxEtaRisingRunFractionSpan: number | null
  firstEtaRisingFraction: number | null
  lastEtaRisingFraction: number | null
  etaRisingRuns: EtaRisingRun[]

  stages: StageFeature[]
  outcome: JobFeatureOutcome
}

/**
 * Every tunable threshold, in one object.
 *
 * These are guesses. Do not tune them before roughly 30 real
 * jobs have been recorded — with fewer, you are fitting noise.
 */
export const HEALTH_THRESHOLDS = {
  /** Sampling cadence, milliseconds. */
  sampleIntervalMs: 2_000,

  /** Seed baseline until a drive has its own, bytes/sec. */
  seedThroughputBytesPerSec: 17 * 1024 * 1024,

  /** EWMA smoothing factor for the per-drive baseline. */
  baselineEwmaAlpha: 0.2,

  /** Only the middle 60% of a job feeds the baseline. */
  baselineTrimFraction: 0.2,

  /** Below this fraction of baseline counts as a collapse. */
  collapseFractionOfBaseline: 0.35,

  /** A collapse must persist this long to count. */
  collapseMinDurationMs: 30_000,

  /**
   * No forward progress for this long RAISES THE ALARM.
   *
   * It does not kill the job. Warning early and abandoning late
   * are different decisions with different costs: a false alarm
   * costs a glance at a phone, while a false abort throws away
   * an hour of a rip that was about to recover. Telling the
   * owner mid-rip that a bay is struggling is the thing ARM
   * structurally could not do (H3), and is worth having long
   * before we are confident enough to give up.
   */
  stallTimeoutMs: 120_000,

  /**
   * No forward progress for this long ABANDONS the job.
   *
   * Deliberately far beyond `stallTimeoutMs`. The kernel's SCSI
   * error recovery can occupy a single command for up to 600
   * seconds, so anything under ten minutes would reap rips that
   * were merely deep in retries. Suppressed entirely once the
   * operator has answered "keep trying" (D4).
   */
  stallKillMs: 30 * 60 * 1000,

  /**
   * Grace period from job start before stall judgement begins.
   *
   * The head of a rip is the AACS handshake and the BD+ pass,
   * which are genuinely slow and emit no forward progress. Every
   * rip would trip the stall alarm in its first two minutes
   * without this.
   */
  stallGraceMs: 300_000,

  /**
   * Total stdout silence that means the process is wedged rather
   * than working.
   *
   * makemkvcon emits progress several times a second, so total
   * silence is not slowness — it is a thread blocked in the
   * kernel on a device that is not answering. Distinguishing
   * this from "no forward progress" is what separates *dead*
   * from *hung*, which is the whole point of the heartbeat.
   */
  silenceTimeoutMs: 90_000,

  /** avg ms/read above this suggests kernel-level retries. */
  invisibleRetryAvgMsPerRead: 250,

  /** >=N drives in one hub subtree collapsing within the
   *  window is a hub fault, not N disc faults. */
  hubCorrelationMinDrives: 2,
  hubCorrelationWindowMs: 60_000,

  /** Error LBAs within this span count as one band. */
  scratchBandSpanSectors: 100_000,

  /** A band covering >= this share of errors = scratch. */
  scratchBandMinShare: 0.7,

  /** Enumeration events in the window that mean flapping. */
  flapMinEvents: 3,
  flapWindowMs: 300_000,
} as const

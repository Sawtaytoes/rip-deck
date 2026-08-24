import type {
  DiscType,
  EtaTrend,
  JobState,
  VerdictAction,
  VerdictConfidence,
  VerdictKind,
  VerdictSubject,
} from "@rip-deck/contracts"

/**
 * `GET /json`, as the browser sees it.
 *
 * The daemon's `packages/daemon/src/api/jsonDocument.ts` is the
 * source of truth; this file mirrors it. Mirroring rather than
 * importing is the same call the ARM viewer's `types.ts` made
 * against `server.py`, and here it also keeps the browser bundle
 * off `@rip-deck/daemon` — whose `mqtt/config.ts` type-imports a
 * module that reads a file.
 *
 * The closed unions are NOT re-typed. They come from
 * `@rip-deck/contracts`, which `job.ts` describes as "shared
 * daemon <-> UI", so adding a ninth verdict kind fails this
 * package's typecheck instead of silently rendering a card with
 * no colour.
 *
 * ONE document, two readers, exactly as the daemon shipped it:
 *
 *  - `hosts` is the ARM-viewer-shaped compatibility projection.
 *    Every field the ported components already read lives here.
 *  - `rip-deck` is the native view — grouped alerts, per-bay MQTT
 *    payloads, the `suspected` verdicts MQTT withholds, and the
 *    action list. This is what a rip-deck-aware UI should be
 *    migrating onto, field by field.
 */

/** ARM's `kind`. Unknown strings fall back to a generic disc. */
export type MediaKind =
  | "dvd"
  | "bluray"
  | "music"
  | "data"
  | (string & {})

/**
 * One rip, ARM-shaped, with rip-deck's richer fields ALONGSIDE
 * rather than in place of them (`api/armView.ts`).
 *
 * Where the two disagree, prefer the rip-deck field and say so at
 * the call site. The clearest case is the ETA: `start`+`percent`
 * only supports a linear extrapolation, and extrapolating across
 * a MakeMKV stage boundary is precisely what produced a false
 * "ETA RISING" on every healthy rip (HANDOFF §2.4). `eta_seconds`
 * and `eta_trend` are measured.
 */
export type Rip = {
  /**
   * A STABLE SURROGATE derived from the UUID, not an identity.
   * Display and React keys only — never persist or match on it.
   */
  job_id: number
  /** Free-form. Only `success` and `fail` are special-cased. */
  status: string
  kind: MediaKind
  label: string | null
  /** `/dev/srN`. EPHEMERAL — never an identity. */
  drive: string | null
  path: string | null
  /** Null = indeterminate, i.e. the AACS/BD+ preamble. */
  percent: number | null
  stage: string
  active: boolean
  /**
   * Non-null once a capture exists for this job; null hides the
   * card's Logs button.
   *
   * `armView` sent null unconditionally while `/logs` answered
   * 501. Now that it serves the capture, null means THIS job has
   * none — a rip that never started writing one — which is a
   * different fact and still hides the button correctly.
   */
  logfile: string | null
  /**
   * Always false on rip-deck, and the reason is narrower than
   * this repo used to claim. The rule is **never eject-LOOP** —
   * rip-deck must not auto-eject as part of the rip cycle,
   * because that flap-storm is what killed valid rips on other
   * bays. Nothing ever sets this flag, so an unidentified or
   * failed disc stays in the drive until a human asks for it.
   *
   * rip-deck DOES eject on request, over MQTT `cmd/drive`. See
   * `docs/HANDOFF-eject-and-open-questions.md` §1, which is the
   * correction, and `docs/eject-and-durable-bay-state.md` for
   * the command surface.
   */
  ejected: boolean
  poster: string | null
  drive_name: string | null
  tray: "open" | "closed" | "unknown"
  /** ARM's `YYYY-MM-DD HH:MM:SS`, LOCAL wall-clock. */
  start: string | null
  stop: string | null

  // --- rip-deck-native. Prefer these. ---------------------
  /** The real job id. `job_id` above is the surrogate. */
  job_uuid: string
  /** Stable drive identity. `drive` is ephemeral. */
  drive_id: string
  slot: number | null
  disctype: DiscType
  /** House label for the disc type, e.g. "4K". */
  disctype_label: string | null
  volume_label: string | null
  /** Measured, not extrapolated. */
  eta_seconds: number | null
  eta_trend: EtaTrend | null
  throughput_bytes_per_sec: number | null
  /** Non-zero blocks success. Never render this as healthy. */
  read_error_count: number
  verdict: VerdictKind
  verdict_message: string
  /**
   * Narrower than `armView.ArmRip` declares it (`string`),
   * because the value it puts there is `verdict.confidence` and
   * that union is closed. Typing it loosely on this side would
   * only mean the UI could not switch on it exhaustively.
   */
  verdict_confidence: VerdictConfidence
  failure_reason: string | null
  is_adopted: boolean
  is_keep_trying_requested: boolean
}

/** One live physical drive. */
export type Drive = {
  /** Kernel name, e.g. "sr0". EPHEMERAL. */
  name: string | null
  mount: string | null
  /** Surrogate job id ripping here now, or null. */
  current: number | null
  previous: number | null
  maker: string | null
  model: string | null
  serial_id: string | null

  // --- rip-deck-native. -----------------------------------
  drive_id: string
  slot: number | null
  is_quarantined: boolean
  quarantine_reason: string | null
}

/** One ripper host. rip-deck emits exactly one. */
export type Host = {
  host: string
  rips: Rip[]
  drives?: Drive[]
  /**
   * The collector round-trip succeeded. TRUE for an empty rack —
   * zero drives means the tower is switched off, which is normal.
   */
  ok: boolean
  err: string
}

/** Live per-bay state. Byte-for-byte the retained MQTT payload. */
export type DriveStatePayload = {
  drive: string
  slot: number | null
  state: JobState | "idle"
  job_id: string | null
  title: string | null
  disctype: string | null
  progress_percent: number
  eta_seconds: number | null
  eta_trend: EtaTrend | null
  throughput_bytes_per_sec: number | null
  read_error_count: number
  verdict: VerdictKind
  updated_at: number
}

/** Mid-rip trouble alert. Byte-for-byte the MQTT payload. */
export type DriveAlertPayload = {
  drive: string
  slot: number | null
  verdict: VerdictKind
  action: VerdictAction
  message: string
  evidence: string[]
  /** Whether letting it keep chugging is reasonable (D4). */
  is_keep_trying_sensible: boolean
}

/** Terminal rip event. Byte-for-byte the `rip/last` payload. */
export type RipEventPayload = {
  job_id: string
  title: string
  result: "success" | "fail"
  ok: boolean
  disctype: string
  drive: string
  health: "ok" | "slow" | "very_slow" | "unknown"
  verdict: VerdictKind
  verdict_message: string
  verdict_action: VerdictAction
}

/**
 * What the UI may offer for a bay.
 *
 * ⚠️ This comment previously said there would never be a REST
 * transport for any of these, because "drive commands go over
 * MQTT" is the house rule. **That reading was wrong and it
 * shipped a red box at the owner.** The rule is about
 * SERVICE-TO-SERVICE integration — don't build a bespoke HTTP
 * bridge so Home Assistant can poke Rip Deck. Rip Deck's own
 * dashboard calling Rip Deck's own daemon, same origin, same port
 * that already serves `/json`, is one application talking to its
 * own backend; nothing else in the house gains a dependency.
 * (`docs/HANDOFF-stage7-ui-and-naming.md` §2.)
 *
 * So the two halves of this union now differ in transport, and
 * the difference is about what exists rather than what is
 * allowed:
 *
 *  - `open_bay` / `close_bay` are TRAY commands. They ride
 *    `runTrayCommand` -> `POST /api/tray`, which calls the same
 *    `watcher.runTrayCommand` the MQTT path calls. The words are
 *    the daemon's own, spelled exactly as `cmd/drive` accepts
 *    them (`docs/eject-and-durable-bay-state.md` §1), so one
 *    vocabulary serves both callers. They are NOT in
 *    `bay.actions` — `format.trayActionsFor` derives them, and
 *    says why it is allowed to.
 *  - The five JOB actions have no transport at all yet, MQTT
 *    included: `cmd/drive` is the only inbound topic and
 *    `parseTrayCommand` accepts only the four tray words. Their
 *    endpoint is unbuilt, not forbidden — the argument above
 *    applies to them the day someone builds it.
 */
export type BayAction =
  | "clear_quarantine"
  | "keep_trying"
  | "give_up"
  | "retry_in_another_drive"
  | "cancel"
  | "open_bay"
  | "close_bay"

export type BayView = {
  drive_id: string
  label: string
  slot: number | null
  dev_path: string | null
  is_present: boolean
  /**
   * The disc in the tray, in 512-byte sectors; null for none.
   *
   * Optional because a daemon older than this field is still a
   * daemon this dashboard has to render. `is_present` is about
   * the DRIVE; this is the only field that says a bay is holding
   * something.
   */
  disc_size_sectors?: number | null
  /**
   * The last tray command RIP DECK ITSELF sent this bay.
   *
   * ⚠️ **Not a reading of the hardware, and there is no reading
   * of the hardware to be had.** sysfs reports MEDIA, not the
   * door: an open tray and a closed empty tray are the same
   * bytes, and telling them apart needs a `CDROM_DRIVE_STATUS`
   * ioctl Node cannot issue
   * (`docs/eject-and-durable-bay-state.md` §2). Tray POSITION is
   * unknowable here. Do not go looking for the sensor — it is
   * not missing, it does not exist.
   *
   * What this field is instead: rip-deck's memory of its own last
   * act, which is the most honest thing available — *"the last
   * thing I did was open it."* `format.nextTrayCommandFor` turns
   * it into the ⏏ toggle's next press, and states the inference
   * where it is made.
   *
   * Optional: a daemon older than this field is still one we
   * render, and the toggle degrades to `open_bay`.
   */
  last_tray_command?: "open_bay" | "close_bay" | null
  is_quarantined: boolean
  quarantine_reason: string | null
  state: DriveStatePayload
  state_topic: string
  /**
   * Present for `suspected` verdicts too, which MQTT withholds.
   * Null when the verdict is `ok`, which needs no card.
   */
  alert: DriveAlertPayload | null
  alert_topic: string
  verdict_confidence: VerdictConfidence | null
  /** True when MQTT would also publish this alert. */
  is_announceable: boolean
  actions: BayAction[]
  /**
   * The bay outcome's own `detail` — the ONE sentence rip-deck
   * wrote for a human to read, naming the physical next step
   * (`BayOutcome.detail`; `UNKNOWN_AT_STARTUP_DETAIL` in
   * `packages/daemon/src/rip/bayLedger.ts` is the one three
   * discs in the tower are carrying right now).
   *
   * ⚠️ NOTHING SERVES THIS YET. `towerFeed.buildVerdict` folds
   * the detail into the verdict's `evidence` array, mixed in
   * with engine boilerplate, and picking it back out on this
   * side would mean matching English prose — the exact mistake
   * `docs/HANDOFF-eject-and-open-questions.md` §4.4 says not to
   * repeat. So `HeldBayCard` renders the whole evidence list
   * until this arrives, and collapses to one clean sentence the
   * day it does. Optional, so the browser mock and the daemon
   * fixture stay the same shape while it does not exist.
   */
  outcome_detail?: string | null
}

/**
 * One trouble, and every bay it touches.
 *
 * The reason this exists: a hub fault is ONE problem, and
 * listing it four times as four disc problems is the
 * confidently-wrong reading the verdict model was built to
 * prevent. Render this list, not four cards.
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
   * FALSE is normal, not an error (F3). The owner powers the
   * tower independently; an empty rack means "switched off", and
   * painting it red trains him to ignore red.
   */
  is_tower_present: boolean
  drive_count: number
  active_count: number
  bays: BayView[]
  alerts: TowerAlert[]
  /**
   * A flapping USB bus, or null when it is steady.
   *
   * Its own field, not part of `alerts`: `alerts` is filtered to
   * troubles touching a NON-held bay, and a flap is exactly what
   * holds bays — so folding it in would let its own symptom hide
   * it. It also fires with no rip running (an idle tower on a bad
   * cable), when there is no per-bay verdict to carry it.
   */
  usb_alert: TowerAlert | null
  /**
   * The discs still sitting in the tower, waiting for a human.
   *
   * A CHORE, not an alert — nothing is wrong and nothing is
   * urgent, it just stays true until somebody walks over to the
   * rack. Loudest precisely when the tower has been switched off
   * and there is nothing else on this page to see.
   *
   * Optional: a daemon older than 2026-07-30 does not serve it,
   * and the banner then simply does not render.
   */
  loaded_discs?: LoadedDiscsView
  last_rip: RipEventPayload | null
  last_rip_topic: string
  availability_topic: string
  /** Empty string when healthy. Never set by an empty rack. */
  error: string
}

/** The `/json` document. */
export type RipDeckState = {
  hosts: Host[]
  ripDeck: TowerView
}

/** What a bay action reports back. */
export type ActionResult = {
  ok: boolean
  msg: string
}

/**
 * The four tray command words, `cmd/drive`'s vocabulary.
 *
 * Mirrored from the daemon's `rip/trayCommand.ts`
 * `TrayCommandKind` — the same mirroring this file's header
 * argues for, and for the same reason: `@rip-deck/contracts` does
 * not carry these, and importing `@rip-deck/daemon` would pull a
 * module that reads a file into the browser bundle. Pull the
 * union from contracts the day it moves there.
 *
 * `open_trays` / `close_trays` are the bulk pair the physical
 * RODRET's two long presses send; `open_bay` / `close_bay` take
 * one bay.
 */
export type TrayCommandWord =
  | "open_trays"
  | "close_trays"
  | "open_bay"
  | "close_bay"
  /**
   * ⚠️ Not a tray command either. Cut mains to the whole tower.
   *
   * It rides this surface because it needs the same refusal: one
   * bay mid-rip refuses the whole press, because there is one
   * power lead. Loaded-but-idle discs are WARNED about and the
   * tower goes off anyway
   * ([decision](docs/decisions/2026-07-30-the-dashboard-can-switch-the-tower-off.md)).
   */
  | "power_off"
  /**
   * ⚠️ Not a tray command. Rip the disc in one bay, on purpose.
   *
   * It rides this surface because it needs the same refusal every
   * tray command gets — a `starting`/`ripping` bay is untouchable —
   * and because a second command path to a drive is how a drive
   * gets two writers. The optional `name` is the operator saying
   * what the disc is when rip-deck could not read it, which is
   * exactly what `rip-deck rip --name` has always been.
   */
  | "rip_bay"
  /**
   * ⚠️ Not a tray command. Forget the discs the tower is holding.
   *
   * The "took the trash out" press behind `LoadedDiscsBanner`: the
   * discs the reminder names have been pulled by hand — usually
   * while the tower was off — so this clears rip-deck's memory of
   * them and the reminder falls silent. It moves no tray and takes
   * no target; the daemon rebuilds the reminder from its own ledger
   * ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
   */
  | "clear_loaded"

/**
 * What happened to ONE bay, mirrored from `TrayBayResultKind`.
 *
 * `refused_ripping` is the one that outranks the feature: a bay
 * that is starting or ripping is refused, counted and named,
 * because opening that tray destroys 90 GB and an hour. The
 * refusal lives in the daemon (`decideTrayBayAction`'s first
 * branch) and the HTTP path goes THROUGH it, not around it — so
 * this value arriving here means the daemon said no, never that
 * the UI guessed.
 */
export type TrayBayResultKind =
  /** Tray opened, and the disc in it had a completed rip. */
  | "opened"
  /** Tray opened, but this disc was never ripped. */
  | "opened_not_ripped"
  | "closed"
  /** ⚠️ A rip owns this drive. Nothing was touched. */
  | "refused_ripping"
  /** Nothing in this bay is finished with. */
  | "skipped_not_finished"
  /** Latched, but the tray is already empty. */
  | "skipped_no_disc"
  /** A disc is in it, so the tray is already closed. */
  | "skipped_has_disc"
  /** Close trays left it alone — rip-deck never opened it. */
  | "skipped_already_closed"
  | "skipped_not_present"
  /** A `rip_bay` press started a rip. STARTED, not finished. */
  | "rip_started"
  /** A `power_off` press moved no drawer here. */
  | "skipped_untouched"
  | "failed"

/**
 * What is still loaded, mirrored from `rip/loadedDiscs.ts`.
 *
 * It carries the finished SENTENCES as well as the numbers, and
 * the UI renders them rather than composing its own: the daemon
 * knows whether the tower is on, which changes what the reminder
 * asks the reader to DO, and a second phrasing here would drift
 * from the one Home Assistant speaks.
 */
export type LoadedDiscsView = {
  count: number
  slots: number[]
  discs: {
    slot: number | null
    label: string
    title: string | null
    is_ripped: boolean
  }[]
  is_tower_on: boolean
  message: string
  spoken_message: string
  updated_at: number
}

export type TrayBayReport = {
  drive_id: string
  slot: number | null
  label: string
  result: TrayBayResultKind
  /**
   * The daemon's own sentence about THIS bay. Render it — it is
   * where a refusal explains itself, and a caller that keeps
   * only `result` throws away the only text a human can act on.
   */
  detail: string
}

export type TrayCommandCounts = {
  opened: number
  opened_not_ripped: number
  closed: number
  refused: number
  failed: number
  skipped: number
  /** Rips started by `rip_bay`. Optional — additive 2026-07-30. */
  rip_started?: number
}

/**
 * One tray command's answer — `POST /api/tray`'s 200 body.
 *
 * Byte-for-byte what `resp/drive` publishes
 * (`trayCommand.TrayCommandResponsePayload`), which is the point:
 * one payload shape serves the dashboard and the Home Assistant
 * automation, so neither can drift into being the only reader
 * that gets the truth.
 *
 * A 400 answers with the SAME shape and `is_accepted: false`
 * (`buildTrayCommandRejection`), so a caller branches on the
 * field rather than on a status code.
 */
export type TrayCommandReport = {
  request_id: string | null
  /** Null when the command could not even be read. */
  command: TrayCommandWord | null
  is_accepted: boolean
  /** One sentence, written to be READ — on screen or in a log. */
  message: string
  /**
   * The same answer, written to be HEARD (`buildTraySpokenMessage`).
   *
   * ⚠️ **Not for this dashboard.** It exists for the Home Assistant
   * automation that speaks a tray problem through the house
   * speakers, and it deliberately says LESS — no counts, no slot
   * lists, no device text. A reader can scroll back and a listener
   * cannot, so rendering this instead of `message` would drop the
   * per-bay detail that is the only thing an operator at the screen
   * can act on. Mirrored here because the two payloads are the same
   * bytes and this file is the mirror.
   *
   * Optional so a dashboard served by a daemon older than
   * 2026-07-30 still type-checks against its own `/api/tray` body.
   */
  spoken_message?: string
  started_at: number
  finished_at: number
  counts: TrayCommandCounts
  bays: TrayBayReport[]
}

/**
 * The seam every data source implements.
 *
 * Ported from the viewer's `ArmDataSource`, trimmed to what
 * rip-deck actually has.
 *
 * The viewer's `ejectDrive` / `closeDrive` come back as ONE
 * member, `runTrayCommand`, and it is deliberately not
 * `runBayAction`. Two reasons, both about what the daemon
 * actually answers:
 *
 *  1. A tray command can address the whole rack
 *     (`open_trays`), so `driveId` is optional in a way no
 *     bay action's is.
 *  2. Its answer is a nine-bay REPORT, not an ok/msg pair. The
 *     refusal that protects a running rip is a per-bay `result`
 *     with its own `detail`, and flattening that into one
 *     boolean is how a caller ends up telling the owner "failed"
 *     about the one bay that was correctly protected.
 *
 * (This file has now been wrong about tray commands twice: first
 * that "rip-deck never ejects" —
 * `docs/HANDOFF-eject-and-open-questions.md` §1 — and then that
 * a REST transport for them was forbidden by the MQTT house
 * rule, which is the refusal the owner hit on the live page.
 * See `BayAction` above.)
 *
 * `hideJob` / `clearRecent` / `unhideAll` really are gone: the
 * viewer's dismissed-entry store lived in `server.py`, and
 * neither the endpoint nor the `hidden` field exists on
 * rip-deck's `/json`. A hide button backed by nothing is worse
 * than no button.
 */
export type RipDeckDataSource = {
  /** `fixture` selects a server-side `?fake=` scenario. */
  fetchState: (
    fixture?: string | null,
  ) => Promise<RipDeckState>
  /**
   * The capture for one job — a TAIL by default.
   *
   * A robot log is 1–3 MB and the interesting part of one is the
   * END, so the default is the last few hundred lines and the
   * whole file is opt-in. `"all"` asks for it; a caller that
   * offers that had better say what it is about to load.
   */
  fetchLog: (
    jobUuid: string,
    lines?: number | "all",
  ) => Promise<string>
  runBayAction: (input: {
    driveId: string
    action: BayAction
  }) => Promise<ActionResult>
  /**
   * Move a tray. `driveId` is omitted for the bulk commands.
   *
   * Resolves for a REFUSAL as well as a success — the 400 body
   * is a report too. It rejects only when there was no report at
   * all: a 405, a 503, or a network that never answered.
   */
  runTrayCommand: (input: {
    command: TrayCommandWord
    driveId?: string
    /**
     * `rip_bay` only: the name the operator typed, if any.
     *
     * Omitted or blank means "read the disc's own name" — the
     * Try-again press. The daemon trims and treats blank as absent,
     * so this never becomes a disc called `""`.
     */
    name?: string
  }) => Promise<TrayCommandReport>
}

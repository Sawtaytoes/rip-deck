import type { IntentName } from "@charcuterie/ui/tokens"
import {
  type EtaTrend,
  VERDICT_TEMPLATES,
  type VerdictKind,
} from "@rip-deck/contracts"

import type {
  ActionResult,
  BayAction,
  BayView,
  MediaKind,
  Rip,
  TrayCommandReport,
} from "./types"

/**
 * Presentation helpers, ported from the ARM viewer's `format.ts`
 * and moved onto rip-deck's richer fields where the ARM-shaped
 * ones are known to lie. Each such move is marked; nothing here
 * decides anything, it only chooses words and widths.
 */

// Emoji glyph per media kind. Kept as text so there are no
// icon-font or asset dependencies; unknown kinds fall back to a
// generic disc.
export function kindIcon(kind: MediaKind): string {
  switch (kind) {
    case "bluray":
      return "🔷"
    // `armView.toArmKind` deliberately does NOT flatten a 4K disc
    // into `bluray` to win a prettier glyph, so this list carries
    // the case the viewer's could not.
    case "uhd":
      return "🟦"
    case "dvd":
      return "📀"
    case "music":
      return "🎵"
    case "data":
      return "💾"
    default:
      return "💿"
  }
}

export function kindLabel(kind: MediaKind): string {
  switch (kind) {
    case "bluray":
      return "Blu-ray"
    case "uhd":
      return "4K"
    case "dvd":
      return "DVD"
    case "music":
      return "Audio CD"
    case "data":
      return "Data"
    default:
      return kind || "disc"
  }
}

export type RipVisual = {
  // done = finished successfully; indeterminate = active but no
  // percent (the AACS/BD+ preamble); failed = errored or stopped;
  // running = normal.
  state: "done" | "failed" | "indeterminate" | "running"
  // Bar fill width 0..100 (100 for done + indeterminate stripe).
  fillPercent: number
  // Short text shown at the top-right of the card.
  percentText: string
}

const DONE_STATUSES = new Set(["success", "done"])
const FAILED_STATUSES = new Set(["fail", "failed", "error"])

/**
 * How one rip's progress bar should read.
 *
 * The one addition to the ported logic is the read-error guard,
 * and it implements the rule that overrides everything else in
 * this project: **never report success on a rip that had read
 * errors.** The daemon's `isRipSuccessful` already refuses to
 * call such a rip successful, so this can only fire if something
 * upstream is wrong — which is exactly when a green bar would do
 * the most damage. Belt and braces on the one rule that has no
 * acceptable failure mode is not redundancy worth deleting.
 */
export function ripVisual(rip: Rip): RipVisual {
  const isDone =
    DONE_STATUSES.has(rip.status) ||
    (rip.percent != null &&
      rip.percent >= 100 &&
      !rip.active)

  if (isDone && rip.read_error_count > 0) {
    return {
      state: "failed",
      fillPercent: rip.percent ?? 0,
      percentText: "read errors",
    }
  }

  if (isDone) {
    return {
      state: "done",
      fillPercent: 100,
      percentText: "done",
    }
  }

  if (FAILED_STATUSES.has(rip.status)) {
    return {
      state: "failed",
      fillPercent: rip.percent ?? 0,
      percentText: rip.status,
    }
  }

  // Active with no percent. On rip-deck this is the AACS/BD+
  // preamble, which is genuinely slow and emits nothing — a
  // sweeping bar, never an empty one that reads as stuck.
  if (rip.active && rip.percent == null) {
    return {
      state: "indeterminate",
      fillPercent: 100,
      percentText: "in progress",
    }
  }

  return {
    state: "running",
    fillPercent: rip.percent ?? 0,
    percentText:
      rip.percent != null
        ? `${rip.percent.toFixed(1)}%`
        : rip.status,
  }
}

// Strip the `/dev/` prefix for the compact drive label.
export function driveName(drive: string | null): string {
  return (drive ?? "?").replace("/dev/", "")
}

/**
 * The disc's name, or nothing — never the word "disc".
 *
 * On the live rack every card read `disc (unknown)`, and both
 * halves of that were noise. `label` is
 * `identity?.title ?? identity?.volumeLabel`, and `towerFeed`
 * sets `identity: null` for a bay it adopted from the ledger, so
 * a restored bay genuinely has no name to show.
 *
 * ⚠️ **Do not reach into the verdict evidence for it.** The name
 * IS visible there, inside the outcome's English sentence, and
 * `towerFeed`'s header says in as many words that pulling
 * structured data back out of that sentence is how the
 * `MSG:5072` parser bug happened. It is right. The fix belongs
 * in the daemon: `BayLedgerRecord` would have to carry the disc
 * name (or the destination path) so `buildJob` can pass it
 * through as a FIELD.
 *
 * Until then the card says the bay and stays quiet about the
 * disc, which is true. A placeholder reading "disc" is not more
 * information than a blank; it just looks like one.
 */
export function discLabel(rip: Rip): string | null {
  return rip.label ?? rip.volume_label ?? null
}

/**
 * The disc type in words, or nothing.
 *
 * `disctype_label` is null for `unknown`, and the ported card
 * fell back to `kindLabel(kind)` — which faithfully rendered the
 * string "unknown" in brackets after every adopted bay on the
 * live page. A type nobody read is not worth a parenthetical.
 */
export function discTypeText(rip: Rip): string | null {
  if (rip.disctype_label !== null) return rip.disctype_label

  return rip.disctype === "unknown"
    ? null
    : kindLabel(rip.kind)
}

/**
 * Parse the daemon's `YYYY-MM-DD HH:MM:SS` to epoch ms.
 *
 * `formatLocalTimestamp` emits LOCAL wall-clock, not UTC, so
 * this parses it as local by handing `Date.parse` a zone-less
 * string. Tolerates ISO too; null on anything unparseable.
 */
function parseLocalTime(
  at: string | null | undefined,
): number | null {
  if (!at) return null

  const ms = Date.parse(
    at.includes("T") ? at : at.replace(" ", "T"),
  )

  return Number.isNaN(ms) ? null : ms
}

/** Compact duration like "3s", "4m", "1h12m". Clamps negatives. */
export function humanDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))

  if (whole < 60) return `${whole}s`

  const minutes = Math.floor(whole / 60)

  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60

  return `${hours}h${remainder > 0 ? `${remainder}m` : ""}`
}

// Elapsed wall-clock since the rip started, e.g. "12m elapsed".
// Empty when we have no start time. `now` is injectable so tests
// are deterministic.
export function elapsedText(
  start: string | null | undefined,
  now: number = Date.now(),
): string {
  const startedAt = parseLocalTime(start)

  if (startedAt == null) return ""

  return `${humanDuration((now - startedAt) / 1000)} elapsed`
}

/**
 * Remaining time, from the daemon's MEASURED ETA.
 *
 * The viewer extrapolated this from elapsed and percent, and
 * that is the defect behind HANDOFF §2.4: every MakeMKV stage
 * restarts PRGV from zero, so a linear fit across a stage
 * boundary reports a rising ETA on a perfectly healthy rip. The
 * daemon computes the real thing per stage. When it has no rate
 * yet we say nothing — deliberately NOT falling back to the
 * extrapolation, because a plausible wrong number is worse than
 * a blank.
 */
export function etaText(etaSeconds: number | null): string {
  if (etaSeconds == null || etaSeconds <= 0) return ""

  return `~${humanDuration(etaSeconds)} left`
}

/**
 * The ETA trend, when it is worth saying.
 *
 * Only `rising` gets words. It is a signal in its own right
 * (C6) — the same d(progress)/dt collapse the health engine
 * watches, visible before the rip fails — while "falling" is
 * what every healthy rip does and "steady" is noise.
 *
 * Note what this is NOT: an alarm. 49 of 722 progress lines on a
 * flawless Blu-ray reported a rising ETA. A card that shouts 49
 * times on a good disc is a card the owner learns to ignore.
 */
export function etaTrendText(
  trend: EtaTrend | null,
): string {
  return trend === "rising" ? "ETA rising" : ""
}

/** Throughput as MB/s. Empty when the daemon has no rate yet. */
export function throughputText(
  bytesPerSec: number | null,
): string {
  if (bytesPerSec == null || bytesPerSec <= 0) return ""

  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
}

/**
 * Where a rip belongs on the page.
 *
 * The viewer bucketed on ARM's `job.ejected`, and that signal
 * does not exist here. rip-deck never AUTO-ejects — no eject
 * loop, ever, because the flap-storm is what killed valid rips
 * on other bays — so nothing sets the flag and `ejected` is
 * always false on `/json`. (An operator can still open a tray
 * on request over MQTT; that is `trayActionsFor` below and
 * `docs/HANDOFF-eject-and-open-questions.md` §1.) The viewer's
 * 12-hour `ATTENTION_WINDOW_HRS` guess — which existed only
 * because ARM never un-set the flag — goes with it.
 *
 * What replaces it is better than what it replaced, because it
 * asks the question the owner actually has: does this bay want a
 * human? Three things say yes, and they are all positive
 * evidence rather than a time-box:
 *
 *  - the rip failed;
 *  - it finished with read errors, which the one rule says is
 *    never a success;
 *  - it carries a verdict that ASKS for something.
 *
 * ⚠️ That third clause used to be `verdict !== "ok"`, and it put
 * three finished, verified, 225 GB backups under a yellow "needs
 * attention" heading on the live rack. `towerFeed` stamps
 * `unknown` on every bay it did not measure — deliberately, and
 * its header explains at length why `ok` there would be a lie —
 * so `unknown` means "nothing judged this rip", NOT "this rip is
 * suspect". Reading an absence of measurement as evidence of a
 * problem is the same conflation, one layer up, that the verdict
 * model exists to prevent.
 */
export type RipBucket = "ripping" | "attention" | "recent"

export function ripBucket(rip: Rip): RipBucket {
  if (rip.active) return "ripping"

  const isTroubled =
    FAILED_STATUSES.has(rip.status) ||
    rip.read_error_count > 0 ||
    isVerdictActionable(rip.verdict)

  return isTroubled ? "attention" : "recent"
}

/**
 * Does this verdict ask a human to go and do something?
 *
 * The templates already answer it: `VerdictAction` is the field
 * that names a physical act, and `"none"` is what the three
 * verdicts that need nobody carry — `ok` ("reading normally"),
 * `disc_marginal_slow` ("leaving it to run is fine") and
 * `unknown` ("not enough information to judge this rip yet").
 * Every other kind names a hub to check, a disc to clean or
 * replace, a drive to look at, a key to refresh.
 *
 * Read off `VERDICT_TEMPLATES` rather than listed here, so a
 * tenth verdict kind cannot be quietly omitted: the record is
 * keyed on the closed union and a new member fails the typecheck
 * in `@rip-deck/contracts` first.
 */
export function isVerdictActionable(
  kind: VerdictKind,
): boolean {
  return VERDICT_TEMPLATES[kind].action !== "none"
}

/**
 * Collapse a host's jobs to ONE card per physical bay.
 *
 * Ported, with the key changed from `rip.drive` to
 * `rip.drive_id`. `/dev/srN` is never identity — it reshuffles
 * on every USB re-enumeration, which is what happens each time
 * the tower is power-cycled independently of the host, i.e. the
 * normal way it is used. Keying on it would merge two different
 * bays' histories after a reshuffle and show the owner one card
 * for two drives.
 *
 * Rips arrive newest-first from the daemon, so the first seen
 * per bay wins.
 */
export function latestPerDrive(rips: Rip[]): Rip[] {
  const seen = new Set<string>()
  const latest: Rip[] = []

  for (const rip of rips) {
    const key = rip.drive_id || `job:${rip.job_uuid}`

    if (seen.has(key)) continue

    seen.add(key)
    latest.push(rip)
  }

  return latest
}

/**
 * How loudly a verdict should read.
 *
 * `disc_dirty` and `disc_scratched` are the pair this whole
 * project turns on: identical symptoms, opposite advice ("clean
 * it" vs "source another copy"). They share a tone here on
 * purpose — the DIFFERENCE lives in the verdict message, which
 * is the thing the owner acts on, and colour-coding them apart
 * would invite reading the colour instead of the sentence.
 */
export type VerdictTone =
  | "ok"
  | "unmeasured"
  | "disc"
  | "hardware"

export function verdictTone(
  kind: VerdictKind,
): VerdictTone {
  switch (kind) {
    case "ok":
      return "ok"

    // ⚠️ NOT `hardware`, which is where this sat while three
    // finished 225 GB backups rendered as the loudest thing on
    // the live page. `unknown` is what `towerFeed` stamps on a
    // bay nothing measured — a statement about rip-deck's own
    // instrumentation, not about the disc — so it gets a quiet
    // tone of its own. The caveat is still worth saying; it is
    // not worth painting the same red as a failing drive.
    case "unknown":
      return "unmeasured"

    case "disc_dirty":
    case "disc_scratched":
    case "disc_marginal_slow":
      return "disc"

    case "hub_fault":
    case "drive_failing":
    case "enumeration_flap":
    case "key_expired":
      return "hardware"
  }
}

/**
 * The tone, said in the library's vocabulary.
 *
 * **This map used to be `TONE_CLASS`, declared twice** — once in
 * `VerdictBadge.tsx` and once in `TowerAlerts.tsx`, byte-identical,
 * four hardcoded hexes and a `slate-400` each, with no light mode
 * and no relationship to how mux-magic spells the same idea. It is
 * declared once now, and it names a *role* rather than a colour, so
 * the colour is the variant's business and flipping schemes is an
 * attribute rather than an edit.
 *
 * `unmeasured` staying `neutral` is the load-bearing entry, and the
 * reason this is a `Record` rather than a `?:` chain: it is the one
 * that was wrong on the live page, painting three finished 225 GB
 * backups the same red as a failing drive. A `Record` over the
 * closed union makes a new tone a typecheck failure rather than a
 * silently unstyled card.
 */
export const VERDICT_INTENT: Record<
  VerdictTone,
  IntentName
> = {
  ok: "neutral",
  unmeasured: "neutral",
  disc: "warning",
  hardware: "danger",
}

/** `verdictTone`, composed with the map above. */
export const verdictIntent = (
  kind: VerdictKind,
): IntentName => VERDICT_INTENT[verdictTone(kind)]

/**
 * A rip's bar colour, in the same vocabulary.
 *
 * Replaces `ProgressBar.tsx`'s `FILL_CLASS`, which held
 * `bg-green-500`, `bg-red-500` and a
 * `bg-gradient-to-r from-blue-500 to-cyan-400`.
 *
 * `indeterminate` shares `running`'s intent because it **is**
 * running — the AACS/BD+ preamble, ~25s of a real Blu-ray emitting
 * no forward progress. What distinguishes it is the sweep and the
 * absent `aria-valuenow`, not the colour: a colour of its own would
 * invite reading it as a fourth outcome.
 */
export const RIP_VISUAL_INTENT: Record<
  RipVisual["state"],
  IntentName
> = {
  done: "success",
  failed: "danger",
  indeterminate: "accent",
  running: "accent",
}

/**
 * What a bay's progress bar is called.
 *
 * Required by `@charcuterie/ui`'s `ProgressBar`, and required for a
 * reason M5 is the proof of: nine bars on one page all announcing
 * "Working" is nine controls a screen reader cannot tell apart, and
 * `getByRole("progressbar", { name })` cannot address any of them.
 * The slot is the thing the owner walks to, so it leads.
 */
export function ripProgressLabel(rip: Rip): string {
  const where = `Slot ${rip.slot === null ? "?" : String(rip.slot)}`

  const what = discLabel(rip)

  return what === null ? where : `${where} · ${what}`
}

/** Human wording for a bay action button. */
export function bayActionLabel(action: string): string {
  switch (action) {
    case "clear_quarantine":
      return "Clear quarantine"
    case "keep_trying":
      return "Keep trying"
    case "give_up":
      return "Give up"
    case "retry_in_another_drive":
      return "Retry in another drive"
    case "cancel":
      return "Cancel"
    // "Tray", not "Eject": `eject --cdrom` is how the daemon
    // moves it, but the thing the owner is doing is opening a
    // drawer, and "eject" in this repo's history means the
    // automatic flap-storm that must never return.
    case "open_bay":
      return "Open tray"
    case "close_bay":
      return "Close tray"
    default:
      return action
  }
}

/**
 * Job states in which a rip owns the drive.
 *
 * Opening a tray in any of them destroys the copy in progress —
 * 90 GB and an hour on this rack. `finalising` is in the list
 * because the output is still being moved into place.
 */
export const TRAY_REFUSED_STATES: ReadonlySet<string> =
  new Set([
    "settling",
    "identifying",
    "queued",
    "ripping",
    "throttled",
    "stalled",
    "finalising",
  ])

/** Job states that mean a disc is sitting in there, finished. */
const LATCHED_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "needs_attention",
])

/**
 * Which tray commands this bay may be offered, if any.
 *
 * This is the ONE place the dashboard derives a control instead
 * of rendering `bay.actions`, and the exception needs its
 * argument. `towerView.buildBayActions` publishes decisions
 * about a JOB — whether a verdict earns a retry, whether
 * quarantine may be cleared — and the UI must not second-guess
 * those. A tray command is not a job decision: its eligibility
 * is one rule, the daemon states it in one sentence
 * (`docs/eject-and-durable-bay-state.md` §2, "a bay in
 * `starting` or `ripping` is refused"), and `bay.state.state` is
 * already on this side. So the UI agrees with a published rule
 * rather than inventing one — and the day the daemon starts
 * putting tray commands in `bay.actions`, those win and this
 * returns nothing.
 *
 * ⚠️ The refusal is FIRST, exactly as `decideTrayBayAction`
 * orders it. The daemon would refuse a mid-rip tray command
 * regardless; a button that exists only to be refused is a
 * button somebody eventually gets refused by at 2am and stops
 * believing.
 *
 * Which of the two is offered comes from what we can honestly
 * read. Tray POSITION is not readable at all — sysfs reports
 * media, not the door — so:
 *
 *  - latched (a disc rip-deck is finished with) -> **open**, the
 *    disc is in there and getting it out is the whole point;
 *  - idle (the bay re-armed on empty readings, so there is no
 *    disc) -> **close**, which is a documented no-op if the tray
 *    was already shut;
 *  - quarantined -> **both**, because quarantine says nothing
 *    about what is in the drive, and a disc trapped in a bay no
 *    button can open is the case the tray command exists for.
 */
export function trayActionsFor(
  bay: BayView | undefined,
): BayAction[] {
  if (bay === undefined) return []

  if (
    bay.actions.includes("open_bay") ||
    bay.actions.includes("close_bay")
  ) {
    return []
  }

  // A drive that is not on the bus cannot move its tray, and the
  // daemon answers `skipped_not_present` rather than trying.
  if (!bay.is_present) return []

  if (TRAY_REFUSED_STATES.has(bay.state.state)) return []

  if (bay.is_quarantined) return ["open_bay", "close_bay"]

  if (LATCHED_STATES.has(bay.state.state)) {
    return ["open_bay"]
  }

  return ["close_bay"]
}

/**
 * Which way the ⏏ toggle sends this bay next.
 *
 * > *"This button should also have an eject icon, not 'open
 * > tray' because it's an open/close toggle."*
 *
 * ⚠️ **READ THIS BEFORE LOOKING FOR THE TRAY SENSOR: there is
 * not one, and its absence is not a bug.** sysfs reports MEDIA,
 * not the door. An open tray and a closed EMPTY tray produce
 * identical readings, and separating them needs a
 * `CDROM_DRIVE_STATUS` ioctl Node cannot issue
 * (`docs/eject-and-durable-bay-state.md` §2). Tray position is
 * unknowable in this process. So this toggle is **not** driven
 * off tray state — nothing can be — and everything below is an
 * inference, deliberately, with the reasoning written down
 * rather than buried in a component.
 *
 * Two rules, in this order:
 *
 *  1. **A disc proves the tray is closed.** `disc_size_sectors`
 *     is non-null only when the drive read media, and a drive
 *     cannot read a disc through an open drawer. This is the one
 *     branch that is a FACT rather than an inference, which is
 *     why it comes first. Next press: `open_bay`.
 *  2. **No disc: fall back to what rip-deck itself last did.**
 *     `last_tray_command` is the daemon's memory of its own act
 *     — *"the last thing I did was open it"* — so if that was
 *     `open_bay`, the drawer is presumed still out and the next
 *     press closes it.
 *
 * Everything else opens, and that default is chosen rather than
 * inherited. A stray `close_bay` on an already-closed tray is a
 * documented no-op (`CDROMCLOSETRAY`), while a stray `open_bay`
 * is a drawer sliding out — but the case this lands on is a bay
 * that has told us NOTHING, and a button that does nothing
 * visible is a button the owner presses four times and then
 * stops believing. Opening is the act he can see and undo.
 *
 * Nothing here decides whether the control may be SHOWN at all
 * — `trayActionsFor` does, and the daemon refuses a ripping bay
 * regardless (`decideTrayBayAction`'s first branch).
 */
export function nextTrayCommandFor(
  bay: BayView,
): "open_bay" | "close_bay" {
  // ⚠️ What rip-deck itself last did comes FIRST, and disc
  // presence is only the fallback.
  //
  // It used to be the other way round, on the reasoning that a
  // disc in the tray proves the tray is shut. Measured on the
  // live tower 2026-07-27: it does not. `open_trays` opened
  // three loaded bays and all three still reported a disc
  // afterwards — so a disc-first rule would offer `open_bay`
  // forever and the toggle could never send its second press,
  // which is the entire feature.
  if (bay.last_tray_command != null) {
    return bay.last_tray_command === "open_bay"
      ? "close_bay"
      : "open_bay"
  }

  // Nothing has commanded this bay since the daemon started, so
  // whatever state the drawer is in, a human put it there and
  // the only useful offer is to open it. Opening an already-open
  // tray is a no-op, so being wrong here costs nothing.
  return "open_bay"
}

/**
 * Flatten a nine-bay tray report onto the ONE bay a caller asked
 * about.
 *
 * The lossy direction, and it exists only for `runBayAction`'s
 * `ActionResult` — a shape that predates the tray endpoint and
 * carries one boolean. `useTrayCommand` keeps the whole report
 * and should be preferred by anything new.
 *
 * ⚠️ `is_accepted` is NOT the answer on its own. The daemon
 * accepts a command it then refuses per bay: `is_accepted: true`
 * with one `refused_ripping` bay means "I heard you, and no".
 * Reporting that as success is how a control ends up claiming it
 * opened the drive it correctly protected. So the bay's own
 * `result` decides, and its `detail` — the sentence written for a
 * human — is what gets shown, never a paraphrase.
 */
export function trayReportToActionResult(input: {
  driveId: string
  report: TrayCommandReport
}): ActionResult {
  const { driveId, report } = input

  const bay =
    report.bays.find(
      (entry) => entry.drive_id === driveId,
    ) ?? null

  if (bay === null) {
    return { ok: report.is_accepted, msg: report.message }
  }

  const isMoved =
    bay.result === "opened" ||
    bay.result === "opened_not_ripped" ||
    bay.result === "closed"

  return { ok: isMoved, msg: bay.detail }
}

/**
 * Every control this bay should show, tray commands included.
 *
 * `bay.actions` is still what the daemon published and still
 * what the UI renders — with ONE subtraction, and it is a
 * foot-gun rather than a difference of opinion.
 *
 * `towerView.buildBayActions` offers `retry_in_another_drive`
 * for any troubled disc verdict that is merely `suspected`. On
 * the live rack that fired on three **completed, verified,
 * 225 GB** backups, because `towerFeed` stamps a placeholder
 * `unknown` / `suspected` / subject-`disc` verdict on every bay
 * nothing measured. A re-rip control on a finished rip invites
 * exactly the duplicate the bay ledger was built to prevent, and
 * it was offered on all three at once.
 *
 * HIDDEN, not disabled. A disabled button still says "this is a
 * thing you might do to a finished rip", and there is no
 * explanation to attach to it: the control's whole job is to
 * confirm a suspected disc verdict in a second drive, and
 * neither of these bays has a verdict to confirm.
 *
 * Two clauses, each standing on its own:
 *
 *  1. **No verdict to confirm.** `unknown` is the absence of a
 *     measurement, so there is nothing a second drive could
 *     agree with.
 *  2. **The rip is finished.** Whatever the verdict says, a
 *     `completed` job already produced the backup.
 *
 * ⚠️ The real fix is `buildBayActions` not publishing it, and
 * that is the daemon's tree. This is the guard that stops the
 * owner pressing it in the meantime — delete it once the feed
 * stops offering it.
 */
export function bayActionsFor(
  bay: BayView | undefined,
): BayAction[] {
  if (bay === undefined) return []

  const isRetryMeaningless =
    bay.state.verdict === "unknown" ||
    bay.state.state === "completed"

  const published = isRetryMeaningless
    ? bay.actions.filter(
        (action) => action !== "retry_in_another_drive",
      )
    : bay.actions

  return [...published, ...trayActionsFor(bay)]
}

/**
 * A bay rip-deck stopped short of ripping, waiting on a human.
 *
 * Every `needs_attention` outcome in the watcher is a refusal
 * BEFORE a rip — the disc never settled, its name could not be
 * read, MakeMKV would not list the drive, or (the case three
 * discs in the tower are in tonight) rip-deck has no bay memory
 * and cannot tell a fresh disc from one the last daemon already
 * ripped. Every one of them leaves the disc in the drive on
 * purpose.
 *
 * That is a different fact from "the rip failed", and it wants a
 * different card: nothing broke, and the fix is a button press
 * rather than a new copy of the disc. Quarantine is excluded
 * because it is the bay that is out of service rather than the
 * disc, and it already has `QuarantinedBayCard`.
 */
export function isBayHeld(bay: BayView): boolean {
  return (
    !bay.is_quarantined &&
    bay.state.state === "needs_attention"
  )
}

/**
 * What a held bay says about itself, in the daemon's own words.
 *
 * `outcome_detail` is the single clean sentence and is preferred
 * the day the feed carries it. Until then the same text arrives
 * folded into the verdict's evidence, mixed with engine
 * boilerplate, and BOTH are printed — neither is matched on,
 * because string-matching daemon prose is how the `MSG:5072`
 * parsing went wrong.
 */
export function heldDetailLines(bay: BayView): string[] {
  if (bay.outcome_detail != null) {
    return [bay.outcome_detail]
  }

  return bay.alert?.evidence ?? []
}

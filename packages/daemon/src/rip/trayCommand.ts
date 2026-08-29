import type { LoadedDiscSummary } from "./loadedDiscs.ts"
import type { BayObservation, BayState } from "./watcher.ts"

/**
 * The operator's tray commands: what they mean, who they refuse,
 * and what gets said afterwards.
 *
 * Everything in this file is **pure**. The spawning lives in
 * `tray.ts`, the bay table and the bus probe live in
 * `watcher.ts`, and the broker lives in `mqtt/`. What is left
 * here is the part that is easy to get wrong and expensive to
 * discover on hardware: which bay qualifies, which bay is
 * refused, and how nine answers become one sentence a house
 * speaker can read.
 *
 * ## The one rule that outranks the feature
 *
 * ⚠️ **A bay that is `starting` or `ripping` is REFUSED.** Not
 * skipped quietly — refused, counted, and named in the spoken
 * message. Opening a tray mid-rip destroys the copy in progress,
 * and this is the one command surface in rip-deck that can reach
 * a drive while a rip owns it. The refusal is the first branch
 * of `decideTrayBayAction` and it is checked for **every**
 * command kind, including the single-bay ones an operator aimed
 * deliberately.
 *
 * ## What the two bulk commands mean
 *
 * The two bulk buttons are **Open trays** and **Close trays**
 * ([decision](docs/decisions/2026-07-30-open-trays-escalates-and-close-trays-is-plain.md),
 * which supersedes the old toggling "Open all complete"). They do
 * not toggle: Open always opens, Close always closes.
 *
 * ## `open_trays` — escalating, in two presses
 *
 * `open_trays` reads one of two widths, resolved by the caller
 * (`runTrayCommand`) and passed down as `openScope`:
 *
 *  - **`"finished"`** — open the bays finished with and still
 *    holding their disc: a `done` rip (`completed`, `failed` or
 *    `needs_attention`) or a `quarantined` bay. The first press
 *    when there is anything to collect.
 *  - **`"all"`** — open every present, non-ripping bay, empty ones
 *    too. The escalation: pressed again once the finished bays are
 *    already open (so a disc can be loaded into the rest), or the
 *    very first press when nothing is finished.
 *
 * The escalation is **stateless — read from tray memory, not a
 * click counter**. The caller folds two questions over the probe
 * it already took: are any bays finished with (`hasFinishedDisc`),
 * and are they all already open (`lastTrayCommand === "open_bay"`)?
 * Finished-but-not-all-open → `"finished"`; otherwise → `"all"`.
 * A page reload or a second dashboard cannot desync a counter that
 * does not exist.
 *
 * `completed` is the only outcome the owner named for "finished",
 * but the set is wider on purpose: every bay in it is one rip-deck
 * will never touch again until a human takes the disc out, and the
 * alternative leaves a failed or flagged disc locked in a drive no
 * button can open. Nothing is lost silently — an unripped disc is
 * reported `opened_not_ripped`, counted apart, and named aloud
 * ("two of those were never ripped"). To narrow "finished" to
 * successes only, `isBulkOpenEligible` is the one function to
 * change.
 *
 * ## `close_trays` — close only what rip-deck opened
 *
 * `close_trays` closes exactly the bays whose `lastTrayCommand` is
 * `open_bay`, and skips the rest as `skipped_already_closed`.
 * `lastTrayCommand` is the authority on tray position — disc
 * presence is NOT, because `open_trays` leaves `hasMedia` true on
 * the open tray (measured on the live tower 2026-07-27, which is
 * why the old close-all existed;
 * [decision](docs/decisions/2026-07-27-tray-memory-beats-disc-presence.md)).
 * `CDROMCLOSETRAY` on a shut tray is a no-op, so the old close-all
 * was harmless but noisy; closing only what is open is the honest
 * report.
 *
 * ## Tower off → power on
 *
 * An `open_trays` press against an OFF tower (no drives on the bus)
 * moves no tray — there is none to move. Instead the caller
 * publishes an MQTT power-on request that a Home Assistant
 * automation turns into `switch.turn_on`, and answers the operator
 * with `buildTrayPowerOnResponse`. rip-deck never touches the HA
 * switch directly (house rule: integrate over MQTT, not a REST
 * bridge). That branch lives in `runTrayCommand`, not here, because
 * this file is pure and knows nothing of a broker.
 *
 * ## The refusal outranks all of it
 *
 * ⚠️ **The `starting`/`ripping` refusal is the first branch and is
 * checked for every command kind, bulk or targeted.** "Open all"
 * never means "all nine": a ripping bay is refused, counted, and
 * named. Nothing here can reach a drive a rip owns.
 *
 * ## Why a single-bay variant exists
 *
 * Two reasons, both concrete. The dashboard dropped the ARM
 * viewer's per-bay eject/close control during the port and will
 * want it back, and MQTT is the only command surface there is.
 * And the bulk commands deliberately act on a set — an operator
 * who wants exactly bay 4 open should be able to say so instead
 * of widening the rule everyone else gets. It is **not** wired
 * to the RODRET, which only ever sends the two bulk commands.
 */

export type TrayCommandKind =
  | "open_trays"
  | "close_trays"
  | "open_bay"
  | "close_bay"
  /**
   * ⚠️ Not a tray command. Rip the disc in one bay, on purpose.
   *
   * It lives on this surface because it needs every rule this file
   * already enforces — the `starting`/`ripping` refusal above all —
   * and because a second command path to a drive is how a drive
   * gets two writers. What it does with the bay afterwards is
   * `watcher.ts`'s business; what it may reach is decided here.
   *
   * The gap it closes: a held card told the operator to run
   * `rip-deck rip --slot N --name "…"`, a CLI command the dashboard
   * cannot run, and offered ⏏ as its only control — which does not
   * even un-hold on this hardware, because the drives keep
   * reporting the disc after the tray opens
   * ([decision](docs/decisions/2026-07-27-tray-memory-beats-disc-presence.md)).
   * Owner: *"Horrible user experience."*
   */
  | "rip_bay"
  /**
   * ⚠️ Not a tray command either. Cut mains to the whole tower.
   *
   * The single most destructive thing this surface can reach, and
   * that is precisely why it lives here rather than beside a
   * switch: it needs the `starting`/`ripping` refusal, and this
   * file is where that refusal is. rip-deck never touches the Home
   * Assistant switch directly — it publishes a request on
   * `cmd/power` that an HA automation turns into `switch.turn_off`,
   * the same way `open_trays` on a dark tower already asks for
   * `switch.turn_on` (house rule: integrate over MQTT, not a REST
   * bridge).
   *
   * Bulk by nature: there is one power lead. It takes no target.
   */
  | "power_off"
  /**
   * ⚠️ Not a tray command. Forget the discs the tower is holding.
   *
   * The "I took the trash out" press: a human has physically pulled
   * the finished discs the loaded-discs reminder is naming — usually
   * while the tower was OFF, where rip-deck could not watch them go
   * — and this clears rip-deck's memory of them so the reminder
   * stops. It drops the on-disk ledger's latched records and any
   * kept-but-absent bay, then republishes an all-clear
   * ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
   *
   * It rides this surface for the same reason `power_off` does: it
   * is a whole-tower act, not a drawer, and routing it here keeps
   * one command path to the daemon for the dashboard AND `cmd/drive`
   * (so a Home Assistant button can clear it too). It moves no tray
   * and takes no target. A drive that is on the bus and demonstrably
   * still holds its disc is NOT forgotten — clearing lies only about
   * discs nobody can see, so a present disc stays named until it is
   * actually removed.
   */
  | "clear_loaded"

/**
 * The command words the bulk buttons USED to send, before the
 * 2026-07-30 rename to `open_trays`/`close_trays`
 * ([decision](docs/decisions/2026-07-30-open-trays-escalates-and-close-trays-is-plain.md)).
 *
 * Still accepted on the wire, mapped to the new kinds, for exactly
 * one reason: a **retained** `cmd/drive` payload or a not-yet-
 * reflashed physical button could still say the old word, and a
 * button that silently does nothing is the failure this surface
 * exists to prevent. New senders emit the new words; the physical
 * RODRET automation is updated in the same change.
 */
const LEGACY_COMMAND_ALIASES: Record<
  string,
  TrayCommandKind
> = {
  open_completed: "open_trays",
  close_open: "close_trays",
}

/**
 * One bay, one direction — what actually happened to a drawer.
 *
 * The bulk commands are a set and a direction; this is the
 * per-bay half of them, and it is what gets remembered. A bay
 * opened by `open_trays` and a bay opened by `open_bay` had
 * the identical thing done to them, so recording the command
 * WORD would make the ⏏ toggle's memory depend on which button
 * the operator happened to press. `decideTrayBayAction`'s
 * `action` is the fact; this is that fact named the way the
 * dashboard sends it back.
 */
export type BayTrayCommand = "open_bay" | "close_bay"

/** How an operator names one bay. Slot is what he can read. */
export type BayTarget =
  | { slot: number }
  | { driveId: string }

export type TrayCommandRequest =
  | { kind: "open_trays" }
  | { kind: "close_trays" }
  | { kind: "power_off" }
  | { kind: "clear_loaded" }
  | { kind: "open_bay"; target: BayTarget }
  | { kind: "close_bay"; target: BayTarget }
  | {
      kind: "rip_bay"
      target: BayTarget
      /**
       * The name to rip under, or null to identify the disc.
       *
       * ⚠️ **A name here is NOT an invented name, and B3 is not
       * softened.** B3 forbids *rip-deck* inventing a name when it
       * could not read one; it has never forbidden an operator
       * supplying one — that is exactly what `rip-deck rip --name`
       * has always done, and this is the same act through a text
       * box instead of a shell. The daemon still invents nothing:
       * with `null` it identifies, and a disc it cannot name is
       * still held.
       */
      name: string | null
    }

export type ParsedTrayCommand =
  | {
      isValid: true
      requestId: string | null
      request: TrayCommandRequest
    }
  | {
      isValid: false
      requestId: string | null
      reason: string
    }

const KNOWN_COMMANDS: readonly string[] = [
  "open_trays",
  "close_trays",
  "open_bay",
  "close_bay",
  "rip_bay",
  "power_off",
  "clear_loaded",
]

/** The commands that need a bay named. */
const TARGETED_COMMANDS: readonly string[] = [
  "open_bay",
  "close_bay",
  "rip_bay",
  "power_off",
]

const describeKnownCommands = (): string =>
  KNOWN_COMMANDS.map((name) => `\`${name}\``).join(", ")

/**
 * Resolve a bulk command word to its kind, new or legacy.
 *
 * Returns null for anything that is not a bulk command (the
 * single-bay words need JSON, and a genuine typo needs the
 * "not a command" refusal).
 */
const bulkKindOf = (
  word: string,
):
  | "open_trays"
  | "close_trays"
  | "power_off"
  | "clear_loaded"
  | null => {
  if (
    word === "open_trays" ||
    word === "close_trays" ||
    // Bare too, for the same reason the tray pair is: a Home
    // Assistant automation is then a one-line `mqtt.publish` with
    // no template that could emit malformed JSON. Neither takes a
    // target, so there is nothing a JSON form would add.
    word === "power_off" ||
    word === "clear_loaded"
  ) {
    return word
  }

  const legacy = LEGACY_COMMAND_ALIASES[word]

  return legacy === "open_trays" || legacy === "close_trays"
    ? legacy
    : null
}

/**
 * Read one inbound `cmd/drive` message.
 *
 * Accepts a **bare command word** as well as a JSON object,
 * which is not laziness: the Home Assistant automation for the
 * two bulk presses is then a one-line `mqtt.publish` with no
 * template at all, and a template that has to emit valid JSON is
 * one typo away from a button that silently does nothing.
 *
 * Never throws, and an unrecognised message becomes a REPORTED
 * refusal rather than silence — an operator who pressed a button
 * and heard nothing has no way to tell a broken button from a
 * broken daemon.
 */
export const parseTrayCommand = (
  payload: string,
): ParsedTrayCommand => {
  const trimmed = payload.trim()

  if (trimmed === "") {
    return {
      isValid: false,
      requestId: null,
      reason: "empty command payload",
    }
  }

  if (!trimmed.startsWith("{")) {
    const bulkKind = bulkKindOf(trimmed)

    return bulkKind !== null
      ? {
          isValid: true,
          requestId: null,
          request: { kind: bulkKind },
        }
      : {
          isValid: false,
          requestId: null,
          reason:
            `\`${trimmed}\` is not a bulk command. The bare ` +
            "form takes `open_trays`, `close_trays`, " +
            "`power_off` or `clear_loaded`; the single-bay " +
            "commands need JSON with a `slot` or `drive_id`.",
        }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return {
      isValid: false,
      requestId: null,
      reason: "the payload is not valid JSON",
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      isValid: false,
      requestId: null,
      reason: "the payload is not a JSON object",
    }
  }

  const body = parsed as Record<string, unknown>

  const requestId =
    typeof body.request_id === "string"
      ? body.request_id
      : null

  const command = body.command

  if (typeof command !== "string") {
    return {
      isValid: false,
      requestId,
      reason:
        "no `command` in the payload. Expected one of " +
        `${describeKnownCommands()}.`,
    }
  }

  const bulkKind = bulkKindOf(command)

  if (bulkKind !== null) {
    return {
      isValid: true,
      requestId,
      request: { kind: bulkKind },
    }
  }

  if (!TARGETED_COMMANDS.includes(command)) {
    return {
      isValid: false,
      requestId,
      reason:
        `\`${command}\` is not a command. Expected one of ` +
        `${describeKnownCommands()}.`,
    }
  }

  const kind = command as
    | "open_bay"
    | "close_bay"
    | "rip_bay"

  const slot = body.slot
  const driveId = body.drive_id

  const target: BayTarget | null =
    typeof slot === "number" && Number.isFinite(slot)
      ? { slot }
      : typeof driveId === "string" && driveId !== ""
        ? { driveId }
        : null

  if (target === null) {
    return {
      isValid: false,
      requestId,
      reason:
        `\`${command}\` needs a \`slot\` (a number) or a ` +
        "`drive_id` (the bay's stable USB port path) saying " +
        "which bay to act on.",
    }
  }

  if (kind !== "rip_bay") {
    return {
      isValid: true,
      requestId,
      request: { kind, target },
    }
  }

  // An empty or blank `name` reads as "no name given", not as a
  // disc called "". Trimmed here rather than at the UI, because
  // the UI is not the only sender — `cmd/drive` takes the same
  // JSON — and a folder named after trailing whitespace is a disc
  // nobody finds again.
  const rawName = body.name
  const name =
    typeof rawName === "string" && rawName.trim() !== ""
      ? rawName.trim()
      : null

  return {
    isValid: true,
    requestId,
    request: { kind: "rip_bay", target, name },
  }
}

/* ------------------------------------------------------------ *
 * Which bays a command acts on.
 * ------------------------------------------------------------ */

/**
 * A bay is latched terminal: rip-deck is finished with whatever
 * is in it and will not pick it up again on its own.
 *
 * Precisely: `phase === "done"` with an outcome — which is
 * `completed`, `failed` or `needs_attention`, because `no_media`
 * re-arms the bay instead of latching it (`applyBayOutcome`) —
 * or `phase === "quarantined"`, which is the start-counter
 * backstop and is cleared only by the disc leaving.
 *
 * `idle`, `starting` and `ripping` are all excluded, and the
 * last two are refused rather than skipped one branch below.
 */
export const isBulkOpenEligible = (
  bay: BayState | null,
): boolean =>
  bay !== null &&
  (bay.phase === "quarantined" ||
    (bay.phase === "done" && bay.outcome !== null))

/**
 * This bay is finished with AND still holds the disc — i.e. it
 * is a bay `open_trays` would actually move in `"finished"` scope.
 *
 * The per-bay half of the finished-bay fold the caller uses to
 * resolve `openScope`, kept here so the question the operator folds
 * is the same question `decideTrayBayAction` answers. **The media
 * check is
 * the load-bearing part**: a bay latched `done` whose disc the
 * operator already took out is finished with, but pressing ▲
 * still moves nothing, and "nothing moved" is precisely the
 * broken-feeling button the fallback exists to prevent. So the
 * fallback engages exactly when the selective open would have
 * been a no-op.
 */
export const hasFinishedDisc = (input: {
  bay: BayState | null
  observation: BayObservation
}): boolean =>
  input.observation.isDrivePresent &&
  input.observation.hasMedia &&
  isBulkOpenEligible(input.bay)

/**
 * The disc in this bay has a rip that actually succeeded.
 *
 * The narrow reading of the owner's "completed": `done` +
 * `completed`, and nothing else. Used to split the report, so
 * an unripped disc is never announced as a finished one.
 */
export const isRipCompleted = (
  bay: BayState | null,
): boolean =>
  bay !== null &&
  bay.phase === "done" &&
  bay.outcome?.kind === "completed"

export const isBayTargeted = (input: {
  target: BayTarget
  driveId: string
  slot: number | null
}): boolean =>
  "slot" in input.target
    ? input.slot === input.target.slot
    : input.driveId === input.target.driveId

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
  /** Nothing to get at — the tray is empty. */
  | "skipped_no_disc"
  /**
   * ⚠️ No longer produced. `close_open` used to skip a bay
   * holding a disc, inferring its tray must be shut. Kept because
   * the dashboard's type carries it and a retained MQTT payload
   * may still say it.
   */
  | "skipped_has_disc"
  /**
   * `close_trays` left this bay alone because rip-deck never
   * opened it — its tray is already shut, so there was nothing to
   * close. The authority is `lastTrayCommand`, not disc presence
   * ([decision](docs/decisions/2026-07-27-tray-memory-beats-disc-presence.md)).
   */
  | "skipped_already_closed"
  | "skipped_not_present"
  /**
   * A `power_off` press left this bay's tray exactly where it was.
   *
   * Cutting mains moves no drawer and ejects nothing. The kind
   * exists so the refusal loop can answer for EVERY bay — the
   * refusal that protects a running rip is only trustworthy if the
   * question was asked of all nine — while still saying plainly
   * that nothing was done here.
   */
  | "skipped_untouched"
  /**
   * A `power_off` press cut mains while this bay was `starting`.
   *
   * Warned about, never refused. `starting` is the settle → type
   * → identify window: the ripper child does not exist yet
   * (`applyRipStarted` flips the phase *before* the spawn, on
   * both the makemkv and cyanrip paths), so no byte has been
   * written and the press destroys nothing. It is still said out
   * loud, because a disc that was mid-identify when the lights
   * went out is a disc the operator should expect to see re-read
   * on the way back up.
   */
  | "skipped_starting"
  /**
   * A rip was started on this bay because an operator asked.
   *
   * "Started", not "finished": the dispatch is queued and the reply
   * goes back at once. A rip takes an hour and the operator is
   * standing at a dashboard that already renders live progress —
   * holding the HTTP response open for it would only mean the
   * button spins for an hour and times out first.
   */
  | "rip_started"
  | "failed"

export type TrayBayDecision =
  | { action: "open" }
  | { action: "close" }
  /** ⚠️ Start a rip on this bay. Only ever from `rip_bay`. */
  | { action: "rip" }
  | {
      action: "refuse"
      resultKind: "refused_ripping"
      detail: string
    }
  | {
      action: "skip"
      resultKind: TrayBayResultKind
      detail: string
    }

/**
 * What to do about one bay, given one command and one reading.
 *
 * Read the order of the branches as the safety argument, the
 * same way `decideBayAction` reads: the refusal that protects a
 * running rip comes before every command-specific rule, so
 * there is no command — bulk or targeted — that can reach a
 * drive a rip owns. `openScope` is consulted only *after* that
 * refusal, and it can only ever widen `open_trays` to bays that
 * are doing nothing.
 */
export const decideTrayBayAction = (input: {
  request: TrayCommandRequest
  bay: BayState | null
  observation: BayObservation
  /**
   * A rip owns any bay on this shared USB tree.
   *
   * Bulk CLOSE uses this tower-wide fact. The live tower proved
   * that closing other drawers in parallel can reset the hub and
   * make an untouched ripping drive vanish too.
   */
  hasActiveRip?: boolean
  /**
   * How wide an `open_trays` press reaches, resolved by the caller
   * over the whole probe and the tray memory
   * ([decision](docs/decisions/2026-07-30-open-trays-escalates-and-close-trays-is-plain.md)):
   *
   *  - **`"finished"`** — open only the bays that are finished with
   *    and still hold their disc (a completed or failed rip ready to
   *    be taken out). The first press when there is anything to
   *    collect.
   *  - **`"all"`** — open every present, non-ripping bay, including
   *    idle and empty ones. The escalation: pressed again once the
   *    finished bays are already open, or the very first press when
   *    nothing is finished.
   *
   * Optional, and **defaults to `"finished"` on purpose**: it is the
   * reading that moves the fewest trays, so a caller that has not
   * folded the tower never triggers a surprise nine-drawer open.
   */
  openScope?: "finished" | "all"
}): TrayBayDecision => {
  const { bay, observation, request } = input
  const openScope = input.openScope ?? "finished"

  if (!observation.isDrivePresent) {
    return {
      action: "skip",
      resultKind: "skipped_not_present",
      detail: "the drive is not on the bus right now",
    }
  }

  // ⚠️ THE REFUSAL. Ejecting mid-rip destroys the copy, and a
  // rip is the one thing here that cannot be re-done cheaply —
  // 90 GB and an hour. Loud, not silent: this is reported and
  // counted, never folded in with the bays that had nothing to
  // do.
  if (
    bay !== null &&
    (bay.phase === "starting" || bay.phase === "ripping")
  ) {
    // ⚠️ The ONE exception, and it is not a softening of the rule
    // — it is the rule applied to what `starting` actually is.
    //
    // The refusal protects WRITTEN BYTES. `ripping` has them.
    // `starting` is settle → type → identify and has none: the
    // ripper child is spawned *after* `applyRipStarted` flips the
    // phase, on both the makemkv and the cyanrip path, so a
    // `starting` bay has never had a ripper. Cutting mains under
    // it costs a re-read, not 90 GB.
    //
    // Refusing it anyway was a deadlock, hit live on 2026-08-26.
    // `starting` had no upper bound: a wedged USB bus left five
    // bays there for 75 minutes, and one `starting` bay is enough
    // to refuse the whole press. So the Tower off button — the
    // only control in this dashboard that can clear a wedged bus —
    // was held shut by the wedge it exists to clear, and the owner
    // had to go and pull the plug.
    //
    // Tray moves are still refused for `starting`, and that is not
    // inconsistent: opening a drawer under a live `makemkvcon`
    // read is how the eject/insert flap-storm starts (B3), and
    // unlike mains it fixes nothing when the bus is down.
    const isHarmlessPowerCut =
      request.kind === "power_off" &&
      bay.phase === "starting"

    if (!isHarmlessPowerCut) {
      return {
        action: "refuse",
        resultKind: "refused_ripping",
        detail:
          `REFUSED — this bay is ${bay.phase}. Opening the ` +
          "tray now would destroy the rip in progress. Nothing " +
          "was touched.",
      }
    }

    return {
      action: "skip",
      resultKind: "skipped_starting",
      detail:
        "the tower's power was cut while this bay was still " +
        "reading the disc. No rip had started, so nothing was " +
        "lost; the disc is still in the drive.",
    }
  }

  // A per-bay refusal was not enough. On 2026-08-29, three
  // ripping bays were correctly refused while Close Trays moved
  // the other drawers. The motor load reset the shared USB hub;
  // all nine drives disconnected and all three rips failed with
  // ENODEV. A bulk close is therefore all-or-nothing while any
  // rip is active: every non-ripping bay is skipped too.
  if (
    request.kind === "close_trays" &&
    input.hasActiveRip === true
  ) {
    return {
      action: "skip",
      resultKind: "skipped_untouched",
      detail:
        "another bay is ripping, so the tower-wide close " +
        "command moved no trays",
    }
  }

  switch (request.kind) {
    case "open_bay":
      return { action: "open" }

    case "close_bay":
      return { action: "close" }

    case "power_off":
      // The refusal above is the whole of this command's per-bay
      // question, and it has already been answered. Cutting mains
      // moves no tray, so a bay that is not ripping is untouched.
      return {
        action: "skip",
        resultKind: "skipped_untouched",
        detail:
          "the tower's power was cut; this bay's tray was not " +
          "touched",
      }

    case "clear_loaded":
      // Never routed per bay — `runTrayCommandForRequest` answers
      // `clear_loaded` before it probes, because it acts on
      // rip-deck's memory and not on any drawer. This case exists
      // only to keep the switch total; reaching it would still be
      // safe, because forgetting a disc moves no tray.
      return {
        action: "skip",
        resultKind: "skipped_untouched",
        detail:
          "the loaded-discs reminder was cleared; no tray was " +
          "touched",
      }

    case "rip_bay":
      // The one thing a rip needs that a tray command does not:
      // something to rip. Everything else this branch could check
      // — already `done`, already `needs_attention`, quarantined,
      // out of starts — is precisely the state the operator is
      // pressing the button to overrule, so refusing on any of them
      // would rebuild the dead end this command exists to remove.
      //
      // The `starting`/`ripping` refusal above still stands, and it
      // is the only one that matters here: it is what stops a
      // second rip being started on a drive one already owns.
      return observation.hasMedia
        ? { action: "rip" }
        : {
            action: "skip",
            resultKind: "skipped_no_disc",
            detail:
              "there is no disc in this bay to rip. Put one in " +
              "and it will rip on its own.",
          }

    case "open_trays":
      // ⚠️ THE ESCALATION. `"all"` is the second press (or the
      // first when nothing is finished): open every present bay
      // that is not ripping — idle and empty ones too, so a disc
      // can be loaded. It cannot reach a rip: `starting`/`ripping`
      // is refused above, so eight idle bays and one ripping bay
      // opens the eight and refuses the one.
      if (openScope === "all") {
        return { action: "open" }
      }

      // `"finished"` — the first press when there is something to
      // collect: open only the bays finished with (a completed or
      // failed rip) that still hold their disc.
      if (!isBulkOpenEligible(bay)) {
        return {
          action: "skip",
          resultKind: "skipped_not_finished",
          detail:
            "nothing in this bay is finished with, so there " +
            "is nothing to take out",
        }
      }

      // Latched, but the disc has already gone — the operator
      // opened this bay a minute ago and took it. Opening again
      // would be a tray flapping for no reason.
      if (!observation.hasMedia) {
        return {
          action: "skip",
          resultKind: "skipped_no_disc",
          detail: "there is no disc in this bay",
        }
      }

      return { action: "open" }

    case "close_trays":
      // Close only what rip-deck knows it opened. `lastTrayCommand`
      // is the authority on tray position — disc presence is not,
      // because `open_trays` leaves `hasMedia` true on the open
      // tray ([decision](docs/decisions/2026-07-27-tray-memory-beats-disc-presence.md)).
      // A bay it never opened is already shut, and `CDROMCLOSETRAY`
      // on a closed tray would be a no-op anyway, so skipping it is
      // the honest report rather than a phantom "closed".
      //
      // A rip is still untouchable: the refusal is above.
      if (bay?.lastTrayCommand === "open_bay") {
        return { action: "close" }
      }

      return {
        action: "skip",
        resultKind: "skipped_already_closed",
        detail:
          "this bay is not open, so there is nothing to close",
      }
  }
}

/* ------------------------------------------------------------ *
 * The report. An operator who hears nothing has learned nothing.
 * ------------------------------------------------------------ */

export type TrayBayResult = {
  driveId: string
  slot: number | null
  label: string
  resultKind: TrayBayResultKind
  detail: string
}

export type TrayCommandResponsePayload = {
  request_id: string | null
  command: TrayCommandKind | null
  is_accepted: boolean
  /** One sentence, written to be READ — on screen or in a log. */
  message: string
  /**
   * The same answer, written to be HEARD. Additive.
   *
   * `automation.control_optical_ripper_tower` speaks a tray
   * problem's text verbatim through ChimeTTS, and `message` is
   * written for a reader: it carries counts, colons, comma lists
   * and — on a failure — the device's own words, which come out of
   * a house speaker as "weird computer-style text" (owner,
   * 2026-07-30). The two audiences want genuinely different
   * sentences, so this is a second field rather than a compromise
   * that serves neither
   * ([decision](docs/decisions/2026-07-30-spoken-and-written-messages-are-separate-fields.md)).
   *
   * Rules it keeps and `message` does not: no backticks, no CLI
   * syntax, no raw device text, no drive model numbers, and at
   * most two short sentences. Slots are the operator's numbering
   * and the one identifier worth saying aloud.
   *
   * Additive, so a Home Assistant automation reading `message`
   * keeps working — HA prefers this and falls back.
   */
  spoken_message: string
  started_at: number
  finished_at: number
  counts: {
    opened: number
    opened_not_ripped: number
    closed: number
    refused: number
    failed: number
    skipped: number
    /** Rips started by a `rip_bay` command. Additive. */
    rip_started: number
  }
  bays: {
    drive_id: string
    slot: number | null
    label: string
    result: TrayBayResultKind
    detail: string
  }[]
}

/**
 * "slot 7", "slots 7 and 8", "slots 7, 8 and 9".
 *
 * Takes the two fields it actually reads rather than a whole
 * `TrayBayResult`, so `loadedDiscs.ts` can phrase its reminder the
 * same way this file phrases a refusal. One list format across
 * every sentence rip-deck says about a set of bays.
 */
export const formatBayList = (
  results: readonly {
    slot: number | null
    label: string
  }[],
): string => {
  const names = results.map((result) =>
    result.slot === null
      ? result.label
      : String(result.slot),
  )

  const noun = names.length === 1 ? "slot" : "slots"

  const joined =
    names.length <= 1
      ? names.join("")
      : `${names.slice(0, -1).join(", ")} and ${
          names[names.length - 1]
        }`

  return `${noun} ${joined}`
}

const countOf = (
  results: TrayBayResult[],
  kind: TrayBayResultKind,
): TrayBayResult[] =>
  results.filter((result) => result.resultKind === kind)

/**
 * The sentence Home Assistant reads out.
 *
 * Priority order, and it is deliberate: **a refusal is said
 * first**, because it is the only line that means someone must
 * not do the thing they were about to do. Then what moved, then
 * what failed. A press that moved nothing says so explicitly
 * rather than producing an empty string — silence is
 * indistinguishable from a broken button.
 */
export const buildTrayCommandMessage = (input: {
  request: TrayCommandRequest
  results: TrayBayResult[]
  /** Same input, same default, as `decideTrayBayAction`. */
  openScope?: "finished" | "all"
}): string => {
  const { results } = input

  // The sentence has to describe the command that actually ran.
  // "Opened 9 drives" is true either way; "8 of those were never
  // ripped" is news after a rip session and noise on an idle
  // tower, where NOTHING was ripped and the operator asked for
  // all nine on purpose (the `"all"` escalation).
  const isOpenAll =
    input.request.kind === "open_trays" &&
    input.openScope === "all"

  const refused = countOf(results, "refused_ripping")
  const opened = countOf(results, "opened")
  const openedNotRipped = countOf(
    results,
    "opened_not_ripped",
  )
  const closed = countOf(results, "closed")
  const failed = countOf(results, "failed")
  const ripStarted = countOf(results, "rip_started")

  const sentences: string[] = []

  if (refused.length > 0) {
    sentences.push(
      input.request.kind === "rip_bay"
        ? `Refused: ${formatBayList(refused)} is already ` +
            "ripping."
        : input.request.kind === "power_off"
          ? `NOT powering the tower off — ${formatBayList(
              refused,
            )} ${
              refused.length === 1 ? "is" : "are"
            } still ripping. Cutting power now would lose ` +
            `${refused.length === 1 ? "it" : "them"}.`
          : `Refused to ${
              input.request.kind === "close_trays" ||
              input.request.kind === "close_bay"
                ? "close"
                : "open"
            } ${formatBayList(refused)}: still ripping.`,
    )
  }

  if (ripStarted.length > 0) {
    // NOT `: ${detail}`. The bay's detail is written to stand alone
    // on its own card ("reading the disc's own name, then
    // ripping"), and glued to this stem it read "Ripping slot 9:
    // reading the disc's own name, then ripping" — saying ripping
    // twice. Measured on the live tower 2026-07-30. Both strings
    // are still published; the card renders the detail beside this.
    sentences.push(`Ripping ${formatBayList(ripStarted)}.`)
  }

  const openedTotal = opened.length + openedNotRipped.length

  if (openedTotal > 0) {
    // Sorted by slot, NOT `opened` then `openedNotRipped`. The
    // concatenation read "slots 2, 1, 3, 4, 5, 6, 7, 8 and 9" on
    // the live tower, because the one ripped bay sorts ahead of
    // eight empty ones that happen to be in order. The split is
    // its own sentence below; this one is a list of drawers the
    // operator is about to walk over to, so it reads in the order
    // they are racked. A null slot keeps its label and sorts last.
    const openedAll = [...opened, ...openedNotRipped].sort(
      (left, right) =>
        (left.slot ?? Number.MAX_SAFE_INTEGER) -
        (right.slot ?? Number.MAX_SAFE_INTEGER),
    )

    sentences.push(
      `Opened ${String(openedTotal)} ` +
        `${openedTotal === 1 ? "drive" : "drives"}: ` +
        `${formatBayList(openedAll)}.`,
    )
  }

  if (openedNotRipped.length > 0 && !isOpenAll) {
    sentences.push(
      `${
        openedNotRipped.length === 1
          ? "One of those was"
          : `${String(openedNotRipped.length)} of those were`
      } never ripped: ${formatBayList(openedNotRipped)}.`,
    )
  }

  if (closed.length > 0) {
    sentences.push(
      `Closed ${String(closed.length)} ` +
        `${closed.length === 1 ? "drive" : "drives"}: ` +
        `${formatBayList(closed)}.`,
    )
  }

  if (failed.length > 0) {
    sentences.push(
      `${formatBayList(failed)} failed: ` +
        `${failed[0].detail}`,
    )
  }

  if (sentences.length > 0) return sentences.join(" ")

  // A `rip_bay` that started nothing was aimed at ONE bay, so the
  // bay's own sentence is the answer — "no disc in it", "not on the
  // bus". The bulk fallbacks below describe a set and would drop it.
  if (input.request.kind === "rip_bay") {
    return results.length === 1
      ? `Nothing to rip: ${results[0].detail}.`
      : "Nothing to rip — no bay matched."
  }

  // Nothing moved. Say WHICH nothing: `close_trays` is silent when
  // no bay was open to close, and an idle tower with every tray
  // empty is one way ▲ can be.
  if (input.request.kind === "close_trays") {
    const closable = countOf(
      results,
      "skipped_already_closed",
    )

    return closable.length > 0
      ? "No trays to close — none are open."
      : "No trays to close — no drives are on the bus."
  }

  return isOpenAll
    ? "Nothing to open — no discs are loaded."
    : "Nothing to open — no finished discs are loaded."
}

/**
 * The same answer, for a speaker instead of a screen.
 *
 * ⚠️ **This is not `buildTrayCommandMessage` with the punctuation
 * taken out.** It says LESS on purpose. Home Assistant speaks a
 * tray problem and nothing else, so the only sentences that ever
 * reach a listener are the two that mean something went wrong —
 * and a listener standing at the tower cannot re-read a line, take
 * notes, or scroll back. So this answers one question ("what do I
 * need to do?") and leaves the accounting to `message`, which the
 * dashboard and the log still carry in full.
 *
 * Three rules, each of them a thing `message` does that a speaker
 * must not:
 *
 *  - **Never the device's own words.** A `failed` bay's `detail` is
 *    whatever `eject` printed. Spoken, that is the "weird
 *    computer-style text" the owner reported. The slot number is
 *    the actionable half; the rest is for whoever reads the card.
 *  - **Never the counts.** "Opened 3 drives: slots 1, 2 and 3" is
 *    a table read aloud. The trays are visible from where the
 *    listener is standing — that is why routine results are not
 *    spoken at all.
 *  - **Refusal first, and alone if it happened.** It is the only
 *    line that means *stop*.
 */
export const buildTraySpokenMessage = (input: {
  request: TrayCommandRequest
  results: TrayBayResult[]
}): string => {
  const { results } = input

  const refused = countOf(results, "refused_ripping")

  if (refused.length > 0) {
    if (input.request.kind === "power_off") {
      return (
        "Not turning the optical ripper tower off. A rip is " +
        "still running, and cutting power now would lose it."
      )
    }

    return input.request.kind === "rip_bay"
      ? `${
          formatBayList(refused).charAt(0).toUpperCase() +
          formatBayList(refused).slice(1)
        } is already ripping.`
      : `Not opening ${formatBayList(refused)} — ` +
          `${refused.length === 1 ? "it is" : "they are"} ` +
          "still ripping."
  }

  const ripStarted = countOf(results, "rip_started")

  if (ripStarted.length > 0) {
    return `Ripping ${formatBayList(ripStarted)}.`
  }

  const failed = countOf(results, "failed")

  if (failed.length > 0) {
    return (
      `${
        failed.length === 1 ? "One bay" : "Some bays"
      } did not answer: ${formatBayList(failed)}. Nothing ` +
      "else was affected."
    )
  }

  const moved =
    countOf(results, "opened").length +
    countOf(results, "opened_not_ripped").length +
    countOf(results, "closed").length

  // Never actually spoken today (HA speaks problems only), and
  // written as though it were: a field that is only correct on
  // the paths someone happened to test is the one that surprises
  // whoever wires up the next listener.
  if (moved > 0) {
    const isClose =
      input.request.kind === "close_trays" ||
      input.request.kind === "close_bay"

    return (
      `${isClose ? "Closed" : "Opened"} ${String(moved)} ` +
      `${moved === 1 ? "tray" : "trays"}.`
    )
  }

  switch (input.request.kind) {
    case "close_trays":
    case "close_bay":
      return "Nothing to close."
    case "rip_bay":
      return "Nothing to rip."
    case "power_off":
      return "Turning the optical ripper tower off."
    default:
      return "Nothing to open."
  }
}

export const buildTrayCommandResponse = (input: {
  request: TrayCommandRequest
  requestId: string | null
  results: TrayBayResult[]
  startedAtMs: number
  finishedAtMs: number
  /** Same input, same default, as `decideTrayBayAction`. */
  openScope?: "finished" | "all"
}): TrayCommandResponsePayload => ({
  request_id: input.requestId,
  command: input.request.kind,
  is_accepted: true,
  message: buildTrayCommandMessage({
    request: input.request,
    results: input.results,
    openScope: input.openScope,
  }),
  spoken_message: buildTraySpokenMessage({
    request: input.request,
    results: input.results,
  }),
  started_at: input.startedAtMs,
  finished_at: input.finishedAtMs,
  counts: {
    opened: countOf(input.results, "opened").length,
    opened_not_ripped: countOf(
      input.results,
      "opened_not_ripped",
    ).length,
    closed: countOf(input.results, "closed").length,
    refused: countOf(input.results, "refused_ripping")
      .length,
    failed: countOf(input.results, "failed").length,
    skipped: input.results.filter((result) =>
      result.resultKind.startsWith("skipped_"),
    ).length,
    rip_started: countOf(input.results, "rip_started")
      .length,
  },
  bays: input.results.map((result) => ({
    drive_id: result.driveId,
    slot: result.slot,
    label: result.label,
    result: result.resultKind,
    detail: result.detail,
  })),
})

/**
 * An `open_trays` press that reached an OFF tower.
 *
 * No bay moved and none could — the drives are not on the bus. The
 * daemon has published the power-on request; this tells the operator
 * what happened and what to do next, on the same `resp/drive` topic
 * and with the same `is_accepted: true` shape as a real report.
 */
export const buildTrayPowerOnResponse = (input: {
  requestId: string | null
  atMs: number
}): TrayCommandResponsePayload => ({
  request_id: input.requestId,
  command: "open_trays",
  is_accepted: true,
  message:
    "The tower was off — powering it on. Give the drives a few " +
    "seconds to come up, then press Open trays again.",
  spoken_message:
    "The tower was off. Turning it on — try again in a few " +
    "seconds.",
  started_at: input.atMs,
  finished_at: input.atMs,
  counts: {
    opened: 0,
    opened_not_ripped: 0,
    closed: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
    rip_started: 0,
  },
  bays: [],
})

/**
 * The tower is being switched off, and what is still inside it.
 *
 * Published on the same `resp/drive` topic and with the same shape
 * as a tray report, so a dashboard and an automation have one
 * place to look.
 *
 * ## Why it warns instead of refusing
 *
 * Powering the tower down **traps every loaded disc**: an
 * unpowered drive will not open its tray, so the discs stay in
 * there until it comes back on. The owner was asked which of
 * warn / two-step confirm / refuse-until-empty he wanted and chose
 * **warn, then power off anyway**
 * ([decision](docs/decisions/2026-07-30-the-dashboard-can-switch-the-tower-off.md)) —
 * he knows what is in his own tower, and a control that argues
 * with him about a reversible, self-inflicted inconvenience is the
 * held-card defect again.
 *
 * ⚠️ **A RUNNING RIP is a different thing entirely and is refused,
 * not warned.** That is not this builder's branch — the refusal is
 * `decideTrayBayAction`'s first one, asked of every bay before
 * anything reaches here. Trapping a disc costs a walk downstairs;
 * cutting power mid-rip costs 90 GB and an hour.
 */
export const buildTowerPowerOffResponse = (input: {
  requestId: string | null
  atMs: number
  loaded: LoadedDiscSummary
}): TrayCommandResponsePayload => {
  const { loaded } = input

  const trapped =
    loaded.count === 0
      ? ""
      : ` ⚠️ ${
          loaded.count === 1
            ? "1 disc is"
            : `${String(loaded.count)} discs are`
        } still loaded — ${formatBayList(loaded.discs)} — and ` +
        "an unpowered drive will not open its tray."

  return {
    request_id: input.requestId,
    command: "power_off",
    is_accepted: true,
    message: `Turning the optical ripper tower off.${trapped}`,
    // Short, and it drops the slot list: a listener across the
    // house cannot act on which slots, only on the fact.
    spoken_message:
      loaded.count === 0
        ? "Turning the optical ripper tower off."
        : `Turning the optical ripper tower off. ${
            loaded.count === 1
              ? "A disc is"
              : `${String(loaded.count)} discs are`
          } still in it.`,
    started_at: input.atMs,
    finished_at: input.atMs,
    counts: {
      opened: 0,
      opened_not_ripped: 0,
      closed: 0,
      refused: 0,
      failed: 0,
      skipped: 0,
      rip_started: 0,
    },
    bays: [],
  }
}

/**
 * The loaded-discs reminder was cleared by hand, and how much it
 * forgot.
 *
 * Same `resp/drive` shape as a tray report so the dashboard and an
 * automation read one payload. It moved no drawer — `bays` is empty
 * and every count is zero — so it reports through `message` alone:
 * how many discs rip-deck had been reminding about and has now
 * stopped. `cleared === 0` is a no-op the operator still gets an
 * honest answer to, rather than silence that reads as a broken
 * button ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
 */
export const buildClearLoadedResponse = (input: {
  requestId: string | null
  atMs: number
  /** How many loaded discs rip-deck was reminding about. */
  cleared: number
}): TrayCommandResponsePayload => {
  const { cleared } = input

  const message =
    cleared === 0
      ? "Nothing was loaded, so there was no reminder to clear."
      : `Cleared the reminder — ${
          cleared === 1
            ? "1 disc"
            : `${String(cleared)} discs`
        } marked as taken out. rip-deck will re-check the moment ` +
        "the tower is back on the bus."

  return {
    request_id: input.requestId,
    command: "clear_loaded",
    is_accepted: true,
    message,
    // The reminder is a written chore, cleared from a screen; there
    // is nothing for a house speaker to say about it.
    spoken_message: "",
    started_at: input.atMs,
    finished_at: input.atMs,
    counts: {
      opened: 0,
      opened_not_ripped: 0,
      closed: 0,
      refused: 0,
      failed: 0,
      skipped: 0,
      rip_started: 0,
    },
    bays: [],
  }
}

/**
 * A command we could not even read, answered anyway.
 *
 * Published on the same `resp/drive` topic as a real report, so
 * a dashboard or an automation has exactly one place to look
 * and `is_accepted` to branch on.
 */
export const buildTrayCommandRejection = (input: {
  requestId: string | null
  reason: string
  atMs: number
}): TrayCommandResponsePayload => ({
  request_id: input.requestId,
  command: null,
  is_accepted: false,
  message: `Tray command refused: ${input.reason}`,
  // Deliberately WITHOUT the reason. Every `reason` this builder
  // is handed is written for whoever has to fix the sender — it
  // quotes the payload in backticks and names JSON fields — and
  // spoken it is unactionable to the person standing at the tower.
  // "Something is wrong with the sender" is the whole of what a
  // listener can do something about; the dashboard and the log
  // carry the rest.
  spoken_message:
    "Rip Deck could not understand that command. Nothing was " +
    "touched.",
  started_at: input.atMs,
  finished_at: input.atMs,
  counts: {
    opened: 0,
    opened_not_ripped: 0,
    closed: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
    rip_started: 0,
  },
  bays: [],
})

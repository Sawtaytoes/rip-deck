import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import type { DiscType } from "@rip-deck/contracts"
import type { BayTrayCommand } from "./trayCommand.ts"
import type {
  BayObservation,
  BayOutcome,
  BayState,
} from "./watcher.ts"

/**
 * What each bay had finished with, across a restart.
 *
 * ## The hole this closes
 *
 * `startWatcher` builds `const bays = new Map<string,
 * BayState>()` and hydrates it from nothing. Everything the bay
 * state machine knows — above all *"this disc has already been
 * ripped"* — lives only in that map, and `$RIP_DECK_STATE_DIR`
 * holds per-job artefacts (`<uuid>.robot.log`,
 * `.samples.jsonl`, `.features.json`, `.heartbeat`) and no
 * record of a bay at all.
 *
 * Two consequences, and both are load-bearing:
 *
 *  1. **A restart with finished discs still loaded re-rips every
 *     one of them.** A fresh bay is `idle`, never `done`, so THE
 *     RULE (`phase === "done"` + matching `sizeSectors` → hold)
 *     cannot fire and `decideBayAction` falls straight through to
 *     `action: "start"`. Measured against the real tower on
 *     2026-07-26: three finished Troy discs, 225 GB, about two
 *     hours of drive time, for nothing.
 *  2. **"Open every completed drive" would open nothing.**
 *     Completed-ness lives in that same map, so the restart that
 *     deploys the eject command is the restart that erases the
 *     state the eject command reads.
 *
 * ## Why the fingerprint is `sizeSectors`, and why that is
 * enough *here*
 *
 * `sizeSectors` is a weak disc fingerprint — two different
 * studio Blu-rays of identical size are not rare — and
 * `watcher.ts` already says so. It is sufficient for this
 * ledger because the record is **per bay**, not per disc: a
 * false match needs the same bay to have been reloaded, while
 * the daemon was down, with a *different* disc of *exactly* the
 * same sector count. And the direction of that error is safe —
 * a false match HOLDS a disc that should have been ripped, which
 * a human notices, rather than re-ripping one that should not.
 *
 * The disc's own name IS in the record as of v2 — but as a fact
 * to show, not as the fingerprint. Matching on it would need a
 * `makemkvcon` call against every loaded bay at startup, and
 * running nine of those is the bus-scan contention the isolation
 * decision exists to prevent. So the write side is done and the
 * match still costs nothing; using it as the comparison remains
 * the follow-up in `docs/eject-and-durable-bay-state.md` §5.
 *
 * ## Fail closed only where there is real ambiguity
 *
 * The obvious rule — *"hold any disc that was already loaded
 * when we started"* — is too wide, and the owner's recorded
 * decision says so: **every inserted disc rips, up to all nine
 * at once**. Loading the tower and then starting rip-deck is a
 * normal thing to do and must still produce nine rips. Widening
 * a narrow safety rule until it bans a capability the owner
 * asked for is the exact mistake
 * `docs/HANDOFF-eject-and-open-questions.md` §1 documents.
 *
 * So the hold is keyed on whether rip-deck has **any memory at
 * all**, which `hasPriorState` answers:
 *
 *  - **Ledger read, valid** (`hasPriorState`). Every disc that
 *    was finished with is in it. A loaded disc that matches a
 *    record is restored and held; one that does not is a disc
 *    rip-deck genuinely has not seen, so it rips. No regression.
 *  - **No ledger, or an unreadable one.** rip-deck has no way to
 *    tell a fresh tower from three finished discs left in their
 *    trays by the daemon that was running a minute ago. A disc
 *    already loaded at the first observation is latched
 *    `needs_attention` and NOT ripped, because a duplicate
 *    90 GB backup costs hours and a held disc costs a button
 *    press. This is a one-off: the first tick writes a ledger,
 *    so it happens once per state directory.
 *
 * Either way it applies to the FIRST observation of a bay only.
 * Once a bay has been seen with an empty tray, the disc that
 * arrives next is a genuine insert and rips exactly as before.
 *
 * ⚠️ This used to add that "open the tray and close it again" is
 * the operator's way to say *"yes, rip this after all"*. It is
 * NOT, on this hardware: these drives keep reporting their disc
 * after the tray opens, so the bay never reads empty and never
 * re-arms
 * ([decision](docs/decisions/2026-07-27-tray-memory-beats-disc-presence.md)).
 * Physically removing the disc works; so does the Rip button
 * ([decision](docs/decisions/2026-07-30-a-held-bay-is-ripped-from-the-dashboard.md)).
 */

/**
 * Bumped when the on-disk shape changes incompatibly.
 *
 * **v2 added `discName` and `destinationPath`** — the two facts
 * a held bay's card needs and only the outcome sentence used to
 * carry — and then `discType`, `jobUuid` and the `trayCommands`
 * section, all on the same bump.
 *
 * ⚠️ **Deliberately still 2, and that is the whole reason those
 * later three arrived in one change.** A version bump costs the
 * owner one manual pass over the tower (see below), and v2 has
 * never been deployed — no daemon anywhere has written a v2
 * file — so adding fields to it costs nothing at all. Bumping
 * to 3 would buy exactly one thing: rejecting a v2 file written
 * by a mid-stage build of this same branch. `parseBayLedger`
 * already handles that case field by field, so the bump would
 * be a second held-tower pass in exchange for nothing.
 *
 * ⚠️ **The version bump costs one restart.** `parseBayLedger`
 * returns `EMPTY_BAY_LEDGER` on a mismatch, so the v1 ledger on
 * the tower right now reads as NO memory at all — which is the
 * fail-closed branch of `adoptBayAtStartup`, i.e. every loaded
 * disc is HELD and flagged, never re-ripped. Safe, and the owner
 * will see the one-time "held on startup" note on all loaded
 * bays the first time this deploys, exactly as
 * `docs/eject-and-durable-bay-state.md` §5 describes for the
 * ledger's own first boot. It happens once: the first tick
 * writes a v2 ledger. Deliberately NOT migrated — a migrated v1
 * record would have to claim a `discName` nobody recorded, and
 * inventing that is the failure this whole change is undoing.
 */
export const BAY_LEDGER_VERSION = 2

export const BAY_LEDGER_FILENAME = "bays.json"

/** One bay's last latched result, as written to disk. */
export type BayLedgerRecord = {
  driveId: string
  /** Only latched phases are worth remembering. */
  phase: "done" | "quarantined"
  sizeSectors: number | null
  /**
   * The disc's own name, as `identifyDisc` read it.
   *
   * A FIELD, and that is the whole point of v2: it used to
   * exist only inside `outcome.detail`'s English sentence, so
   * the dashboard's only route to it was scraping prose — the
   * `MSG:5072` mistake, which this repo refuses on principle.
   * Null for a disc that never got as far as being identified
   * (held at startup, unreadable label, a quarantine decided by
   * the poll loop).
   */
  discName: string | null
  /**
   * What `decideDiscType` typed the disc as. Null for a disc
   * nothing typed.
   *
   * A field for the same reason `discName` is one: the poster
   * lookup has to send an audio CD to a music provider and a
   * film to a film provider, and asking OMDb about an album is
   * how a CD ends up wearing a film's poster. The watcher knows
   * it at `onIdentified`, minutes before the outcome — so
   * without this the fact was simply thrown away, and every
   * consumer wrote `discType: "unknown"`.
   */
  discType: DiscType | null
  /**
   * Where the rip landed, for the same reason.
   *
   * Null unless a rip of this disc actually finished and
   * published — a failed or held bay has no destination, and a
   * path here would claim bytes exist that do not.
   */
  destinationPath: string | null
  /**
   * The rip that produced this outcome, by its capture id.
   *
   * `$RIP_DECK_STATE_DIR/<uuid>.robot.log` is named for it, so
   * this is the ONLY route a held disc's log has across a
   * restart: without it an adopted bay falls back to
   * `towerFeed`'s deliberately-non-UUID `<driveId>@<ms>`
   * placeholder, `armView` correctly refuses to name a file
   * from that, and the card's log button disappears on every
   * deploy — for exactly the discs the owner most wants a log
   * for.
   *
   * Null for a bay latched without a job of its own: a
   * quarantine (decided by the poll loop), and a disc held by
   * the fail-closed startup path (ripped, if at all, by a
   * daemon whose uuid nobody recorded).
   */
  jobUuid: string | null
  outcome: BayOutcome
  updatedAtMs: number
}

/**
 * The last tray command rip-deck itself sent one bay.
 *
 * ## Why this is NOT a field on `BayLedgerRecord`
 *
 * Different subject, and — the part that actually bites —
 * different LIFETIME. A `BayLedgerRecord` is about the DISC in a
 * bay: it is written when that disc is finished with and it dies
 * the moment the disc leaves (`applyBayDecision`'s `rearm`
 * builds a fresh `BayState`). The tray memory is about the
 * DRAWER, and the one press it exists to answer is the press
 * that comes AFTER the disc has been taken out — *"the last
 * thing I did to this bay was open it, so the next press
 * closes"*. Folded into the disc record it would be erased by
 * the removal it is meant to survive, or it would force a
 * disc-shaped record to exist for a bay that has no disc and no
 * outcome. Two sections, two lifetimes, and `toLedgerRecords`
 * keeps meaning exactly what it says.
 */
export type BayTrayRecord = {
  driveId: string
  /**
   * ⚠️ **What rip-deck DID, never where the drawer is.** Tray
   * position is unreadable: sysfs reports media, not the door,
   * so an open tray and a closed empty tray are the same bytes
   * and telling them apart needs a `CDROM_DRIVE_STATUS` ioctl
   * Node cannot issue (`docs/eject-and-durable-bay-state.md`
   * §2). This is the honest substitute the ⏏ toggle stands on,
   * and the inference from it is stated where it is made
   * (`web/src/format.ts` `nextTrayCommandFor`).
   *
   * Written only when a tray ACTUALLY MOVED — a refusal or a
   * skip leaves it alone, because neither touched the drawer.
   */
  lastTrayCommand: BayTrayCommand
  updatedAtMs: number
}

export type BayLedger = {
  version: number
  records: BayLedgerRecord[]
  /** Per bay, and outliving the disc — see `BayTrayRecord`. */
  trayCommands: BayTrayRecord[]
  /**
   * A ledger of this version was actually read back.
   *
   * The difference between "rip-deck remembers nothing was
   * finished" and "rip-deck remembers nothing at all", which is
   * the whole of the fail-closed rule above. NOT persisted — it
   * is a fact about the read, not about the bays.
   */
  hasPriorState: boolean
}

/** No memory at all: no file, or one we could not read. */
export const EMPTY_BAY_LEDGER: BayLedger = {
  version: BAY_LEDGER_VERSION,
  records: [],
  trayCommands: [],
  hasPriorState: false,
}

export const bayLedgerPath = (stateDir: string): string =>
  join(stateDir, BAY_LEDGER_FILENAME)

/**
 * Which bays are worth persisting.
 *
 * Only the latched ones. An `idle` bay is the default state and
 * writing it down would say nothing; a `starting`/`ripping` bay
 * is mid-flight and its disc is not finished with, so recording
 * it would be a claim that survives the crash that interrupted
 * it — exactly the wrong thing to remember.
 *
 * ⚠️ That rule is why the tray memory is a SEPARATE section and
 * not a field here. A tray command can target a bay in any
 * phase, and most of the ones it targets are `idle` — so folding
 * it in would have meant either dropping the field for exactly
 * the bays the ⏏ toggle asks about, or persisting an idle bay's
 * whole disc-shaped record to carry one string. `toTrayRecords`
 * below writes that one string on its own; nothing about a
 * mid-flight rip reaches the disk either way.
 */
export const toLedgerRecords = (
  bays: BayState[],
): BayLedgerRecord[] =>
  bays.flatMap((bay) =>
    (bay.phase === "done" || bay.phase === "quarantined") &&
    bay.outcome !== null
      ? [
          {
            driveId: bay.driveId,
            phase: bay.phase,
            sizeSectors: bay.sizeSectors,
            discName: bay.discName,
            discType: bay.discType,
            destinationPath: bay.destinationPath,
            jobUuid: bay.jobUuid,
            outcome: bay.outcome,
            updatedAtMs: bay.updatedAtMs,
          },
        ]
      : [],
  )

/**
 * Every bay rip-deck has moved the tray of, in any phase.
 *
 * Phase-blind on purpose, and that is the decision this unit
 * made: what is being written down is one act by rip-deck upon a
 * drawer, already finished by the time it is recorded. It is not
 * a claim about a rip, so none of `toLedgerRecords`'s reasons to
 * withhold apply to it — a `ripping` bay that was opened before
 * its disc went in has a true, complete tray fact and no
 * complete rip.
 *
 * A bay rip-deck has never moved is absent, not `null`: the
 * absence is the honest reading ("I have done nothing to this
 * drawer"), and it is the reading `nextTrayCommandFor` already
 * degrades to `open_bay` on.
 */
export const toTrayRecords = (
  bays: BayState[],
): BayTrayRecord[] =>
  bays.flatMap((bay) =>
    bay.lastTrayCommand === null
      ? []
      : [
          {
            driveId: bay.driveId,
            lastTrayCommand: bay.lastTrayCommand,
            updatedAtMs: bay.updatedAtMs,
          },
        ],
  )

/**
 * Cheap "has anything worth writing changed".
 *
 * Not the JSON itself: `updatedAtMs` moves on every tick for a
 * held bay, so comparing serialised ledgers would rewrite the
 * file every five seconds forever.
 *
 * `discName` and `destinationPath` are IN it. They are not
 * decoration on a record keyed by the outcome — they are the two
 * fields a card renders, so a bay whose name or destination
 * changed while its phase and outcome kind did not (a re-rip
 * that landed beside a collision, a disc re-read under a name
 * `--name` corrected) must still reach the disk. Leaving them
 * out would persist the FIRST name a bay ever had and quietly
 * keep it forever.
 *
 * The tray commands are in it for a sharper version of the same
 * reason: a bay whose tray was opened has changed nothing else
 * at all — same phase, same outcome, usually no disc record —
 * so a fingerprint over the records alone would never notice,
 * and the ⏏ toggle would come back from a restart pointing the
 * wrong way. `updatedAtMs` stays out of both halves: it moves on
 * every tick for a held bay, so including it would rewrite the
 * file every five seconds forever.
 */
export const ledgerFingerprint = (input: {
  records: BayLedgerRecord[]
  trayCommands: BayTrayRecord[]
}): string =>
  [
    input.records
      .map((record) =>
        [
          record.driveId,
          record.phase,
          String(record.sizeSectors),
          String(record.discName),
          String(record.discType),
          String(record.destinationPath),
          String(record.jobUuid),
          record.outcome.kind,
        ].join(":"),
      )
      .sort()
      .join("|"),
    input.trayCommands
      .map((record) =>
        [record.driveId, record.lastTrayCommand].join(":"),
      )
      .sort()
      .join("|"),
  ].join("~")

/**
 * A string field that may legitimately be absent, as null.
 *
 * The tolerant half of the reader, and it is scoped to the
 * fields added to v2 AFTER `discName`/`destinationPath` shipped
 * in it. Those two are strict below, on the argument that a v2
 * file is written by `toLedgerRecords` and therefore always has
 * them — but that argument is only true of a writer that knows
 * about the field, and v2 is undeployed, so several v2 writers
 * exist across this stage's own branches. A file written by an
 * earlier one is a genuine v2 file that is simply missing
 * `discType` and `jobUuid`; dropping it would hold that bay's
 * disc for no reason at all. Absent reads as "nobody recorded
 * this", which is exactly what null already means here.
 */
const optionalStringField = (
  value: unknown,
): string | null =>
  typeof value === "string" && value !== "" ? value : null

const isLedgerRecord = (
  value: unknown,
): value is Partial<BayLedgerRecord> & {
  driveId: string
  phase: "done" | "quarantined"
  outcome: BayOutcome
} => {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Partial<BayLedgerRecord>

  return (
    typeof record.driveId === "string" &&
    (record.phase === "done" ||
      record.phase === "quarantined") &&
    (record.sizeSectors === null ||
      typeof record.sizeSectors === "number") &&
    // Required, not optional-with-a-default. A v2 file is
    // written by `toLedgerRecords`, which always emits both, so
    // a record missing one was hand-edited — and the safe
    // reading of a hand-edited record is to drop it, which holds
    // that bay's disc rather than trusting half of it.
    (record.discName === null ||
      typeof record.discName === "string") &&
    (record.destinationPath === null ||
      typeof record.destinationPath === "string") &&
    typeof record.outcome === "object" &&
    record.outcome !== null &&
    typeof record.outcome.kind === "string"
  )
}

const DISC_TYPES: readonly DiscType[] = [
  "none",
  "cd",
  "dvd",
  "bluray",
  "uhd",
  "unknown",
]

const isDiscType = (value: unknown): value is DiscType =>
  typeof value === "string" &&
  (DISC_TYPES as readonly string[]).includes(value)

/**
 * Read one record, filling the later-v2 fields with null.
 *
 * Normalising HERE rather than at every reader is what keeps
 * `BayLedgerRecord` a plain non-optional type: `adoptBayAtStartup`
 * reads `record.jobUuid` and gets null, never `undefined`, so
 * there is no third state for a caller to mishandle.
 */
const readLedgerRecord = (
  value: unknown,
): BayLedgerRecord[] => {
  if (!isLedgerRecord(value)) return []

  return [
    {
      driveId: value.driveId,
      phase: value.phase,
      sizeSectors: value.sizeSectors ?? null,
      discName: value.discName ?? null,
      discType: isDiscType(value.discType)
        ? value.discType
        : null,
      destinationPath: value.destinationPath ?? null,
      jobUuid: optionalStringField(value.jobUuid),
      outcome: value.outcome,
      updatedAtMs:
        typeof value.updatedAtMs === "number"
          ? value.updatedAtMs
          : 0,
    },
  ]
}

/**
 * Read one bay's tray memory, or nothing.
 *
 * Anything but the two commands rip-deck can actually send is
 * dropped rather than coerced: the cost of dropping it is one
 * press of a button that opens a tray, and the cost of trusting
 * a value nobody wrote is a toggle that means the opposite of
 * what it says.
 */
const readTrayRecord = (
  value: unknown,
): BayTrayRecord[] => {
  if (typeof value !== "object" || value === null) return []

  const record = value as Partial<BayTrayRecord>

  if (typeof record.driveId !== "string") return []

  if (
    record.lastTrayCommand !== "open_bay" &&
    record.lastTrayCommand !== "close_bay"
  ) {
    return []
  }

  return [
    {
      driveId: record.driveId,
      lastTrayCommand: record.lastTrayCommand,
      updatedAtMs:
        typeof record.updatedAtMs === "number"
          ? record.updatedAtMs
          : 0,
    },
  ]
}

/**
 * Parse the ledger, and never throw.
 *
 * A truncated or hand-edited file must cost the memory of what
 * was finished, never the daemon — and the consequence of
 * returning an empty ledger is the fail-closed path above, not a
 * re-rip.
 */
export const parseBayLedger = (raw: string): BayLedger => {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_BAY_LEDGER
  }

  if (typeof parsed !== "object" || parsed === null) {
    return EMPTY_BAY_LEDGER
  }

  const candidate = parsed as Partial<BayLedger>

  if (candidate.version !== BAY_LEDGER_VERSION) {
    return EMPTY_BAY_LEDGER
  }

  return {
    version: BAY_LEDGER_VERSION,
    records: Array.isArray(candidate.records)
      ? candidate.records.flatMap(readLedgerRecord)
      : [],
    // Absent for a v2 file written before this section existed,
    // which is not an error and not a reason to distrust the
    // records beside it: no tray memory reads as "rip-deck has
    // moved nothing", and the toggle degrades to `open_bay`.
    trayCommands: Array.isArray(candidate.trayCommands)
      ? candidate.trayCommands.flatMap(readTrayRecord)
      : [],
    hasPriorState: true,
  }
}

export const readBayLedger = async (input: {
  path: string
}): Promise<BayLedger> => {
  try {
    return parseBayLedger(
      await readFile(input.path, "utf8"),
    )
  } catch {
    // No file yet is the normal first-run state, not an error.
    return EMPTY_BAY_LEDGER
  }
}

/**
 * Write the ledger, atomically.
 *
 * Temp file + `rename`, because the file is read exactly once —
 * at startup, to decide whether nine loaded discs get ripped
 * again — and a half-written one read there is the worst
 * possible input. `rename` within a directory is atomic, so a
 * reader sees the old ledger or the new one and never a prefix.
 */
export const writeBayLedger = async (input: {
  path: string
  ledger: BayLedger
}): Promise<void> => {
  await mkdir(dirname(input.path), { recursive: true })

  const tempPath = `${input.path}.tmp`

  await writeFile(
    tempPath,
    `${JSON.stringify(
      {
        version: input.ledger.version,
        records: input.ledger.records,
        trayCommands: input.ledger.trayCommands,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  await rename(tempPath, input.path)
}

/**
 * Said out loud, so a held disc never reads as a broken one.
 *
 * The disc is fine, the drive is fine; rip-deck simply has no way
 * to know whether the rip already happened, and says so.
 *
 * ⚠️ The instruction used to be *"take the disc out, or open the
 * tray and close it again."* **The second half was wrong on this
 * hardware and had been for as long as it had been printed**: the
 * Tower drives keep reporting their disc after the tray opens,
 * so the bay never reads empty, `rearmEmptyObservations` never
 * fires, and a tray cycle un-holds nothing
 * ([decision](docs/decisions/2026-07-27-tray-memory-beats-disc-presence.md);
 * verified live 2026-07-30). It now names the Rip button, which
 * works from where the operator is already standing
 * ([decision](docs/decisions/2026-07-30-a-held-bay-is-ripped-from-the-dashboard.md)).
 */
export const UNKNOWN_AT_STARTUP_DETAIL =
  "There was already a disc in this drive when Rip-Deck " +
  "started, and Rip-Deck has no bay memory at all yet — so it " +
  "cannot tell a fresh disc from one the last daemon already " +
  "ripped. Refusing to rip it again on a guess: a duplicate " +
  "90 GB backup costs hours and this costs a button press. " +
  "Press Rip to rip it anyway, or take the disc out if it is " +
  "already backed up. Happens once per state directory."

/**
 * The bay state to start from, the first time a bay is seen.
 *
 * Pure, and the whole restart story is in these four branches.
 * Read it as the safety argument: the only paths that leave a
 * bay armed with a disc in it are the one where nothing is in
 * the drive, and the one where rip-deck has memory and this disc
 * is not in it.
 */
export const adoptBayAtStartup = (input: {
  driveId: string
  /** The bay's last latched result, if we have one. */
  record: BayLedgerRecord | undefined
  /**
   * The last tray this bay's drawer was told to do, if any.
   *
   * On `idle` too, and that is the point — it rides the base
   * state below rather than the matched branch, because the bay
   * the ⏏ toggle asks about is usually the EMPTY one whose disc
   * the operator has already taken out. A tray memory restored
   * only onto held discs would answer only the bays that need no
   * answer.
   */
  trayRecord: BayTrayRecord | undefined
  /** A valid ledger was read — see `BayLedger.hasPriorState`. */
  hasPriorState: boolean
  observation: BayObservation
  atMs: number
}): BayState => {
  const idle: BayState = {
    driveId: input.driveId,
    phase: "idle",
    sizeSectors: null,
    discName: null,
    discType: null,
    destinationPath: null,
    outcome: null,
    isAdopted: false,
    latchedAtMs: null,
    jobUuid: null,
    lastTrayCommand:
      input.trayRecord?.lastTrayCommand ?? null,
    startCount: 0,
    emptyObservationCount: 0,
    // An adopted bay has NOT confirmed its tray empty — a loaded
    // disc is exactly the ambiguity adoption exists to resolve, and
    // the re-adopt path in `watcher.tickNow` relies on this staying
    // false until a settle is observed.
    hasSettledEmpty: false,
    // Overridden by the matched branches below when there is a
    // finished disc to remember; an armed bay has finished nothing.
    lastFinished: null,
    updatedAtMs: input.atMs,
  }

  // Nothing loaded (or nothing visible): the bay is armed and
  // behaves exactly as it always has. This is the common case —
  // a restart on an empty or powered-off tower.
  if (
    !input.observation.isDrivePresent ||
    !input.observation.hasMedia
  ) {
    return idle
  }

  // The disc we last finished with is still sitting there. THE
  // RULE holds it from here, and — the reason this ledger
  // exists — the eject command can see that it is completed.
  if (
    input.record !== undefined &&
    input.record.sizeSectors ===
      input.observation.sizeSectors
  ) {
    return {
      ...idle,
      phase: input.record.phase,
      sizeSectors: input.record.sizeSectors,
      // Restored, so the card the owner sees after a restart
      // names the disc and the folder it landed in. This is the
      // only route those two facts have across a restart: the
      // rip that learned them belongs to the previous daemon,
      // and re-reading them would mean a `makemkvcon` call
      // against every loaded bay at boot — the bus-scan
      // contention the isolation decision exists to prevent.
      discName: input.record.discName,
      // The type the previous daemon read off this disc. Not
      // re-derivable here — `decideDiscType` needs udev and a
      // settled drive — and it is what routes the poster lookup
      // at a music provider instead of a film one.
      discType: input.record.discType,
      destinationPath: input.record.destinationPath,
      // The capture id of the rip that produced this outcome,
      // so the held disc's card keeps its log button across the
      // restart. `armView` mints nothing from a placeholder.
      jobUuid: input.record.jobUuid,
      outcome: input.record.outcome,
      // Ripped by the daemon that ran before this one. The API
      // has no other way to know — this bay will emit one
      // "held on startup" note and nothing else ever again.
      isAdopted: true,
      // The instant the PREVIOUS daemon finished with it, which
      // the ledger has kept. `updatedAtMs` cannot stand in: the
      // first hold decision of this very tick overwrites it.
      latchedAtMs: input.record.updatedAtMs,
      // The bay's own copy of the record it was adopted from, so a
      // tower power-cycle that re-arms this bay before the disc
      // reads still recognises it coming back — the in-memory
      // ledger this was read from is a frozen startup snapshot.
      lastFinished: input.record,
    }
  }

  // Memory exists and this disc is not in it, so it is a disc
  // rip-deck has genuinely never finished. Arm the bay and let
  // `decideBayAction` start it — this is the "load the tower,
  // then start rip-deck" case, and the owner's decision says it
  // rips.
  if (input.hasPriorState) return idle

  // No memory at all, and a disc already in the drive. The one
  // genuinely ambiguous case: fail closed on ambiguity is
  // already this codebase's rule, and the ambiguity here is
  // "was this ripped by the daemon that was running an hour
  // ago".
  const outcome: BayOutcome = {
    kind: "needs_attention",
    detail: UNKNOWN_AT_STARTUP_DETAIL,
  }
  return {
    ...idle,
    phase: "done",
    sizeSectors: input.observation.sizeSectors,
    outcome,
    isAdopted: true,
    // Latched now, because rip-deck has no memory that could say
    // when this disc was actually finished with.
    latchedAtMs: input.atMs,
    // Remember this held-on-ambiguity disc, so a power-cycle that
    // re-arms the bay before it reads re-holds it rather than
    // resolving the same ambiguity the other way and ripping.
    lastFinished: {
      driveId: input.driveId,
      phase: "done",
      sizeSectors: input.observation.sizeSectors,
      discName: null,
      discType: null,
      destinationPath: null,
      jobUuid: null,
      outcome,
      updatedAtMs: input.atMs,
    },
  }
}

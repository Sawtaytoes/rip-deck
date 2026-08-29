import {
  createSupervisionState,
  type DiscIdentity,
  type DiscType,
  EMPTY_PROGRESS,
  type Job,
  type JobProgress,
  type JobState,
  makeVerdict,
  type Verdict,
} from "@rip-deck/contracts"
import {
  hedged,
  isHealthVerdictPublished,
} from "../health/publish.ts"
import {
  type ComputedVerdictStore,
  createComputedVerdictStore,
} from "../health/verdictStore.ts"
import { parseDiscLabel } from "../metadata/discQuery.ts"
import {
  createPosterStoreFromEnv,
  type PosterStore,
} from "../metadata/posterStore.ts"
import {
  STABLE_USB,
  type UsbStability,
} from "../rip/usbStability.ts"
import type {
  BayOutcome,
  BayPhase,
  BaySighting,
  BayState,
  WatcherHandlers,
} from "../rip/watcher.ts"
import { readStateDir } from "./logCapture.ts"
import {
  createBaySnapshot,
  type TowerStore,
} from "./snapshot.ts"

/**
 * The seam between the watcher and `GET /json`.
 *
 * `createApiServer` and `createTowerStore` were both built and
 * tested in Stage 4 and then called by nobody, so the endpoint
 * the ARM viewer is supposed to point at had never been served
 * once. This module is the missing half: it turns the watcher's
 * console-shaped events into the store writes the API reads.
 *
 * ## Why this is a module and not ten lines in `main.ts`
 *
 * `main.ts` says of itself that it is "the console and the
 * process wiring, and nothing else", and that every decision
 * lives somewhere testable without a drive. Feeding the store is
 * not console formatting — it is a per-bay state machine with a
 * record lifecycle, a job-state mapping and a deliberate refusal
 * to invent a verdict. Inlined, all of that would be untestable
 * except by starting a nine-bay daemon; here it is a pure-ish
 * fold over four callbacks and the tests need no hardware, no
 * socket and no timer.
 *
 * It WRAPS the caller's handlers rather than replacing them: the
 * store is updated first and the console handler is called
 * second, so a console formatter that throws cannot cost the
 * dashboard its update. (The watcher already isolates a throwing
 * handler to one bay; this orders the two effects.)
 *
 * ## The watcher's own tables are the truth; the events are not
 *
 * `WatcherHandlers` was written for a log: `driveId`, `slot`,
 * `name`, a `JobProgress` and a `BayOutcome` whose payload is one
 * English sentence. There is no `Job`, no identity, no read-error
 * count and no `createJob` helper anywhere in the repo, so the
 * `Job` this module hands the API is SYNTHESISED. Everything
 * synthesised is marked at its field, and the rule was: when the
 * honest answer is "we do not know", say so in the model rather
 * than pick a plausible value.
 *
 * What that rule missed, and what 0.4.0 shipped: **an event
 * stream is not a state of the tower.** Three real defects, all
 * one mistake:
 *
 *  - A bay ADOPTED at startup — a disc held from the last
 *    daemon, `phase: "done"` with a real outcome — never fires
 *    `onBayOutcome` at all, deliberately, because an outcome
 *    publishes `rip/event` and would announce three rips that
 *    did not just happen. Reading only the event stream rendered
 *    all three held Troy discs as `state: "idle", verdict:
 *    "ok"`, which is the opposite of the truth.
 *  - Six of nine bays were quietly idle and so emitted nothing,
 *    and the rack rendered three bays.
 *  - No handler carries `/dev/srN`, a vendor, a model or a
 *    serial, so every drive in `/json` had `name: null` and
 *    `mount: null`.
 *
 * So `publish` reads `BayState` and `BaySighting` — the
 * watcher's own tables, both memory reads — as AUTHORITATIVE for
 * phase, outcome, disc size, presence and hardware identity, and
 * falls back to the handler-derived record only where those have
 * nothing to say (which is exactly the no-watcher-attached
 * case, plus the instant an outcome event overtakes its own bay
 * table in a test).
 *
 * Two fields are still honestly unknown, and say so:
 *
 *  1. **`verdict` is the engine's answer once the corpus has
 *     earned it, and `unknown` until then.** The engine runs on
 *     every rip and writes what it computed to
 *     `<uuid>.verdict.json`. Whether that answer may be SHOWN is
 *     `health/publish.ts`, which counts the feature vectors in
 *     the state directory and opens itself at ~30 with at least
 *     one bad job among them. Below that the bay carries
 *     `unknown`, whose template says "Not enough information to
 *     judge this rip yet" — exactly true of a verdict computed
 *     from guessed thresholds. Above it the real verdict is read
 *     back through `health/verdictStore.ts` and passed through
 *     `hedged`, so it can be read and can never announce.
 *     `docs/mqtt.md` settles the identical question the same way
 *     for the mid-rip alert: timing says the rip stopped moving
 *     and not why, "so the verdict kind stays `unknown`".
 *  2. **`readErrorCount` is 0 because the count never reaches
 *     us**, not because zero errors were seen. `armView` warns
 *     "never render this as healthy"; the paired `unknown`
 *     verdict is what stops that zero reading as a clean bill of
 *     health.
 *
 * ## The disc name and the destination are FIELDS now
 *
 * This header used to argue that identity and `destinationPath`
 * had to stay `null` here, because both existed only inside the
 * outcome's English sentence and scraping a log line for
 * structured data is how the `MSG:5072` parser bug happened.
 * The refusal to scrape was right; the conclusion was not. The
 * dashboard was left showing three held Troy discs labelled with
 * their BAY names, and the destination rendered as health
 * evidence — a path in the "why we think this" list.
 *
 * The fix was one level down, not here: `BayState` carries
 * `discName` and `destinationPath`, written from
 * `identifyDisc`'s existing read and the ripper's own publish
 * step, and persisted by the bay ledger (v2) so a disc adopted
 * across a restart still has both. So this module now passes
 * them STRUCTURALLY — nothing is parsed, and where the watcher
 * has no answer the field is still `null` rather than a guess.
 *
 * The outcome sentence still travels as verdict evidence, where
 * it is read as prose. That is where it belongs; it was never a
 * data source.
 *
 * ## The poster is fetched from here, and read from a Map
 *
 * B1 — *"auto-identify title + year and fetch a poster"* — is
 * the owner's single favourite ARM feature, and item 3 on his
 * ranked card list, above the drive controls and the progress
 * bar. The render path already existed end to end
 * (`Job.posterUrl` -> `armView`'s `rip.poster` -> `RipCard`);
 * only the fetcher was missing.
 *
 * It hangs off `publish` rather than off the watcher for one
 * reason: `publish` already runs exactly where the lookup has
 * to be kicked off from — on the watcher's own poll and on its
 * bay events, never on the `/json` request path — and it
 * already has the disc name in `BayFacts`. So every publish
 * says *"make sure this label has been looked up"*
 * (`PosterStore.request`, which returns immediately and starts
 * at most one lookup per label ever) and reads the answer with
 * a synchronous `Map` read. A lookup still in flight means
 * `posterUrl: null` this poll and a poster on the next one.
 *
 * `metadata/posterStore.ts` holds every bound that makes that
 * safe to call from a five-second loop. With no
 * `RIP_DECK_OMDB_API_KEY` the store is a null object: no
 * request, no file, no log line, and a card with no thumbnail.
 */

/** One bay's current run, as the handler stream describes it. */
type BayRecord = {
  driveId: string
  /** House name if a handler has told us one; else the id. */
  label: string
  slot: number | null
  /**
   * The watcher's own `jobUuid` when it could be read, so
   * `job_uuid` in `/json` names the real
   * `$RIP_DECK_STATE_DIR/<uuid>.robot.log`.
   */
  jobId: string
  /** Null until this bay has done something. */
  startedAtMs: number | null
  finishedAtMs: number | null
  progress: JobProgress
  outcome: BayOutcome | null
  /** A ripper child has emitted at least one progress line. */
  hasSeenProgress: boolean
}

export type TowerFeed = {
  /** Pass these to `startWatcher`. */
  handlers: WatcherHandlers
  /**
   * Late-bound on purpose: the watcher does not exist until it
   * has been handed the handlers above, so it cannot be a
   * constructor argument.
   *
   * Worth the small awkwardness because these two tables are the
   * only place most of a bay is described — the real `jobUuid`,
   * the phase and outcome a held disc has and no event carries,
   * and every hardware fact the dashboard shows. They are also
   * the only way a bay that has never emitted an event (eight
   * quiet drives, the normal state of a loaded tower) reaches
   * the dashboard at all.
   *
   * Both are memory reads of at most nine entries and neither is
   * ever called on the request path — they are read on the
   * watcher's own poll, from `onTickComplete`.
   */
  attachWatcher: (input: {
    getBays: () => BayState[]
    /**
     * Optional because a feed with no hardware facts is a real
     * state with real tests (an unattached feed, and every
     * handler-only test below), not because it is optional in
     * production — `main.ts` passes it.
     */
    getSightings?: () => BaySighting[]
    /**
     * Whether the USB bus is flapping. Optional for the same
     * reason as `getSightings` — an unattached feed is a real,
     * tested state — but `main.ts` passes it. Absent reads as a
     * steady bus, never as a fault.
     */
    getUsbStability?: () => UsbStability
  }) => void
}

/**
 * Which `JobState` a bay is in.
 *
 * Exported for its tests: this mapping is the one piece of the
 * feed that can quietly overstate what is happening, and the
 * dashboard's whole top line is derived from it.
 *
 * `BayPhase` and `JobState` do not line up, and the gaps are
 * resolved DOWNWARDS every time:
 *
 *  - `starting` covers settle, type and identify in one phase.
 *    It becomes `settling` — the earliest of the three, and so
 *    the one that cannot claim a step the bay has not reached.
 *  - `quarantined` becomes `needs_attention`, which is the
 *    JobState that means "a human has to do something" and is
 *    what quarantine is.
 *  - `done` with nothing remembered, and `idle`, are not jobs at
 *    all, so they get none. A card is better absent than
 *    invented.
 */
/**
 * Has this bay been re-armed by its disc leaving?
 *
 * `phase: "idle"` with no size is the watcher saying two things
 * at once: the tray read empty for `rearmEmptyObservations`
 * consecutive polls, and nothing is claiming the drive. A bay
 * still HOLDING a finished disc is `phase: "done"`, and a drive
 * that has dropped off the bus never reaches either — the poll
 * loop holds a missing drive rather than deciding about it, so a
 * powered-off tower keeps its cards.
 *
 * Exported for its tests, and named rather than inlined because
 * it is the one condition that says a `BayRecord` has outlived
 * the thing it describes.
 *
 * ## Why the record needs this at all
 *
 * `liveRecordOf` keeps a record alive past its outcome on
 * purpose: *"a record outlives its outcome so the finished card
 * stays on the dashboard; the next event from that bay is a new
 * disc and therefore a new run"*. That is correct while the disc
 * is in the tray. It has no stopping condition when the disc is
 * simply TAKEN OUT — no next event ever comes, because an empty
 * bay is quiet, so the finished card stays forever.
 *
 * Measured on the tower 2026-08-27, with all nine trays empty:
 * the `size` attribute under `/sys/block` read the 2097151-sector empty sentinel on
 * every drive and `/json` agreed (`has_disc: false`,
 * `disc_size_sectors: null`) — while slots 1-4 still published
 * `needs_attention` and slots 8-9 still published `completed`,
 * each with its job id, its progress and, on slot 8, a health
 * ALERT about a disc that was no longer in the building.
 *
 * The bays that cleared correctly are the tell: slots 5-7 read
 * `idle`, and those are exactly the bays whose last outcome came
 * from startup ADOPTION, which emits a note and deliberately
 * never an outcome. No outcome event, no record to go stale.
 */
export const hasBayReArmed = (bay: BayState): boolean =>
  bay.phase === "idle" && bay.sizeSectors === null

export const toJobState = (input: {
  phase: BayPhase | null
  outcome: BayOutcome | null
  hasSeenProgress: boolean
}): JobState | null => {
  const { outcome } = input

  if (outcome !== null) {
    switch (outcome.kind) {
      case "completed":
      // A warning is not a state. The disc IS backed up, so the
      // job is `completed` and the warning rides beside it —
      // mapping it to `needs_attention` would put a finished
      // backup in the queue of bays wanting a human, which is
      // the opposite of what the owner asked for.
      case "completed_with_warnings":
        return "completed"
      case "failed":
        return "failed"
      case "needs_attention":
        return "needs_attention"
      case "no_media":
        // The disc left before anything could be done with it,
        // and the watcher re-arms the bay rather than latching
        // it. There was never a job to show.
        return null
    }
  }

  switch (input.phase) {
    case "ripping":
      return "ripping"
    case "starting":
      return "settling"
    case "quarantined":
      return "needs_attention"
    case "idle":
    case "done":
      return null
    // No watcher attached, so the phase is unreadable and the
    // events are all we have. Progress means a ripper child is
    // writing; anything earlier is the pre-rip sequence.
    case null:
      return input.hasSeenProgress ? "ripping" : "settling"
  }
}

/**
 * One bay, as the watcher's own bay table describes it.
 *
 * Assembled rather than passed straight through because the
 * table can be absent — an unattached feed — and because a bay
 * whose outcome event has arrived before its table entry was
 * updated must not lose the outcome. Where the table has an
 * answer it WINS; the record fills only the holes.
 */
type BayFacts = {
  phase: BayPhase | null
  outcome: BayOutcome | null
  /** The disc sitting in the tray, in 512-byte sectors. */
  sizeSectors: number | null
  /** The disc's own name, or null when nothing read one. */
  discName: string | null
  /** What it turned out to be, or null when nothing typed it. */
  discType: DiscType | null
  /** Where the rip landed, or null when none has. */
  destinationPath: string | null
  /** This disc was finished with by an earlier daemon. */
  isAdopted: boolean
  /** When the outcome was latched. Null when there is none. */
  latchedAtMs: number | null
  /** The operator said this disc has been taken out. */
  isLoadedDismissed: boolean
}

const readBayFacts = (input: {
  bay: BayState | null
  record: BayRecord
}): BayFacts => {
  const { bay, record } = input

  if (bay === null) {
    return {
      phase: null,
      outcome: record.outcome,
      sizeSectors: null,
      // No watcher, so no bay table — and the handler stream
      // carries none of these. Null is the honest answer, and
      // the outcome sentence is NOT a fallback source for them.
      discName: null,
      discType: null,
      destinationPath: null,
      // With no watcher there is no bay table, and adoption is
      // something only the bay table can know.
      isAdopted: false,
      latchedAtMs: null,
      isLoadedDismissed: false,
    }
  }

  return {
    phase: bay.phase,
    // `??` and not `bay.outcome` alone: `applyBayOutcome`
    // re-arms the bay on `no_media` — clearing the outcome it
    // was just handed — and the handler fires straight after, so
    // the record is the only reader that still knows the disc
    // left.
    outcome: bay.outcome ?? record.outcome,
    sizeSectors: bay.sizeSectors,
    discName: bay.discName,
    discType: bay.discType,
    destinationPath: bay.destinationPath,
    isAdopted: bay.isAdopted,
    latchedAtMs: bay.latchedAtMs,
    isLoadedDismissed: bay.isLoadedDismissed,
  }
}

/**
 * When a latched bay's disc was finished with, or null.
 *
 * Only ever answered for a bay that HAS finished: a rip still
 * running has no latch, and `finishedAt` on a running job must
 * stay null or the card reads as done.
 */
const finishedAtOf = (facts: BayFacts): number | null =>
  facts.phase === "done" || facts.phase === "quarantined"
    ? facts.latchedAtMs
    : null

/**
 * The verdict this bay's card carries.
 *
 * ## The paragraph that used to be here
 *
 * Every card's evidence list opened with a four-sentence note
 * explaining that the health engine's answer was computed but
 * not published, and that tuning needed "about 30 real rips of
 * data (there are 3)". Three things were wrong with it. It was a
 * statement about rip-deck's own build state printed on a
 * household appliance's status card; it repeated verbatim on all
 * nine bays; and the count was typed by hand, so it was wrong
 * from the first rip after it was written. The gate counts the
 * corpus itself now, so there is nothing left for a sentence to
 * get stale about.
 *
 * ## What replaces it
 *
 * With the gate SHUT the bay carries `unknown` — no engine
 * answer may be shown, and `unknown`'s template says so in one
 * line. With the gate OPEN it carries whatever the engine
 * actually decided for this job, read back from
 * `<uuid>.verdict.json`, or `unknown` again when there is no
 * such file (a rip still running, an adopted disc from before
 * capture existed, a write that failed).
 *
 * The outcome sentence rides in the evidence list either way.
 * That sentence is the one thing on this card that names what
 * actually happened — "empty_output … partial output KEPT at
 * …" — and it belongs to the RIP, not to the health engine, so
 * it survives both sides of the gate.
 *
 * `hedged` on the published verdict is not a formality: the gate
 * opens on file counts, so the thresholds behind that verdict
 * are still guesses at the instant it opens. Forcing
 * `suspected` is what keeps it off MQTT.
 */
const buildVerdict = (input: {
  facts: BayFacts
  computed: Verdict | null
}): Verdict => {
  const { computed, facts } = input

  const evidence =
    facts.outcome === null ? [] : [facts.outcome.detail]

  if (computed === null || !isHealthVerdictPublished()) {
    return makeVerdict(
      "unknown",
      // NEVER `confirmed`: only a confirmed verdict may announce
      // over MQTT, and an announcement carrying a verdict
      // nothing computed is the confidently-wrong alert the
      // whole health model exists to prevent.
      "suspected",
      evidence,
    )
  }

  return hedged({
    ...computed,
    // The engine's own evidence first — it is the reasoning —
    // then what the rip itself did. Never the other way round:
    // the card shows the verdict's reasons under its message.
    evidence: [...computed.evidence, ...evidence],
  })
}

/**
 * The disc, as much of it as the watcher actually knows.
 *
 * Null when nothing read a name, and never a fabricated one: a
 * card with no title says so, and the bay label is the honest
 * fallback the UI already applies.
 *
 * ## Why the matched title does NOT become the title
 *
 * OMDb answering `Troy` for `TROY - BONUS DISC` is a correct
 * match and would still be the wrong headline: three Troy discs
 * sat in slots 7-9 of the real tower, and rewriting all three
 * cards to "Troy" would take away the only thing that told them
 * apart. The disc's own name stays the `title` and the raw
 * label stays the `volumeLabel`; the lookup contributes what
 * the disc cannot say about itself — the poster, the year and,
 * from the label's own numbering, which disc of the set this
 * is. `source` names the provider that answered, because that
 * is what makes a poster on the card auditable.
 *
 * `discType` is a real answer now, and is still never guessed.
 * The bay table records what `decideDiscType` typed the disc as
 * — the same decision that chose the ripper — and the ledger
 * keeps it across a restart, so it is passed through. A bay that
 * has not been typed stays `"unknown"`, which is the word for
 * "nothing classified this", not a default.
 *
 * ⚠️ **This unblocks the audio-CD poster route; it does not
 * build it.** `createPosterStoreFromEnv` still asks OMDb about
 * everything, and asking a film database about an album is how
 * a CD ends up wearing a film's poster. Routing `cd` at
 * MusicBrainz is a later unit — what was missing until now was
 * the fact to route ON.
 */
const buildIdentity = (input: {
  facts: BayFacts
  poster: PosterStore
}): DiscIdentity | null => {
  const { discName } = input.facts

  if (discName === null) return null

  const match = input.poster.get({ discName })
  const parsed = parseDiscLabel(discName)

  return {
    title: discName,
    // The matched year, or the label's own when it carried one
    // and nothing matched. Both are facts about this disc; a
    // year is never invented from the folder or the file dates.
    year: match?.year ?? parsed.year,
    // Off the bay table, where `onIdentified` recorded what
    // `decideDiscType` decided. `"unknown"` only when nothing
    // typed this disc — an adopted bay from a ledger written
    // before the field existed, or a bay named by a handler
    // with no watcher attached.
    discType: input.facts.discType ?? "unknown",
    // Read off the media by `identifyDisc`, which is what
    // `"disc"` means and why the union gained it. Not `manual`
    // (nobody typed it) and not `tmdb` (that provider has no
    // key in this house and never ran) — and `"omdb"` only
    // once OMDb has actually answered about this disc.
    source: match === null ? "disc" : match.provider,
    posterUrl: match?.posterUrl ?? null,
    // The volume label IS the name we have.
    volumeLabel: discName,
    // From the label itself (`… D2`, `DISC 2 OF 3`), which is
    // the only place either number exists — no lookup knows
    // which disc of a set is in this tray.
    discNumber: parsed.discNumber,
    discTotal: parsed.discTotal,
  }
}

const buildJob = (input: {
  record: BayRecord
  facts: BayFacts
  poster: PosterStore
  verdicts: ComputedVerdictStore
}): Job | null => {
  const { record, facts } = input

  // A human standing at the tower is the authority on whether the disc is
  // still there. These drives can report media after it has been removed, so
  // a dismissed terminal job must not leave a red card that cannot be cleared.
  // The bay stays latched in the watcher: this is display-only and cannot
  // cause the old disc to re-rip.
  if (facts.isLoadedDismissed) return null

  // An adopted disc has no start time anywhere: this process
  // never started that rip. It does stamp one — the bay emits a
  // "held on startup" note like any other event — and that stamp
  // is the millisecond THIS daemon booted, which would move on
  // every restart and read as a rip that started just now. So an
  // adopted bay is dated from its latch instead: the instant the
  // previous daemon finished with the disc, carried in the
  // ledger. The ARM viewer needs a parseable timestamp to render
  // a card at all, so "no date" is not an option here.
  const startedAt = facts.isAdopted
    ? facts.latchedAtMs
    : (record.startedAtMs ?? facts.latchedAtMs)

  if (startedAt === null) return null

  const state = toJobState({
    phase: facts.phase,
    outcome: facts.outcome,
    hasSeenProgress: record.hasSeenProgress,
  })

  if (state === null) return null

  return {
    id: record.jobId,
    driveId: record.driveId,
    state,
    // When the daemon first heard from this bay, which is within
    // milliseconds of the dispatch — the first thing `runBayRip`
    // does is announce that it is waiting for the disc to settle.
    startedAt,
    // An adopted disc's rip ended when it was latched, and we
    // never saw it run — so start and finish are the same
    // instant rather than a duration nobody measured.
    finishedAt: record.finishedAtMs ?? finishedAtOf(facts),
    // Straight off the bay table, where `identifyDisc`'s read
    // was recorded and the ledger kept it across the restart,
    // plus whatever the poster lookup has already answered.
    identity: buildIdentity({
      facts,
      poster: input.poster,
    }),
    progress: record.progress,
    // A synchronous memory read. `publish` below is what asks
    // for the file, on the watcher's own poll.
    verdict: buildVerdict({
      facts,
      computed: input.verdicts.get({
        jobUuid: record.jobId,
      }),
    }),
    // `unknown` rather than null for a failure: null reads as
    // "nothing went wrong". The outcome's own sentence — which
    // names the real reason — travels as verdict evidence.
    failureReason:
      facts.outcome?.kind === "failed" ? "unknown" : null,
    // The third state, on the wire. Straight off the bay table,
    // where `runBayRip` put the sentences `buildRipWarnings`
    // wrote, and kept across a restart by the ledger.
    warnings: facts.outcome?.warnings ?? [],
    // A field on the bay, set by the ripper's publish step. Null
    // for anything that has not published — a held disc, a
    // failure, a rip still running.
    destinationPath: facts.destinationPath,
    // NOT a measured zero. See the header, point 2.
    readErrorCount: 0,
    // Straight off the bay table, where `adoptBayAtStartup`
    // recorded it. Not inferrable here: an adopted bay emits a
    // "held on startup" note that looks like any other event.
    isAdopted: facts.isAdopted,
    // There is no operator control path in `watch` yet — drive
    // commands are MQTT's (`cmd/drive`), and nothing consumes
    // them.
    isKeepTryingRequested: false,
  }
}

export const createTowerFeed = ({
  store,
  handlers = {},
  now = () => Date.now(),
  poster = createPosterStoreFromEnv(),
  stateDir = readStateDir(),
  verdicts = createComputedVerdictStore({ stateDir }),
}: {
  store: TowerStore
  /** The console handlers, wrapped rather than replaced. */
  handlers?: WatcherHandlers
  now?: () => number
  /**
   * Where disc thumbnails come from.
   *
   * Defaulted rather than injected by `main.ts` so the feature
   * needs no deploy-time wiring beyond the API key itself: with
   * `RIP_DECK_OMDB_API_KEY` unset this is the null store and
   * nothing changes. **Every test passes its own** — a test
   * must never reach the real OMDb API.
   */
  poster?: PosterStore
  /**
   * Where `<uuid>.verdict.json` lives.
   *
   * Defaulted from the environment like `api/server.ts` does,
   * and passed explicitly by `main.ts` from the watcher's own
   * `config.stateDir`, so the feed can never look somewhere the
   * verdicts are not.
   */
  stateDir?: string
  /**
   * The engine's saved answers.
   *
   * **Every test passes its own** — a test must never read the
   * real state directory, and one that did would pass or fail
   * on whatever the tower happened to have ripped.
   */
  verdicts?: ComputedVerdictStore
}): TowerFeed => {
  const records = new Map<string, BayRecord>()

  let readBays: (() => BayState[]) | null = null
  let readSightings: (() => BaySighting[]) | null = null
  let readUsbStability: (() => UsbStability) | null = null

  const bayStateOf = (driveId: string): BayState | null =>
    readBays?.().find((bay) => bay.driveId === driveId) ??
    null

  const sightingOf = (
    driveId: string,
  ): BaySighting | null =>
    readSightings?.().find(
      (sighting) => sighting.driveId === driveId,
    ) ?? null

  const createRecord = (input: {
    driveId: string
    label?: string
    slot?: number | null
  }): BayRecord => ({
    driveId: input.driveId,
    // Until a handler tells us the house name, the stable id is
    // the honest label — never `/dev/srN`, which reshuffles.
    label: input.label ?? input.driveId,
    slot: input.slot ?? null,
    jobId: "",
    startedAtMs: null,
    finishedAtMs: null,
    progress: EMPTY_PROGRESS,
    outcome: null,
    hasSeenProgress: false,
  })

  const publish = (record: BayRecord): void => {
    const bay = bayStateOf(record.driveId)

    const facts = readBayFacts({ bay, record })

    const sighting = sightingOf(record.driveId)

    // Off the request path and onto the poll: this is the one
    // place that both knows a disc's name and runs on the
    // watcher's own tick. Returns immediately, and does nothing
    // at all for a label already looked up.
    if (facts.discName !== null) {
      poster.request({ discName: facts.discName })
    }

    // Same rule, same tick: ask for the engine's saved answer
    // here rather than on the request path, and only once the
    // bay has an outcome — before that the file does not exist
    // yet, and asking for it every five seconds would be nine
    // misses a poll for the length of every rip.
    if (facts.outcome !== null) {
      verdicts.request({ jobUuid: record.jobId })
    }

    store.setBay({
      bay: createBaySnapshot({
        driveId: record.driveId,
        // The sighting's label comes from the registry on this
        // very poll; the record's comes from whatever event last
        // spoke, and is the drive id for a bay that never has.
        label: sighting?.label ?? record.label,
        slot: sighting?.slot ?? record.slot,
        devPath: sighting?.devPath ?? null,
        vendor: sighting?.vendor ?? null,
        model: sighting?.model ?? null,
        serial: sighting?.serial ?? null,
        // The real fact, from the last probe. Without a sighting
        // — no watcher attached — the honest fallback is the old
        // meaning, "the watcher has seen this bay".
        isPresent: sighting?.isDrivePresent ?? true,
        discSizeSectors: facts.sizeSectors,
        // The bay table itself, for the half of the payload that
        // describes the TRAY rather than the job — including the
        // tray command the ⏏ toggle reads. Null with no watcher
        // attached, which makes those fields absent rather than
        // a fabricated "nothing loaded".
        disc:
          bay === null
            ? null
            : {
                bay,
                isDrivePresent:
                  sighting?.isDrivePresent ?? true,
              },
        job: buildJob({ record, facts, poster, verdicts }),
        supervision:
          facts.phase === "quarantined"
            ? {
                ...createSupervisionState(record.driveId),
                isQuarantined: true,
                quarantineReason:
                  facts.outcome?.detail ??
                  "Quarantined by the watcher.",
              }
            : createSupervisionState(record.driveId),
      }),
    })
  }

  /**
   * The bay whose run is in progress, starting a new one if the
   * last one has already ended.
   *
   * A record outlives its outcome so the finished card stays on
   * the dashboard; the next event from that bay is a new disc and
   * therefore a new run.
   */
  const liveRecordOf = (input: {
    driveId: string
    /** The bay's house name, which the handlers call `name`. */
    name: string
    slot: number | null
  }): BayRecord => {
    const existing = records.get(input.driveId)

    const record =
      existing === undefined || existing.outcome !== null
        ? createRecord({
            driveId: input.driveId,
            label: input.name,
            slot: input.slot,
          })
        : existing

    record.label = input.name
    record.slot = input.slot

    if (record.startedAtMs === null) {
      record.startedAtMs = now()
    }

    // ⚠️ Re-read EVERY time, not once at the top of the run.
    //
    // This used to be inside the `startedAtMs === null` branch,
    // guarded by a comment saying the watcher clears `jobUuid`
    // when it applies the outcome so there would be nothing left
    // to read later. That stopped being true when `applyBayOutcome`
    // was changed to KEEP `jobUuid` — a finished card offers its
    // capture, so the id has to outlive the rip — and reading once
    // then became a bug with no reason left for it.
    //
    // What it cost: a bay HELD AT STARTUP emits a "held on startup"
    // NOTE and deliberately never an outcome (an outcome would
    // announce three rips that did not just happen on every
    // restart). So the note created a record, stamped
    // `startedAtMs`, and captured the jobUuid the LEDGER was
    // carrying — the previous daemon's job. `outcome` stayed null,
    // so no later event recreated the record, and every rip that
    // bay went on to do published that stale id as `job_uuid`. The
    // dashboard's Logs button then asked `/logs` for a
    // `<uuid>.robot.log` that does not exist and got a 404.
    // Measured 2026-07-30: slot 9 ripped 84 GB clean and its card
    // pointed at `3387a174…` while the capture was `e7d95e40…`.
    // Not specific to the Rip button — any held bay that later rips
    // hit it.
    //
    // Only ever OVERWRITTEN with a real id. A bay between runs has
    // `jobUuid: null` (`rearm` clears it) and must keep the id of
    // the run its card is still showing.
    const liveJobUuid =
      bayStateOf(input.driveId)?.jobUuid ?? null

    if (liveJobUuid !== null) {
      record.jobId = liveJobUuid
    } else if (record.jobId === "") {
      // No watcher attached, or a bay that has never had a job.
      // Deliberately not a fresh UUID: a UUID here would name a
      // `<uuid>.robot.log` that does not exist, and `job_uuid` is
      // documented as the real id.
      record.jobId = `${input.driveId}@${String(
        record.startedAtMs,
      )}`
    }

    records.set(input.driveId, record)

    return record
  }

  /**
   * Bring every bay the watcher knows about into the store.
   *
   * Nine idle drives emit no per-bay events at all, so without
   * this the dashboard would show an EMPTY rack while the tower
   * sat there fully loaded — and an empty rack is a meaningful
   * state of its own (F3), which it must not be confused with.
   *
   * ## Why it hangs off `onTickComplete` and not `onNote`
   *
   * It used to hang off `onNote`, and that did not work — 0.4.0
   * served three bays of nine. Two reasons, and the second is
   * the one that made it hopeless:
   *
   *  1. `onNote` fires only when the drive COUNT changes. A
   *     steady nine-bay tower says it once and never again.
   *  2. That one note is emitted at the TOP of the tick, before
   *     the per-bay loop has put a single bay into the watcher's
   *     table — so on the first tick `getBays()` was empty, and
   *     on every later one it described the previous poll.
   *
   * The only bays that ever reached the store were therefore the
   * ones that emitted a per-bay event, which on a freshly
   * restarted daemon meant exactly the held discs.
   * `onTickComplete` fires last, when both tables are current.
   *
   * Not called from `onBayProgress`: that fires several times a
   * second per bay during a rip and would rebuild all nine
   * snapshots each time for news that concerns one.
   */
  const syncRoster = (): void => {
    for (const bay of readBays?.() ?? []) {
      const existing = records.get(bay.driveId)

      // An empty tray retires the finished run. See
      // `hasBayReArmed`: the record deliberately outlives its
      // outcome so a finished card survives until the next
      // disc, and that is right while the disc is still IN the
      // tray — but a bay whose disc has been taken out has
      // nothing left to describe. The label and slot carry over
      // because they belong to the DRIVE, not to the run.
      const record =
        existing === undefined
          ? createRecord({ driveId: bay.driveId })
          : hasBayReArmed(bay) && existing.outcome !== null
            ? createRecord({
                driveId: bay.driveId,
                label: existing.label,
                slot: existing.slot,
              })
            : existing

      records.set(bay.driveId, record)
      publish(record)
    }
  }

  return {
    attachWatcher: ({
      getBays,
      getSightings,
      getUsbStability,
    }) => {
      readBays = getBays
      readSightings = getSightings ?? null
      readUsbStability = getUsbStability ?? null
    },

    handlers: {
      onTickComplete: () => {
        // Every bay the watcher knows, including the eight that
        // said nothing this poll. See `syncRoster`.
        syncRoster()
        // Bus-wide, so it rides the tick rather than any one bay's
        // event — a flap with no rip running (the tower sitting
        // idle on a bad cable) still has to reach the dashboard.
        store.setUsbStability({
          usbStability: readUsbStability?.() ?? STABLE_USB,
        })
        handlers.onTickComplete?.()
      },

      // An operator command changed the bay table between two
      // polls — a drawer moved, a reminder was cleared. Same
      // roster read, and it must not wait for the next tick:
      // the dashboard refetches `/json` the instant its POST
      // resolves, and what it is refetching for is exactly what
      // just changed.
      onBayTableChanged: () => {
        syncRoster()
        handlers.onBayTableChanged?.()
      },

      onNote: (message) => {
        handlers.onNote?.(message)
      },

      onBayNote: (event) => {
        publish(liveRecordOf(event))
        handlers.onBayNote?.(event)
      },

      onBayProgress: (event) => {
        const record = liveRecordOf(event)

        record.progress = event.progress
        record.hasSeenProgress = true

        publish(record)
        handlers.onBayProgress?.(event)
      },

      onBayOutcome: (event) => {
        const record = liveRecordOf(event)

        record.outcome = event.outcome
        record.finishedAtMs = now()

        publish(record)

        const job = buildJob({
          record,
          facts: readBayFacts({
            bay: bayStateOf(record.driveId),
            record,
          }),
          poster,
          verdicts,
        })

        // `last_rip` is the retained "what happened most
        // recently" the HA sensors read, so only a rip that
        // actually ran belongs in it. A `needs_attention` disc
        // never started one and `no_media` means the disc left;
        // either one there would read as a finished rip.
        if (
          job !== null &&
          (event.outcome.kind === "completed" ||
            event.outcome.kind === "failed")
        ) {
          store.setLastRip({
            lastRip: {
              job,
              verdict: job.verdict,
              driveLabel: record.label,
            },
          })
        }

        handlers.onBayOutcome?.(event)
      },
    },
  }
}

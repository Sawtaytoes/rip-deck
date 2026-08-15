import { formatBayList } from "./trayCommand.ts"

/**
 * What is still sitting in the tower, and nobody has taken out.
 *
 * ## Why this is its own fact
 *
 * The owner, 2026-07-30, having powered the tower off from his
 * phone while a rip finished without him:
 *
 * > *"The UI can note that something was in a tray when you power
 * > it off. It doesn't today. … It'd be good to know in the UI or
 * > through a Home Assistant automation as a reminder to take out
 * > the disc. Kinda like taking out the trash or there's a leak.
 * > It's something I need to do eventually but wasn't at home to
 * > do it."*
 *
 * That is a **chore**, not an alert: nothing is wrong, nothing is
 * urgent, and it stays true until a human walks over to the rack.
 * Everything else rip-deck publishes describes what is happening
 * *now* — a rip, a verdict, a flapping bus — and all of it goes
 * quiet the moment the tower is switched off. This is the one fact
 * that has to survive the tower going dark, because that is
 * exactly when it matters.
 *
 * ## ⚠️ It cannot be read off the hardware
 *
 * A powered-off tower has **no drives on the bus at all**. There is
 * nothing to probe, and `hasFinishedDisc` — which the Open-trays
 * escalation folds — answers `false` for every bay, because its
 * first term is `observation.isDrivePresent`. So this is answered
 * from **memory**: the bay table, which `watcher.tickNow` keeps
 * rather than drops when a drive leaves the bus ("a dropped bay
 * comes back as a fresh idle one, and a fresh idle bay with a
 * finished disc still in it re-rips that disc"), and the sighting
 * table, which keeps a vanished bay's slot and label.
 *
 * ## Surviving a daemon restart with the tower off
 *
 * The bay and sighting tables are in-memory, so a *restart* against
 * a dark tower starts with both empty: a fresh daemon probes, sees
 * zero drives and builds no bays. The durable memory is the **bay
 * ledger** (`bayLedger.ts`, `$RIP_DECK_STATE_DIR/bays.json`), which
 * records every latched bay and the disc still in it precisely so a
 * restart does not re-rip finished discs. `phantomLoadedBays`
 * rebuilds the loaded-discs summary from those records for any
 * driveId the live probe did not answer — so the reminder is
 * rip-deck's OWN disk state, computed the same on the dashboard and
 * on the wire, and it no longer depends on the broker's retained
 * copy to survive
 * ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
 *
 * The MQTT payload stays **retained**, but as a mirror rather than
 * the system of record: it lets Home Assistant read the last value
 * the instant it reconnects. `shouldPublishLoadedDiscs` +
 * `isBlind` are the rule that still keeps a daemon which genuinely
 * knows nothing — an unreadable ledger AND a dark tower — from
 * publishing a false all-clear over it.
 *
 * ## What counts as "still in the tower"
 *
 * A bay **holding a disc that rip-deck is finished with** —
 * `is_holding_finished_disc` on the wire, `hasDisc && isLatched`
 * in `buildDriveDiscState`. Deliberately the same set `open_trays`
 * opens on its first press, because it is the same question:
 * *which discs is a human waiting to take out?*
 *
 * A disc mid-rip is excluded, and stays excluded even with the
 * tower off — an interrupted rip latches `failed`, which is
 * terminal, so it arrives here through the front door rather than
 * as a special case.
 */

/** One disc a human still has to fetch. */
export type LoadedDisc = {
  /** The number on the front of the rack. Null if unregistered. */
  slot: number | null
  /** House label, already slot-prefixed. */
  label: string
  /** The disc's own name, when identify read one. */
  title: string | null
  /** Its rip finished successfully — this is a collection, not a fix. */
  isRipped: boolean
}

/** What a caller has to hold to answer the question. */
export type LoadedDiscBay = {
  slot: number | null
  label: string
  /** The drive answered the last probe. */
  isDrivePresent: boolean
  /** Something is in the tray. */
  hasDisc: boolean
  /** rip-deck is finished with it: `done` or `quarantined`. */
  isLatched: boolean
  isRipped: boolean
  title: string | null
}

export type LoadedDiscSummary = {
  count: number
  discs: LoadedDisc[]
  /**
   * Any drive answered the last probe.
   *
   * Published because it changes what the reminder ASKS FOR. With
   * the tower on, the next step is one button ("Open trays"). With
   * it off, it is two, and the first is physical.
   */
  isTowerOn: boolean
  /** One sentence, written to be READ. Empty when nothing is loaded. */
  message: string
  /** The same, written to be HEARD. Empty when nothing is loaded. */
  spokenMessage: string
  /**
   * The daemon has NO basis to know what is loaded right now.
   *
   * True only when both are true: no drive answered the last probe
   * (`!isTowerOn`) AND the on-disk ledger was not readable. In that
   * one state an EMPTY summary is an absence of evidence, not an
   * all-clear, and `shouldPublishLoadedDiscs` refuses to publish it
   * over the retained reminder. Every other empty summary — a
   * readable ledger that recorded nothing, or a tower whose drives
   * are on the bus and hold nothing — is a genuine all-clear that
   * SHOULD be published, so a stale reminder clears itself.
   *
   * This is the disk-first correction to the old rule: the source
   * of truth is rip-deck's own ledger, not the broker's retained
   * copy ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
   */
  isBlind: boolean
}

export const EMPTY_LOADED_DISCS: LoadedDiscSummary = {
  count: 0,
  discs: [],
  isTowerOn: false,
  message: "",
  spokenMessage: "",
  // Nothing loaded AND nothing known: the honest default for a
  // summary handed out before anything has been read. Kept blind
  // so it can never, on its own, clear a standing reminder.
  isBlind: true,
}

/**
 * The reminder, in the owner's terms rather than the daemon's.
 *
 * It names the SLOTS and not the drive models, for the same reason
 * `spoken_message` does
 * ([decision](docs/decisions/2026-07-30-spoken-and-written-messages-are-separate-fields.md)):
 * the slot is the number written on the rack, and it is what he
 * will be looking at when he finally walks down there.
 *
 * It also says what to DO, and that changes with the tower's power:
 * a live tower is one button away from open trays, a dark one is
 * not. A reminder that names a control which cannot work right now
 * is the held-card defect in a different costume.
 */
const buildLoadedMessage = (input: {
  discs: LoadedDisc[]
  isTowerOn: boolean
}): string => {
  const { discs } = input

  if (discs.length === 0) return ""

  const bays = formatBayList(discs)

  const what =
    discs.length === 1
      ? `1 disc is still in the tower — ${bays}`
      : `${String(discs.length)} discs are still in the ` +
        `tower — ${bays}`

  return input.isTowerOn
    ? `${what}. Press Open trays to get ${
        discs.length === 1 ? "it" : "them"
      } out.`
    : `${what}. The tower is off, so the trays cannot open ` +
        `until it is powered back on.`
}

/**
 * The same, for a speaker.
 *
 * Shorter, and it drops the instruction: a reminder spoken across
 * the house reaches someone who is not standing at the dashboard
 * and cannot press anything. What it has to carry is the fact and
 * the count.
 */
const buildLoadedSpokenMessage = (
  discs: LoadedDisc[],
): string => {
  if (discs.length === 0) return ""

  return discs.length === 1
    ? `A disc is still in the optical ripper tower, in ` +
        `${formatBayList(discs)}.`
    : `${String(discs.length)} discs are still in the ` +
        `optical ripper tower.`
}

export const summariseLoadedDiscs = (
  bays: readonly LoadedDiscBay[],
  options: {
    /**
     * Was the last read blind — no drives on the bus AND no
     * readable ledger? Defaults to `false`: a caller that folds a
     * known set of bays (a fixture, the API's snapshot) is never
     * blind. Only the watcher, which knows whether it read the
     * ledger, passes `true`, and only when the bus is also empty.
     */
    isBlind?: boolean
  } = {},
): LoadedDiscSummary => {
  const discs: LoadedDisc[] = bays
    .filter((bay) => bay.hasDisc && bay.isLatched)
    .map((bay) => ({
      slot: bay.slot,
      label: bay.label,
      title: bay.title,
      isRipped: bay.isRipped,
    }))
    // Lowest slot first, so the list reads the way the rack does.
    // An unregistered bay has no slot and sorts last rather than
    // first, which a bare `?? 0` would do.
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99))

  const isTowerOn = bays.some((bay) => bay.isDrivePresent)

  return {
    count: discs.length,
    discs,
    isTowerOn,
    message: buildLoadedMessage({ discs, isTowerOn }),
    spokenMessage: buildLoadedSpokenMessage(discs),
    // A tower with drives on the bus can always be re-probed, so it
    // is never blind whatever the caller says.
    isBlind: isTowerOn ? false : (options.isBlind ?? false),
  }
}

/**
 * One latched bay, as the on-disk ledger remembers it.
 *
 * The minimal structural shape `phantomLoadedBays` needs, kept
 * here rather than importing `BayLedgerRecord` from `bayLedger.ts`
 * — that module's types reach back into `watcher.ts`, which
 * imports this one, and the import would close a cycle. The
 * watcher maps its own records onto this before calling.
 */
export type LedgerLoadedRecord = {
  driveId: string
  phase: "done" | "quarantined"
  discName: string | null
  /** Its rip finished successfully (`outcome.kind === "completed"`). */
  isRipped: boolean
}

/**
 * The discs a restarted daemon knows are loaded only from disk.
 *
 * ## The gap this fills
 *
 * `startWatcher`'s bay table is built by PROBING: a bay exists
 * only for a drive that answered. A tower switched off answers
 * with nothing, so a daemon that restarts against it builds an
 * empty table and `summariseLoadedDiscs([])` says "nothing
 * loaded" — even though the ledger on disk records three finished
 * discs still in their trays. The old design papered over this
 * with the broker's retained copy; this rebuilds the fact from
 * rip-deck's own ledger instead
 * ([decision](docs/decisions/2026-07-30-loaded-discs-rebuild-from-the-bay-ledger.md)).
 *
 * ## ⚠️ These are display facts, never rip inputs
 *
 * A phantom is `isDrivePresent: false` and it is folded ONLY into
 * the loaded-discs summary — the thing the banner and the reminder
 * read. It never enters the `bays` map `decideBayAction` iterates,
 * so it cannot start a rip or move a tray. When the tower powers
 * back on, the drive answers a probe, a REAL bay is adopted for
 * that `driveId` (`adoptBayAtStartup`, fail-closed), and
 * `liveDriveIds` then excludes the phantom — the real bay wins and
 * the phantom vanishes with no double-count.
 *
 * Every persisted ledger record is a latched bay that still holds
 * its disc (that is `toLedgerRecords`' whole contract), so every
 * one that is not already a live bay becomes a loaded phantom.
 */
export const phantomLoadedBays = (input: {
  records: readonly LedgerLoadedRecord[]
  /** Drives the live probe already built a bay for — skip these. */
  liveDriveIds: ReadonlySet<string>
  /** Slot + house label for a driveId, from the registry. */
  placementOf: (driveId: string) => {
    slot: number | null
    label: string
  }
}): LoadedDiscBay[] =>
  input.records
    .filter(
      (record) => !input.liveDriveIds.has(record.driveId),
    )
    .map((record) => {
      const { slot, label } = input.placementOf(
        record.driveId,
      )

      return {
        slot,
        label,
        // A powered-off tower is not on the bus, and a phantom
        // exists precisely because its drive did not answer.
        isDrivePresent: false,
        // A ledger record is written only for a bay finished with
        // a disc STILL in it, so a disc is loaded by definition.
        hasDisc: true,
        isLatched:
          record.phase === "done" ||
          record.phase === "quarantined",
        isRipped: record.isRipped,
        title: record.discName,
      }
    })

/**
 * May this summary be published over the last retained one?
 *
 * ⚠️ **The one rule that keeps the retained reminder trustworthy,
 * now that the ledger — not the broker — is the source of truth.**
 * A summary with something in it is always publishable: it is
 * evidence. An EMPTY summary is publishable UNLESS the daemon is
 * `isBlind` — no drive on the bus AND no readable ledger — because
 * only then is "nothing loaded" an absence of evidence rather than
 * a finding, and publishing it would overwrite a standing reminder
 * with a false all-clear.
 *
 * What changed from the original rule: a daemon restarted against a
 * dark tower used to be blind by definition, so an empty summary
 * was always suppressed and the broker's retained copy was the only
 * memory. Now the same daemon rebuilds the loaded set from its own
 * on-disk ledger (`phantomLoadedBays`), so an empty summary means
 * either the ledger recorded nothing (a genuine all-clear worth
 * publishing, so a stale reminder clears itself) or the ledger was
 * unreadable (`isBlind`, suppressed). The distinction lives in
 * `isBlind`, computed where the ledger's readability is known —
 * the watcher — not guessed from an empty bay table here.
 *
 * Same spirit as `activity`'s rule: **unknown is not idle.** The
 * difference is that unknown is now a much smaller set.
 */
export const shouldPublishLoadedDiscs = (
  summary: LoadedDiscSummary,
): boolean =>
  summary.count > 0 || summary.isTowerOn || !summary.isBlind

/**
 * The retained wire payload.
 *
 * snake_case to match `activity` and `drive/<slug>` — one house
 * style across every topic, so an automation author never has to
 * remember which one uses which.
 *
 * It carries the finished SENTENCES as well as the numbers on
 * purpose. Home Assistant's job here is to decide *when* to remind
 * somebody, not to compose the reminder out of a slot array in
 * Jinja — that is the same split `spoken_message` settled for the
 * announcement
 * ([decision](docs/decisions/2026-07-30-spoken-and-written-messages-are-separate-fields.md)).
 */
export type LoadedDiscsPayload = {
  count: number
  /** The numbers on the front of the rack, lowest first. */
  slots: number[]
  discs: {
    slot: number | null
    label: string
    title: string | null
    is_ripped: boolean
  }[]
  /** Any drive answered the last probe. */
  is_tower_on: boolean
  /** One sentence for a screen. Empty when nothing is loaded. */
  message: string
  /** One sentence for a speaker. Empty when nothing is loaded. */
  spoken_message: string
  /** Epoch ms of this message, so a stale card is visibly stale. */
  updated_at: number
}

export const buildLoadedDiscsPayload = (input: {
  summary: LoadedDiscSummary
  nowMs: number
}): LoadedDiscsPayload => ({
  count: input.summary.count,
  slots: input.summary.discs
    .map((disc) => disc.slot)
    .filter((slot): slot is number => slot !== null),
  discs: input.summary.discs.map((disc) => ({
    slot: disc.slot,
    label: disc.label,
    title: disc.title,
    is_ripped: disc.isRipped,
  })),
  is_tower_on: input.summary.isTowerOn,
  message: input.summary.message,
  spoken_message: input.summary.spokenMessage,
  updated_at: input.nowMs,
})

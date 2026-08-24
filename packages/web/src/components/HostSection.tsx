import {
  heldDetailLines,
  isBayHeld,
  isVerdictActionable,
  latestPerDrive,
  ripBucket,
} from "../format"
import type { BayActionState } from "../hooks/useBayActions"
import type {
  BayAction,
  BayView,
  Host,
  Rip,
  TowerView,
} from "../types"
import { BayGrid } from "./BayGrid"
import { ClearLoadedButton } from "./ClearLoadedButton"
import { DriveRail } from "./DriveRail"
import { HeldBayCard } from "./HeldBayCard"
import { LoadedDiscsBanner } from "./LoadedDiscsBanner"
import { QuarantinedBayCard } from "./QuarantinedBayCard"
import { RipCard } from "./RipCard"
import { TowerAlerts } from "./TowerAlerts"
import { UsbAlertBanner } from "./UsbAlertBanner"

/**
 * One tower: header, grouped alerts, a rail of every bay, then
 * the cards.
 *
 * Ported from the viewer's `HostSection` and reordered around
 * what rip-deck knows. Four deliberate differences:
 *
 *  1. **The grouped alerts come first**, above the per-bay
 *     cards. A hub fault is one problem across four bays; if the
 *     four cards are what the eye lands on, the reader has
 *     already been told four times that four discs are bad.
 *  2. **An empty rack is a sentence, not an error.** Zero bays
 *     means the owner switched the tower off, which is how he
 *     uses it (F3). It gets calm grey text and the section
 *     stops. Painting a normal state red is how a real fault
 *     stops being noticed.
 *  3. **Quarantined bays get cards even with no job.** They
 *     would otherwise be a chip on the rail, and the decision
 *     they are waiting on is a human one.
 *  4. **Held bays come BEFORE the active rips.** Quarantine and
 *     a held disc are the only two things on this page waiting
 *     on a person; everything below them is rip-deck working, and
 *     needs nothing. Putting the two jobs-for-a-human at the top
 *     is the whole ordering rule.
 *
 * The recent bucket is still capped at four cards, for the
 * reason the viewer capped it: nine bays with a rip history each
 * is a wall, and the owner cares about what every bay is doing
 * NOW.
 */
const RECENT_CARD_LIMIT = 4

export function HostSection({
  host,
  tower,
  onShowLog,
  onAction,
  actionFor,
  columns,
  now,
}: {
  host: Host
  tower: TowerView
  onShowLog: (rip: Rip) => void
  onAction: (input: {
    driveId: string
    label: string
    action: BayAction
  }) => void
  actionFor: (driveId: string) => BayActionState | undefined
  /**
   * How many columns every bucket below draws. Decided once, by
   * `Dashboard`, and passed down — the buckets are one page, and
   * a held bay two-wide above a recent bay three-wide is two
   * pages.
   */
  columns: number
  /** Injectable so elapsed text is deterministic in tests. */
  now?: number
}) {
  const bayByDriveId = new Map<string, BayView>(
    tower.bays.map((bay) => [bay.drive_id, bay]),
  )

  // Bays rip-deck refused to rip. They own their whole card, so
  // their ARM-shaped rip is pulled out of the buckets below —
  // otherwise the same disc appears twice, once as a held bay
  // and once as a `RipCard` whose every number is zero.
  const held = tower.bays.filter(isBayHeld)
  const heldDriveIds = new Set(
    held.map((bay) => bay.drive_id),
  )

  /**
   * Held bays after the first one carrying the identical
   * sentence.
   *
   * The startup hold fires on every loaded bay at once, so the
   * owner's three discs each carry the same paragraph word for
   * word — three copies of five lines, with the one thing that
   * actually differs (which disc, which slot) buried inside
   * them. Said once, then pointed at, exactly as `VerdictBadge`
   * already handles the hub fault.
   *
   * The comparison is EQUALITY of the whole sentence, not a
   * pattern over it. Matching daemon prose is the mistake §4.4
   * warns about; noticing that two strings are the same string
   * is not.
   */
  const sharedDetails = new Set<string>()
  const heldWithSharedDetail = held.map((bay) => {
    const detail = heldDetailLines(bay).join("\n")
    const isSharedDetail =
      detail !== "" && sharedDetails.has(detail)

    sharedDetails.add(detail)

    return { bay, isSharedDetail }
  })

  // One card per bay (its newest job), then bucket those.
  const current = latestPerDrive(host.rips).filter(
    (rip) => !heldDriveIds.has(rip.drive_id),
  )
  const ripping = current.filter(
    (rip) => ripBucket(rip) === "ripping",
  )
  const attention = current.filter(
    (rip) => ripBucket(rip) === "attention",
  )
  const recent = current
    .filter((rip) => ripBucket(rip) === "recent")
    .slice(0, RECENT_CARD_LIMIT)

  // A quarantined bay with a job is already a RipCard, and that
  // card carries the clear control among its actions.
  const rippedDriveIds = new Set(
    current.map((rip) => rip.drive_id),
  )
  const quarantined = tower.bays.filter(
    (bay) =>
      bay.is_quarantined &&
      !rippedDriveIds.has(bay.drive_id),
  )

  /**
   * Verdicts whose CAUSE is one shared object, across several
   * bays. Those cards defer to the alert above instead of
   * printing the same paragraph four times over.
   *
   * The test is the verdict's SUBJECT, not merely that several
   * bays share a kind. A `hub` or `system` fault is one physical
   * thing — a hub that lost power, an expired MakeMKV key — and
   * restating it per bay invites reading four objects where
   * there is one, which is the confidently-wrong reading this
   * model exists to prevent. Two bays reporting `disc_dirty` are
   * NOT that: they are two discs, or the same disc deliberately
   * re-tested in a second drive, and collapsing them would erase
   * the two-drive rule at the exact moment it is being applied.
   */
  /**
   * Alerts worth a banner above the cards.
   *
   * **The banner is reserved for things that are actually
   * wrong.** It is the loudest element on the page, and on the
   * live rack it was spending that on three finished, verified,
   * 225 GB backups: `towerFeed` stamps a placeholder `unknown`
   * verdict on every bay it did not measure, `buildTowerAlerts`
   * groups any non-`ok` verdict, and out came a full-width red
   * *"Not enough information to judge this rip yet."* above three
   * completed rips.
   *
   * Two filters, and both say the same thing in different words:
   *
   *  - a verdict that ASKS for nothing gets no banner. The
   *    caveat still shows, quietly, on the card that earned it.
   *  - a held bay's trouble is stated in full by its own card,
   *    better and in amber, so an alert spanning only held bays
   *    is a second copy of the page.
   *
   * The hub-fault paragraph repeated on five surfaces (§4) is
   * the same defect both times; the fix is the same one.
   */
  const bannerAlerts = tower.alerts.filter(
    (alert) =>
      isVerdictActionable(alert.verdict) &&
      alert.drive_ids.some(
        (driveId) => !heldDriveIds.has(driveId),
      ),
  )

  const sharedVerdicts = new Set(
    bannerAlerts
      .filter(
        (alert) =>
          alert.drive_ids.length > 1 &&
          (alert.subject === "hub" ||
            alert.subject === "system"),
      )
      .map((alert) => alert.verdict),
  )

  const card = (rip: Rip) => (
    <RipCard
      key={rip.drive_id || rip.job_uuid}
      rip={rip}
      bay={bayByDriveId.get(rip.drive_id)}
      onShowLog={onShowLog}
      onAction={onAction}
      action={actionFor(rip.drive_id)}
      isSharedTrouble={sharedVerdicts.has(rip.verdict)}
      now={now}
    />
  )

  return (
    <section className="mb-7">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border-subtle pb-1.5">
        <span className="font-semibold text-content-primary">
          {host.host}
        </span>
        <span className="text-base text-content-muted">
          {tower.drive_count} bays · {tower.active_count}{" "}
          ripping
        </span>
        {!host.ok && (
          <span className="text-base text-intent-danger-content">
            collector failed
            {host.err ? `: ${host.err}` : ""}
          </span>
        )}
      </div>

      <UsbAlertBanner alert={tower.usb_alert} />

      {/* After the fault banner and before the cards: a chore
          outranks nothing, but a powered-off tower has no cards
          at all and this is then the only thing on the page. */}
      <LoadedDiscsBanner
        actions={<ClearLoadedButton />}
        loaded={tower.loaded_discs}
      />

      <TowerAlerts alerts={bannerAlerts} />

      {!tower.is_tower_present ? (
        <div className="my-1.5 rounded-xl border border-border-subtle bg-surface-raised px-3.5 py-2.5 text-content-muted">
          No drives present — the tower is switched off.
        </div>
      ) : (
        <>
          <DriveRail bays={tower.bays} />

          <BayGrid columns={columns}>
            {quarantined.map((bay) => (
              <QuarantinedBayCard
                key={bay.drive_id}
                bay={bay}
                onAction={onAction}
                action={actionFor(bay.drive_id)}
              />
            ))}
          </BayGrid>

          {held.length > 0 && (
            <>
              <div className="mb-1 mt-2.5 text-base font-semibold text-intent-warning-content">
                held ·{" "}
                {held.length === 1
                  ? "one disc"
                  : `${held.length} discs`}{" "}
                Rip Deck would not rip without asking
              </div>
              <BayGrid columns={columns}>
                {heldWithSharedDetail.map(
                  ({ bay, isSharedDetail }) => (
                    <HeldBayCard
                      key={bay.drive_id}
                      bay={bay}
                      onAction={onAction}
                      action={actionFor(bay.drive_id)}
                      isSharedDetail={isSharedDetail}
                    />
                  ),
                )}
              </BayGrid>
            </>
          )}

          {ripping.length > 0 ? (
            <BayGrid columns={columns}>
              {ripping.map((rip) => card(rip))}
            </BayGrid>
          ) : (
            <div className="my-1.5 rounded-xl border border-border-subtle bg-surface-raised px-3.5 py-2.5 text-content-muted">
              no active rips
            </div>
          )}

          {attention.length > 0 && (
            <>
              <div className="mb-1 mt-2.5 text-base font-semibold text-intent-warning-content">
                needs attention ·{" "}
                {attention.length === 1
                  ? "one bay"
                  : `${attention.length} bays`}
              </div>
              <BayGrid columns={columns}>
                {attention.map((rip) => card(rip))}
              </BayGrid>
            </>
          )}

          {recent.length > 0 && (
            <>
              <div className="mb-1 mt-2.5 text-base text-content-muted">
                recent
              </div>
              <BayGrid columns={columns}>
                {recent.map((rip) => card(rip))}
              </BayGrid>
            </>
          )}
        </>
      )}
    </section>
  )
}

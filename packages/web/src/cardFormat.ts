import { bayActionsFor, trayActionsFor } from "./format"
import type {
  BayAction,
  BayView,
  TrayCommandReport,
} from "./types"

/**
 * The card layer's own presentation helpers.
 *
 * Everything here belongs in `format.ts` and is only separate
 * because `format.ts` was another unit's file while these were
 * written. **Fold them in when the two branches meet** — there
 * is no second opinion in this file, every function delegates
 * the decisions to `format.ts` and only reshapes the answer.
 */

/**
 * The two tray words, which are no longer BUTTONS.
 *
 * > *"This button should also have an eject icon, not 'open
 * > tray' because it's an open/close toggle."*
 *
 * A bay gets ONE ⏏ control now, and which way it sends is
 * `format.nextTrayCommandFor`'s inference, made at the toggle.
 * So the two words are pulled out of the rendered action list —
 * a card showing ⏏ *and* an "Open tray" button would be two
 * controls for one drawer, which is the doubled opinion the
 * toggle exists to collapse.
 */
const TRAY_WORDS: ReadonlySet<BayAction> = new Set([
  "open_bay",
  "close_bay",
])

/** The bay's controls, minus the tray pair the ⏏ toggle owns. */
export function jobActionsFor(
  bay: BayView | undefined,
): BayAction[] {
  return bayActionsFor(bay).filter(
    (action) => !TRAY_WORDS.has(action),
  )
}

/**
 * May this bay be offered a ⏏ toggle at all?
 *
 * Not a second opinion: `format.trayActionsFor` is still the one
 * place that argues eligibility — the refusal-first ordering, the
 * absent drive, the quarantined bay — and this only asks whether
 * it offered anything. The second clause is the day the daemon
 * starts publishing tray commands in `bay.actions`, at which
 * point `trayActionsFor` deliberately returns nothing and the
 * published words are the answer.
 */
export function isTrayOffered(
  bay: BayView | undefined,
): boolean {
  if (bay === undefined) return false

  return (
    trayActionsFor(bay).length > 0 ||
    bay.actions.some((action) => TRAY_WORDS.has(action))
  )
}

/** What a tray press did to ONE bay, in the daemon's words. */
export type TrayOutcome = {
  text: string
  /** Refused, skipped or failed — never a moved drawer. */
  isTrouble: boolean
}

/** Results that mean the press did the thing it was asked to. */
const MOVED_RESULTS: ReadonlySet<string> = new Set([
  "opened",
  "opened_not_ripped",
  "closed",
  // Not a drawer, and still not trouble: the operator pressed Rip
  // and a rip started. Rendering it amber would make the one
  // outcome he wanted look like the refusals beside it.
  "rip_started",
])

/**
 * May this bay be offered a Rip control?
 *
 * Only "is there a disc in it", and deliberately nothing else.
 * Every other reason a bay might look ineligible — latched `done`,
 * flagged `needs_attention`, quarantined, out of starts — is
 * precisely what the operator is pressing Rip to overrule, and
 * folding any of them in here would rebuild the dead end this
 * control exists to remove. The one refusal that stands is the
 * daemon's (`starting`/`ripping`), and it is not this function's
 * to make: a bay mid-rip is not rendered by `HeldBayCard` at all,
 * and if the state changes under the operator's hand the daemon
 * refuses the press and says so.
 *
 * `disc_size_sectors` is optional on `BayView`, so a daemon older
 * than that field offers the control rather than hiding it — a
 * press then answers "there is no disc in this bay", which is the
 * honest failure. Hiding the only control on the card because a
 * field is missing is not.
 */
export function isRipOffered(
  bay: BayView | undefined,
): boolean {
  if (bay === undefined) return false

  return bay.is_present && bay.disc_size_sectors !== null
}

/**
 * The sentence to show under a bay's ⏏ toggle.
 *
 * ⚠️ **The bay's `detail`, never the report's `message`.** The
 * daemon accepts a command it then refuses per bay:
 * `is_accepted: true` with one `refused_ripping` bay means *"I
 * heard you, and no"*, and the top-level message is written
 * about the whole rack. On a per-bay control it would report
 * success about the one bay that was correctly protected.
 *
 * `message` is used in exactly one case — a command the daemon
 * could not even read, which produces a rejection with NO bays
 * in it. There is no per-bay sentence to prefer there, and
 * silence would leave a press with no answer at all.
 */
export function trayOutcomeFor(input: {
  report: TrayCommandReport | null
  lastError: string | null
  driveId: string
}): TrayOutcome | null {
  const { report, lastError, driveId } = input

  // No report at all: a 405, a 503, a network that never
  // answered. `useTrayCommand` rejects only for these.
  if (lastError !== null) {
    return { text: lastError, isTrouble: true }
  }

  if (report === null) return null

  const bay = report.bays.find(
    (entry) => entry.drive_id === driveId,
  )

  if (bay === undefined) {
    return report.is_accepted
      ? null
      : { text: report.message, isTrouble: true }
  }

  return {
    text: bay.detail,
    isTrouble: !MOVED_RESULTS.has(bay.result),
  }
}

/**
 * The drive's model, without the slot number in front of it.
 *
 * > *"the drives are prefixed with their slot number. Do we need
 * > that if we're going to say 'slot 9' anyway?"*
 *
 * No — the card says the slot once, in its own field, and the
 * model is just the model.
 *
 * ⚠️ **Fixed here rather than in `config/drives.json`.** The
 * registry's `name` IS the house label: it becomes the MQTT
 * label and therefore the Home Assistant entity id, and Stage 6
 * already churned those once by fixing the doubled prefix
 * (`docs/HANDOFF-stage7-ui-and-naming.md` §3, §9). Editing the
 * registry would churn them a second time for a purely visual
 * gain.
 *
 * The strip is deliberately CONSERVATIVE: the leading number has
 * to be this bay's own slot. `"07 - Pioneer BDR-211M"` in slot 7
 * loses its prefix; a drive genuinely called `"4K Something"`,
 * or a label whose number disagrees with the slot, is left
 * exactly as the registry spelled it. A label the operator does
 * not recognise is worse than a redundant one.
 */
export function bareDriveModel(input: {
  label: string | null
  slot: number | null
}): string {
  const { label, slot } = input

  if (label === null) return ""
  if (slot === null) return label

  const match = /^(\d+)\s*-\s*(.+)$/.exec(label)

  if (match === null) return label

  const [, prefix = "", model = ""] = match

  return Number(prefix) === slot ? model : label
}

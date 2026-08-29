import type {
  Job,
  Verdict,
  VerdictKind,
} from "@rip-deck/contracts"

/**
 * The Home Assistant announcement contract.
 *
 * `automation.job_status_announcement` is shared by disc rips,
 * 3D prints and 2D prints. Its rip branch reads a fixed payload
 * shape, and the spec is explicit that when the disc pipeline is
 * replaced, ONLY THE SOURCE TOPIC CHANGES. So this payload is a
 * contract, not an implementation detail — it is reproduced
 * exactly, and the tests lock it down.
 *
 * The automation branches in priority order:
 *   1. result == 'fail'                -> "A rip failed on {drive}."
 *   2. health in ['slow','very_slow']  -> "The {drive} drive struggled
 *                                          with {title}. The disc may
 *                                          need cleaning."
 *   default (success, healthy)         -> "{title} finished ripping."
 */

export type RipEventPayload = {
  job_id: string
  title: string
  result: "success" | "fail"
  ok: boolean
  disctype: string
  drive: string
  health: LegacyHealth
  /** Richer detail, additive — HA ignores what it doesn't use. */
  verdict: VerdictKind
  verdict_message: string
  verdict_action: string
  /**
   * The bay in the operator's own numbering. Null when unknown.
   *
   * Additive, and it exists for `spoken_message` below: `drive` is
   * `"09 - Pioneer BDR-211M"`, which a house speaker reads out as
   * a part number. The slot is the identifier the owner uses when
   * he walks over to the tower.
   */
  slot: number | null
  /**
   * The whole announcement, written to be HEARD. Additive.
   *
   * The automation used to compose its own line out of `drive` and
   * `title`, which put a drive MODEL through TTS and — worse —
   * said "a rip failed" about a disc that never failed, because a
   * `needs_attention` hold reports `result: "fail"` for want of a
   * third value (owner, 2026-07-30: "announcing the full error
   * message with weird computer-style text"). rip-deck knows which
   * of those three things happened; the automation does not, and
   * cannot be given the vocabulary without a template per case
   * ([decision](docs/decisions/2026-07-30-spoken-and-written-messages-are-separate-fields.md)).
   *
   * So rip-deck owns the words and HA speaks this field, falling
   * back to its old templates. Everything else here is unchanged,
   * which is what keeps the shared contract intact: 3D and 2D
   * prints are on the same automation and were not touched.
   */
  spoken_message: string
}

/**
 * The legacy four-value health vocabulary.
 *
 * Our verdict set is richer, so it has to be projected down.
 * The projection is chosen by what the automation SAYS, not by
 * how severe the verdict feels.
 */
export type LegacyHealth =
  | "ok"
  | "slow"
  | "very_slow"
  | "unknown"

/**
 * Project a verdict onto the legacy health vocabulary.
 *
 * The one subtlety worth stating: hardware faults map to
 * `unknown`, NOT to `very_slow`. `very_slow` makes the
 * automation say "the disc may need cleaning", and telling
 * someone to clean a disc because a USB hub lost power is
 * exactly the kind of wrong-but-confident alert that destroys
 * trust in the whole feature. Those cases already fail the rip,
 * so priority 1 speaks for them.
 */
export const toLegacyHealth = (
  kind: VerdictKind,
): LegacyHealth => {
  switch (kind) {
    case "ok":
      return "ok"

    case "disc_marginal_slow":
      return "slow"

    // Genuinely disc-surface problems — "may need cleaning" is
    // the right thing to say, and for a scratch the UI carries
    // the more precise "source another copy".
    case "disc_dirty":
    case "disc_scratched":
      return "very_slow"

    // Not disc problems. Stay quiet and let the failure branch
    // do the talking.
    case "hub_fault":
    case "drive_failing":
    case "enumeration_flap":
    case "key_expired":
    case "disc_read_error":
    case "unknown":
      return "unknown"
  }
}

/**
 * How a bay is named ALOUD.
 *
 * The slot when there is one, because that is the number written
 * on the tower. Never the drive label: `"09 - Pioneer BDR-211M"`
 * is read out as "zero nine dash Pioneer B D R two one one M".
 * A bay with no slot — a drive not in `config/drives.json` — gets
 * no name rather than a model number, and the sentences below are
 * written so that reads naturally.
 */
const spokenBay = (slot: number | null): string | null =>
  slot === null ? null : `slot ${String(slot)}`

/**
 * The one line Home Assistant reads out for a finished rip.
 *
 * Three cases, and the middle one is the whole reason this
 * function exists rather than a template in the automation:
 *
 *  - **`needs_attention`** — nothing failed and nothing ripped.
 *    rip-deck declined to guess and left the disc where it is.
 *    The old line said "a rip failed", which sends the owner
 *    looking for a damaged disc that does not exist. This is the
 *    same distinction `HeldBayCard` draws in amber rather than red,
 *    and it was only ever missing from the spoken half.
 *  - **failed** — a rip that actually ran and did not produce a
 *    disc.
 *  - **success** — with the drive-struggled variant, which is the
 *    one case where the health verdict changes what to DO (clean
 *    the disc), so it earns its own sentence.
 */
export const buildRipSpokenMessage = (input: {
  job: Job
  verdict: Verdict
  slot: number | null
}): string => {
  const { job, verdict } = input

  // `job.identity.title`, never `RipEventPayload.title`: that one
  // is defaulted to "Unknown disc", and "Unknown disc finished
  // ripping" is a sentence no listener can act on.
  const title = job.identity?.title ?? null
  const bay = spokenBay(input.slot)

  if (job.state === "needs_attention") {
    return bay === null
      ? "A disc needs attention. Rip Deck did not rip it."
      : `${
          bay.charAt(0).toUpperCase() + bay.slice(1)
        } needs attention. Rip Deck did not rip that disc.`
  }

  if (job.state !== "completed") {
    const what = title ?? "A disc"
    const where = bay === null ? "" : ` in ${bay}`

    return `${what} failed to rip${where}. It may need a look.`
  }

  const health = toLegacyHealth(verdict.kind)

  if (health === "slow" || health === "very_slow") {
    const what = title ?? "that disc"
    const where = bay === null ? "The drive" : `${bay}`

    return (
      `${where.charAt(0).toUpperCase() + where.slice(1)} ` +
      `struggled with ${what}. The disc may need cleaning.`
    )
  }

  return title === null
    ? "A disc finished ripping."
    : `${title} finished ripping.`
}

export const buildRipEventPayload = (input: {
  job: Job
  verdict: Verdict
  /** Display label for the bay, e.g. "07 - Pioneer BDR-211M". */
  driveLabel: string
  /** The bay's slot, for the spoken line. Null when unknown. */
  slot?: number | null
}): RipEventPayload => {
  const { job, verdict, driveLabel } = input

  const isSuccess = job.state === "completed"
  const slot = input.slot ?? null

  return {
    job_id: job.id,
    title: job.identity?.title ?? "Unknown disc",
    result: isSuccess ? "success" : "fail",
    ok: isSuccess,
    disctype: job.identity?.discType ?? "unknown",
    drive: driveLabel,
    health: toLegacyHealth(verdict.kind),
    verdict: verdict.kind,
    verdict_message: verdict.message,
    verdict_action: verdict.action,
    slot,
    spoken_message: buildRipSpokenMessage({
      job,
      verdict,
      slot,
    }),
  }
}

/**
 * The live mid-rip alert payload.
 *
 * Published non-retained to `<base>/drive/<slug>/alert` while a
 * rip is still running. Only `confirmed` verdicts get here —
 * see `isAnnounceable`.
 */
export type DriveAlertPayload = {
  drive: string
  slot: number | null
  verdict: VerdictKind
  action: string
  message: string
  evidence: string[]
  /** Whether letting it keep chugging is reasonable (D4). */
  is_keep_trying_sensible: boolean
}

export const buildDriveAlertPayload = (input: {
  verdict: Verdict
  driveLabel: string
  slot: number | null
}): DriveAlertPayload => ({
  drive: input.driveLabel,
  slot: input.slot,
  verdict: input.verdict.kind,
  action: input.verdict.action,
  message: input.verdict.message,
  evidence: input.verdict.evidence,
  is_keep_trying_sensible:
    input.verdict.isKeepTryingSensible,
})

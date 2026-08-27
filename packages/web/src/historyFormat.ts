import type { IntentName } from "@charcuterie/tokens"

import type { HistoryRip } from "./types"

/**
 * Turning one finished rip into the words on its card.
 *
 * Separate from `format.ts` because every helper in there takes
 * a live `Rip` — a thing with a percentage, an ETA and a
 * throughput-right-now. A finished rip has none of those, and
 * widening those functions to accept both would make each one
 * ask which kind it had before it could say anything.
 *
 * What it does NOT do is compose a sentence about what happened.
 * `outcome_detail` is rip-deck's own, written where the facts
 * that decide it are, and rewriting it here would be the second
 * opinion `LeftoverRips` and `LoadedDiscsBanner` both refuse.
 */

/**
 * What the card calls this rip.
 *
 * Three answers, and the difference between the last two is the
 * whole reason `is_named` is on the wire:
 *
 *  - a name, when one was read off the disc;
 *  - *"Disc not identified"* — rip-deck was there and could not
 *    read a label, which is a fact about the DISC;
 *  - *"Name not recorded"* — the row was rebuilt from
 *    measurements taken before there was a history log, so
 *    nothing ever wrote a name down. Nothing can recover it
 *    either; `ripHistoryBackfill.ts` records the three routes
 *    that were measured and found dead.
 *
 * A blank for the last two would let the reader assume the disc
 * had no label, which is a claim nobody checked.
 */
export function historyTitle(rip: HistoryRip): string {
  if (rip.disc_name !== null && rip.disc_name !== "") {
    return rip.disc_name
  }

  return rip.is_named
    ? "Disc not identified"
    : "Name not recorded"
}

/** The title is a real disc name, not one of the two stand-ins. */
export function hasHistoryTitle(rip: HistoryRip): boolean {
  return rip.disc_name !== null && rip.disc_name !== ""
}

/**
 * The chip's word, and its colour.
 *
 * ⚠️ **`needs_attention` is NOT a success.** A bay flagged for a
 * human is the "silent success" ARM reports and this project was
 * built to stop reporting (`README.md`, ARM #1298), so it gets
 * its own warning-coloured word rather than being folded into
 * either green or red.
 *
 * ⚠️ **Both functions used to END in the failure branch**, so
 * every kind they did not name painted red and read "Failed".
 * That is how `completed_with_warnings` — added the same day
 * this page shipped, by a change that could not see it — turned
 * a finished, verified backup into the exact red badge the owner
 * asked us to stop showing him. Every kind is now named, and the
 * switch is exhaustive, so the next outcome added to
 * `BayOutcomeKind` fails to compile here instead of silently
 * painting itself red.
 */
export const historyOutcomeText = (
  rip: HistoryRip,
): string => {
  switch (rip.outcome_kind) {
    case "completed":
      return "Finished"
    // Says both halves out loud. "Finished" alone hides the
    // warning on a page that is scanned, and the read-error line
    // beside it is empty whenever the warning came from
    // somewhere else — MakeMKV's own hash check, for one.
    case "completed_with_warnings":
      return "Finished with warnings"
    case "needs_attention":
      return "Flagged"
    case "failed":
    case "no_media":
      return "Failed"
  }
}

export const historyOutcomeIntent = (
  rip: HistoryRip,
): IntentName => {
  switch (rip.outcome_kind) {
    case "completed":
      return "success"
    // Amber, not green and not red: the backup EXISTS, so red is
    // a lie, and it is not clean, so green is the swallow this
    // project exists to prevent.
    case "completed_with_warnings":
    case "needs_attention":
      return "warning"
    case "failed":
    case "no_media":
      return "danger"
  }
}

/**
 * When it finished, as a date and a time.
 *
 * The reason this page exists is "check by date", so the DATE
 * leads and it is never relative: "3 days ago" is unusable for
 * matching a rip against a stack of discs on the desk.
 */
export function historyFinishedText(
  rip: HistoryRip,
  locale?: string,
): string {
  return new Date(rip.finished_at_ms).toLocaleString(
    locale,
    {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    },
  )
}

/** How long it took, e.g. "1h31m". Blank when nothing timed it. */
export function historyDurationText(
  rip: HistoryRip,
): string {
  if (rip.duration_ms === null || rip.duration_ms <= 0) {
    return ""
  }

  const minutes = Math.round(rip.duration_ms / 60_000)

  if (minutes < 1) return "under a minute"
  if (minutes < 60) return `${String(minutes)}m`

  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60

  return `${String(hours)}h${
    remainder > 0 ? `${String(remainder)}m` : ""
  }`
}

/**
 * The disc's size, in GB.
 *
 * GB and not GiB: it is the unit on the box the disc came in,
 * and `watcher.formatBytes` already answers this way everywhere
 * else in the product. One unit per concept.
 */
export function historySizeText(rip: HistoryRip): string {
  if (rip.size_bytes === null || rip.size_bytes <= 0)
    return ""

  return `${(rip.size_bytes / 1024 ** 3).toFixed(1)} GB`
}

/**
 * The read rate the DRIVE was measured at, in MB/s.
 *
 * ⚠️ Not "average", and the word was removed deliberately. What
 * the daemon sends is the MEDIAN of the kernel's own per-sample
 * rates (`driveThroughputP50BytesPerSec`), so calling it an
 * average would be a small untrue claim about a number somebody
 * might compare against a drive's spec sheet.
 *
 * It also used to be `size / duration`, which is only valid if
 * the whole disc was read — see `historyEndpoint.joinJob` for
 * the 77186.5 MB/s that shipped.
 */
export function historyThroughputText(
  rip: HistoryRip,
): string {
  if (
    rip.throughput_bytes_per_sec === null ||
    rip.throughput_bytes_per_sec <= 0
  ) {
    return ""
  }

  // MB/s, not GB/s: real rips run at 15–25 MB/s, so a GB/s
  // figure would read "0.0" for every disc on this tower.
  return `${(
    rip.throughput_bytes_per_sec / 1024 ** 2
  ).toFixed(1)} MB/s`
}

/**
 * The read-error line, or nothing.
 *
 * ⚠️ Rendered on SUCCESSFUL rips too, and that is the point. A
 * rip that finished while the drive logged read errors is the
 * exact case ARM calls a clean success
 * ([#1298](https://github.com/automatic-ripping-machine/automatic-ripping-machine/issues/1298));
 * the green chip beside this must never be allowed to swallow it.
 */
export function historyReadErrorText(
  rip: HistoryRip,
): string {
  if (
    rip.read_error_count === null ||
    rip.read_error_count === 0
  ) {
    return ""
  }

  return rip.read_error_count === 1
    ? "1 read error"
    : `${String(rip.read_error_count)} read errors`
}

/** Where the bay was, as a label a human recognises. */
export function historyBayText(rip: HistoryRip): string {
  return rip.slot === null
    ? rip.bay_name
    : `Slot ${String(rip.slot)} · ${rip.bay_name}`
}

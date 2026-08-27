/**
 * MakeMKV robot-mode (`-r`) output model.
 *
 * Field layouts are taken from real `makemkvcon` output, not
 * from the docs — the docs omit the index prefixes on TINFO /
 * SINFO and undercount DRV. See `parseMakemkvLine` for the
 * scanner and `__fixtures__` for captured samples.
 */

/** `DRV:index,visible,enabled,flags,name,discName,devPath` */
export type DrvEvent = {
  type: "DRV"
  index: number
  visible: number
  enabled: number
  flags: number
  driveName: string
  discName: string
  devicePath: string
}

/**
 * `MSG:code,flags,count,message,format,param0..paramN`
 *
 * `flags` is a bitfield. The one that matters operationally is
 * BOXYESNO — see `isMakemkvPrompt`.
 */
export type MsgEvent = {
  type: "MSG"
  code: number
  flags: number
  count: number
  message: string
  format: string
  params: string[]
}

/** `TCOUNT:count` — number of titles on the disc. */
export type TcountEvent = {
  type: "TCOUNT"
  count: number
}

/** `CINFO:id,code,value` — disc-level attribute. */
export type CinfoEvent = {
  type: "CINFO"
  id: number
  code: number
  value: string
}

/** `TINFO:title,id,code,value` — title-level attribute. */
export type TinfoEvent = {
  type: "TINFO"
  title: number
  id: number
  code: number
  value: string
}

/** `SINFO:title,stream,id,code,value` — stream-level. */
export type SinfoEvent = {
  type: "SINFO"
  title: number
  stream: number
  id: number
  code: number
  value: string
}

/** `PRGC:code,id,name` — the operation running right now. */
export type PrgcEvent = {
  type: "PRGC"
  code: number
  id: number
  name: string
}

/** `PRGT:code,id,name` — the overall operation. */
export type PrgtEvent = {
  type: "PRGT"
  code: number
  id: number
  name: string
}

/**
 * `PRGV:current,total,max` — progress values.
 *
 * `current` tracks the PRGC operation, `total` tracks PRGT, and
 * both are scaled against `max` (not against each other, and
 * `max` is not always 65536 — never assume it).
 */
export type PrgvEvent = {
  type: "PRGV"
  current: number
  total: number
  max: number
}

/** A line we recognised the prefix of but could not parse. */
export type MalformedEvent = {
  type: "MALFORMED"
  prefix: string
  raw: string
  reason: string
}

/** A line with no known robot-mode prefix. */
export type UnknownEvent = {
  type: "UNKNOWN"
  raw: string
}

export type MakemkvEvent =
  | DrvEvent
  | MsgEvent
  | TcountEvent
  | CinfoEvent
  | TinfoEvent
  | SinfoEvent
  | PrgcEvent
  | PrgtEvent
  | PrgvEvent
  | MalformedEvent
  | UnknownEvent

export type MakemkvEventType = MakemkvEvent["type"]

/**
 * MSG codes we act on. Everything else is informational.
 *
 * These drive real control flow, so they are named rather than
 * scattered as magic numbers.
 */
export const MakemkvMsgCode = {
  /**
   * "Copy complete. N titles saved." — N==0 is a FAILURE.
   *
   * ⚠️ `mkv` mode ONLY. `backup` never emits this, and requiring
   * it there reported a perfect 33 GB rip as failed. Captured
   * proof in `makemkv/__fixtures__/real-bluray-backup.robot.log`.
   */
  COPY_COMPLETE: 5004,
  /**
   * "Backup done" — what `backup` emits instead of 5004.
   *
   * Read off the real Stage 3 rip, both of these, in this order.
   * Two codes for the same English string is MakeMKV's business,
   * not a parsing artefact; treat either as completion.
   */
  BACKUP_DONE: 5070,
  BACKUP_DONE_FINAL: 5081,
  /**
   * "Backing up disc into folder %1" — the backup STARTS here.
   *
   * The positional divider of a backup run. Everything before it
   * is MakeMKV opening the disc, reading its structure and
   * negotiating the CSS key; everything after it is the copy.
   * `outcome.ts` uses it to tell a pre-backup probe error from a
   * mid-disc read error, and the two want opposite verdicts.
   */
  BACKUP_STARTED: 5072,
  /**
   * "Backup failed" / "Backup failed." — the failure twins of
   * 5070 / 5081.
   *
   * Two codes for one English string again, in the same order,
   * and both are in this repo's own captures: the four
   * `MSG:5068` runs of 2026-08-26 each ended `MSG:5069` then
   * `MSG:5080`, and exited **0**. Until now nothing read them,
   * so `isRipSuccessful`'s `hasFailureMessage` input had no
   * producer at all.
   */
  BACKUP_FAILED: 5069,
  BACKUP_FAILED_FINAL: 5080,
  /**
   * "Loaded content hash table, will verify integrity of M2TS
   * files."
   *
   * Means this rip is hash-verified by MakeMKV itself, which is
   * stronger evidence than any size check we perform. Blu-ray
   * only — a DVD carries no content hash table, so its absence
   * on a DVD is normal and says nothing.
   *
   * Its failure counterpart is matched by TEXT rather than by
   * code — see `isHashCheckFailureMessage` for why, and for the
   * exact strings read out of the shipped binary.
   */
  BACKUP_HASH_TABLE_LOADED: 5085,
  /** Track saved to file. Marks per-title completion. */
  FILE_ADDED: 3307,
  /** SCSI read error with sense data. */
  READ_ERROR: 2003,
  /** Evaluation period expired. */
  KEY_EXPIRED: 5021,
  /** Registration key expired / invalid. */
  KEY_INVALID: 5052,
  /** Beta key needs updating. */
  KEY_BETA_EXPIRED: 5055,
} as const

/**
 * MakeMKV's `flags` bitfield carries the dialog type in the low
 * bits. `flags & 3854 === 776` is BOXYESNO: makemkvcon is
 * waiting for an interactive answer that a robot-mode pipe will
 * never supply. Treat it as a hang, kill it, and log the
 * question.
 */
export const BOXYESNO_MASK = 3854
export const BOXYESNO_VALUE = 776

export const isMakemkvPrompt = (
  event: MakemkvEvent,
): event is MsgEvent =>
  event.type === "MSG" &&
  (event.flags & BOXYESNO_MASK) === BOXYESNO_VALUE

/**
 * MSG:5004 reports how many titles were saved. Robot mode still
 * exits 0 when that number is zero, which is exactly ARM's
 * silent-success bug (#1298). Parse the count rather than
 * trusting the exit code.
 *
 * The count lives in the params, not the rendered message, so
 * it survives locale changes.
 */
export const parseTitlesSaved = (
  event: MsgEvent,
): number | null => {
  if (event.code !== MakemkvMsgCode.COPY_COMPLETE)
    return null

  for (const param of event.params) {
    const parsed = Number.parseInt(param, 10)
    if (Number.isInteger(parsed)) return parsed
  }

  // Fall back to the rendered message only if params are absent.
  const matched = event.message.match(
    /(\d+)\s+titles?\s+saved/i,
  )
  return matched ? Number.parseInt(matched[1], 10) : null
}

/**
 * The CSS handshake artefact EVERY protected DVD produces.
 *
 * `MSG:2003` is the read-error message, and on a CSS DVD exactly
 * one of them arrives before the copy begins:
 *
 *     MSG:2003,0,3,"Error 'Scsi error - ILLEGAL REQUEST:READ OF
 *     SCRAMBLED SECTOR WITHOUT AUTHENTICATION' occurred while
 *     reading '…' at offset '1048576'"
 *
 * It is MakeMKV probing the disc at 1 MB before `mmgplsrv` has
 * supplied the title key. The probe is SUPPOSED to fail; the
 * drive is telling MakeMKV "this sector is scrambled, you are
 * not authenticated yet", which is how MakeMKV learns the disc
 * is protected. It is not damage, the sector is read correctly a
 * moment later, and it is present in every good DVD rip this
 * repo has captured.
 *
 * Counting it as a read error failed a PERFECT 8 GB DVD backup
 * on 2026-08-27 — `Backup done`, a mounted ISO, and a `fail`
 * badge on the card.
 *
 * ## Why the discriminator is BOTH position and text
 *
 * Position alone ("before `MSG:5072`") is the robust half: a
 * read error that arrives before the copy has started cannot be
 * a defect in the copy. It is also locale-proof, which the text
 * is not — the rendered message is translated, and so is the
 * `format` field beside it.
 *
 * Text alone is the specific half: it names the one SCSI sense
 * this artefact carries, so a GENUINELY unreadable disc that
 * fails during MakeMKV's structure read is not waved through.
 *
 * Requiring both is deliberately conservative in the direction
 * that matters. A mid-disc scrambled-sector error still counts
 * (the position test fails it), and a pre-backup error with any
 * other sense still counts (the text test fails it). Only the
 * exact known-benign combination is dropped.
 */
export const SCRAMBLED_SECTOR_MARKER =
  "READ OF SCRAMBLED SECTOR WITHOUT AUTHENTICATION"

export const isScrambledSectorError = (
  event: MsgEvent,
): boolean =>
  event.code === MakemkvMsgCode.READ_ERROR &&
  [event.message, event.format, ...event.params].some(
    (field) =>
      field.toUpperCase().includes(SCRAMBLED_SECTOR_MARKER),
  )

/** Did the backup reach `MSG:5070` / `MSG:5081`? */
export const isBackupCompleteMessage = (
  event: MsgEvent,
): boolean =>
  event.code === MakemkvMsgCode.BACKUP_DONE ||
  event.code === MakemkvMsgCode.BACKUP_DONE_FINAL

/** Did MakeMKV say the backup failed? */
export const isBackupFailureMessage = (
  event: MsgEvent,
): boolean =>
  event.code === MakemkvMsgCode.BACKUP_FAILED ||
  event.code === MakemkvMsgCode.BACKUP_FAILED_FINAL

/**
 * MakeMKV's own integrity check, when it says it FAILED.
 *
 * ⚠️ **Matched by text, and that is not a lapse of the
 * code-over-string rule — it is the only handle that exists.**
 * No rip in this repo's corpus has ever failed a hash check, so
 * no capture carries the message code. The strings themselves
 * are not guesses: they were read out of the `libmakemkv.so.1`
 * that this image ships (MakeMKV 1.18.4), which is the same
 * catalogue the robot-mode renderer draws from:
 *
 *     "Backup done but %1 files failed hash check"
 *     "Backup done but %1 files failed hash check."
 *     "Hash check failed for file %1 at offset %2, file is corrupt."
 *     "Too many hash check errors in file %1."
 *
 * The pair-of-codes shape ("…" and "….") is 5070/5081 and
 * 5069/5080 again, so these are two more codes MakeMKV has not
 * shown us yet. **Replace this with the codes the first time a
 * capture carries one** — a text match is locale-fragile and a
 * code is not.
 */
const HASH_CHECK_FAILURE_MARKER = "HASH CHECK"

export const isHashCheckFailureMessage = (
  event: MsgEvent,
): boolean => {
  const haystack = `${event.message} ${event.format}`
    .toUpperCase()
    .replaceAll(/\s+/gu, " ")

  return (
    haystack.includes(HASH_CHECK_FAILURE_MARKER) &&
    (haystack.includes("FAILED HASH CHECK") ||
      haystack.includes("HASH CHECK FAILED") ||
      haystack.includes("HASH CHECK ERRORS"))
  )
}

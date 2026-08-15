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
   * "Loaded content hash table, will verify integrity of M2TS
   * files."
   *
   * Means this rip is hash-verified by MakeMKV itself, which is
   * stronger evidence than any size check we perform. Its
   * failure counterpart — "Backup created but hash check failed
   * for %1 files", seen in MakeMKV's own message catalogue — is
   * the corruption signal worth wiring up next; its code is NOT
   * yet known, because no rip has failed a hash check for us to
   * capture.
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

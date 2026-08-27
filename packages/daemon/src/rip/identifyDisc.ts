import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { MakemkvEvent } from "@rip-deck/contracts"
import { parseMakemkvLine } from "../makemkv/parseLine.ts"
import type { MakemkvCommand } from "./ripCommand.ts"

/**
 * Read the disc's own label, scoped to one drive.
 *
 * This is the sanctioned kind of `makemkvcon` call: `--noscan`
 * plus `dev:` scoping, so it touches exactly this drive and
 * never probes a sibling. The unscoped `info disc:9999` form
 * used by `probe` is the opposite — it walks the whole bus, and
 * a single wedged unit can hang it for seventeen minutes, which
 * is why it never appears on a rip path.
 *
 * Stage 3 identification stops at the volume label. Title/year
 * lookup and poster art (B1/B2) are a later stage; what matters
 * now is that the folder gets a name that came from the disc,
 * not one we invented.
 *
 * ## One read is not evidence — this retries a drive that never answered
 *
 * A single `info` call is a coin toss on a marginal bus. On the
 * Tower tower (nine drives down one long active USB extension)
 * the whole bank re-enumerates in bursts — `dmesg` shows
 * `error -71` "device not accepting address" and a cascade of
 * disconnect/reconnect — so `dev:/dev/srN` is intermittently not
 * openable, and makemkvcon returns "Failed to open disc / Unknown
 * device / no usable optical drives" with an empty event stream.
 * A single-shot identify turned ONE such miss into a permanent
 * hold: the disc latched `needs_attention` "could not read a name"
 * and sat in the drive until a human intervened, even though the
 * very next read seconds later returned the label cleanly (proven
 * live on 2026-07-28: attempt 1 empty, attempt 2 "SOYLENT GREEN").
 *
 * So `identifyDisc` now retries — but ONLY the case that a retry
 * can fix. The discriminator is `wasDiscRead`: did makemkvcon
 * actually READ the disc, or only see the drive?
 *
 *  - **The disc was read but there was no name** — a genuinely
 *    blank label. Proven by a `CINFO` block (disc type, name,
 *    language…), which MakeMKV emits only once it has opened the
 *    disc. Deterministic; another read returns the same nothing.
 *    `--name` is the fix, not a retry. NOT retried.
 *  - **makemkvcon could not be spawned** (`spawnFailure`) — a
 *    deployment fault (PATH lost `/opt/makemkv/bin`, 2026-07-26).
 *    The disc was never touched; retrying spawns the same missing
 *    binary. NOT retried.
 *  - **The disc was not read** — no `CINFO` block came back.
 *    Either the device was not openable this instant (the bus
 *    dropout above) OR the drive was listed but its disc had not
 *    finished opening — a UHD disc trailing its own DRV line while
 *    it clears LibreDrive + BD+ decrypt and loads its content-hash
 *    table (proven live on 2026-07-30: "SOYLENT GREEN - UHD" in
 *    slot 9, DRV line present at insert, CINFO seconds later). Both
 *    are transient; both are worth another look. Retried, up to
 *    `maxAttempts`, with a pause between to let the disc open and a
 *    re-enumerating bus settle.
 *
 * The earlier discriminator was `didDeviceRespond` — "did a drive
 * answer" — which mistook the second transient for the first: a
 * populated DRV line looked like a blank disc, so a UHD disc read
 * mid-decrypt latched a permanent hold instead of retrying.
 *
 * The retry is bounded (`IDENTIFY_TUNING.maxAttempts`) and each
 * attempt keeps its own timeout, so a wedged drive costs at most
 * `maxAttempts x timeoutMs` — and this never runs on the poll
 * loop, only on the dispatch pipeline, so a longer identify
 * freezes no other bay.
 *
 * ⚠️ That bound is enforced by the timeout RESOLVING, not by the
 * SIGKILL it sends. Until 2026-08-26 it only signalled, which is
 * not a bound at all against the one failure it was written for:
 * a child in uninterruptible sleep does not die when signalled,
 * so the read never returned and the bound was infinite. See the
 * comment on the timeout itself.
 */

/** CINFO attribute id 2 is the disc name. */
const CINFO_DISC_NAME = 2

/** MakeMKV pads its list to 16 slots with `visible=256`. */
const PADDING_VISIBLE = 256

export const IDENTIFY_TUNING = {
  /**
   * Reads before a no-name result is believed.
   *
   * Three, not two: a re-enumeration burst can span more than one
   * read (the bank drops, re-adds, and settles over a couple of
   * seconds), so a single retry can land inside the same dropout.
   * Three reads with a settle pause between them clear a burst
   * without turning a genuinely-blank disc — which is FINAL on the
   * first read via `wasDiscRead` and never reaches a retry — into
   * three pointless device calls.
   */
  maxAttempts: 3,
  /**
   * Pause between reads, to let a re-enumerating bus settle.
   *
   * Long enough that a retry is not simply the same dropout read
   * again, short enough that three of them are not a wait a person
   * notices. `unref()`d, like every other timer here, so it can
   * never be the reason `rip-deck rip` refuses to exit.
   */
  retryDelayMs: 1_500,
} as const

export type DiscIdentification = {
  /** The volume label, or null when the disc has none. */
  discName: string | null
  /** Every event, for the caller to inspect or log. */
  events: MakemkvEvent[]
  /**
   * Why `makemkvcon` could not be RUN, or null when it ran.
   *
   * Separate from `discName: null` because the two are different
   * facts with different fixes, and collapsing them cost us a
   * live misdiagnosis on 2026-07-26: the daemon was started from
   * a login shell, which resets PATH and drops
   * `/opt/makemkv/bin`, so every spawn died `ENOENT`. This
   * function swallowed it, returned no events, and the watcher
   * announced "could not read a name off this disc" for three
   * discs — including one whose label was plainly
   * `CINFO:2,0,"TROY - BONUS DISC"`.
   *
   * A disc that cannot be named is a disc problem the owner
   * solves with `--name`. A binary that cannot be spawned is a
   * deployment problem no amount of `--name` will fix, and the
   * disc was never read at all. Saying the first when the second
   * is true sends the owner to the tower instead of the config.
   */
  spawnFailure: string | null
}

/**
 * Did makemkvcon actually READ the disc, or only see the drive?
 *
 * The one signal that separates "the disc has no name" from "the
 * disc was not open when we looked". A populated DRV line proves a
 * DRIVE answered — not that its DISC was read: MakeMKV lists the
 * drive the instant the bus enumerates it, well before it has
 * opened the media. A UHD disc must clear LibreDrive + BD+ decrypt
 * and load its content-hash table before any disc info appears, and
 * on the Tower tower's long USB run that can trail the DRV line
 * by seconds — during which an `info` read returns the drive and
 * nothing else.
 *
 * MakeMKV emits a `CINFO` block (disc type, name, language…) only
 * once it has opened the disc, so any CINFO — even one whose name
 * field is blank — is proof the disc WAS read; a genuinely blank
 * label is a CINFO block with no usable name, and THAT a retry
 * cannot change. No CINFO at all means the disc was never opened
 * this instant, and that is the transient worth another look.
 */
export const wasDiscRead = (
  events: MakemkvEvent[],
): boolean => events.some((event) => event.type === "CINFO")

/**
 * A read is FINAL — worth returning as-is, not retrying — when it
 * found a name, hit a spawn fault, or actually read the disc and
 * found it nameless. Only a read that never opened the disc falls
 * through to another attempt. See the header for why each case is
 * what it is.
 */
const isFinalIdentification = (
  identification: DiscIdentification,
): boolean =>
  identification.discName !== null ||
  identification.spawnFailure !== null ||
  wasDiscRead(identification.events)

/**
 * Read until a drive answers, or the attempts run out.
 *
 * Pure over its injected `attempt` and `sleep`, so the retry
 * policy — which fires only on hardware nobody can reproduce on
 * demand — is testable without a drive, the same bargain
 * `decideBayAction` makes in `watcher.ts`. Always makes at least
 * one attempt; checks finality BEFORE sleeping, so a first read
 * that already succeeded pays no delay.
 */
export const retryUntilRead = async (input: {
  attempt: (
    attemptIndex: number,
  ) => Promise<DiscIdentification>
  maxAttempts: number
  delayMs: number
  sleep: (delayMs: number) => Promise<void>
}): Promise<DiscIdentification> => {
  let last = await input.attempt(1)

  for (
    let attempt = 2;
    attempt <= input.maxAttempts;
    attempt += 1
  ) {
    if (isFinalIdentification(last)) return last
    await input.sleep(input.delayMs)
    last = await input.attempt(attempt)
  }

  return last
}

/** Sleep without pinning the event loop — see `unrefTimers.ts`. */
const unrefSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs).unref()
  })

export const identifyDisc = async (input: {
  devPath: string
  makemkv: MakemkvCommand
  timeoutMs?: number
  /** Reads before a no-name result is believed. Default 3. */
  maxAttempts?: number
  /** Pause between reads, in ms. Default 1500. */
  retryDelayMs?: number
}): Promise<DiscIdentification> =>
  retryUntilRead({
    attempt: () => identifyDiscOnce(input),
    maxAttempts:
      input.maxAttempts ?? IDENTIFY_TUNING.maxAttempts,
    delayMs:
      input.retryDelayMs ?? IDENTIFY_TUNING.retryDelayMs,
    sleep: unrefSleep,
  })

/** One scoped `info` call. The retry policy lives in the caller. */
const identifyDiscOnce = async (input: {
  devPath: string
  makemkv: MakemkvCommand
  timeoutMs?: number
}): Promise<DiscIdentification> => {
  const args = [
    ...input.makemkv.prefixArgs,
    "-r",
    "--noscan",
    "--cache=1",
    "info",
    `dev:${input.devPath}`,
  ]

  const outcome = await new Promise<{
    events: MakemkvEvent[]
    spawnFailure: string | null
  }>((resolve) => {
    const collected: MakemkvEvent[] = []
    let isSettled = false
    const child = spawn(input.makemkv.command, args, {
      stdio: ["ignore", "pipe", "ignore"],
    })

    // A scoped info call still talks to the device, so it can
    // block on a drive in SCSI error recovery. Bounded, because
    // an unbounded identification step would reintroduce the
    // exact hang `--noscan` exists to prevent.
    //
    // ⚠️ **The timeout RESOLVES. Signalling the child is not a
    // bound.** SIGKILL is only delivered when the kernel returns
    // from the call the process is blocked in, and a `makemkvcon`
    // talking to a drive in SCSI error recovery is in
    // uninterruptible sleep — so the signal is queued, the child
    // does not die, `close` never fires, and this promise never
    // settles. The bay it belongs to then stays `starting` for as
    // long as the bus stays down, which is unbounded.
    //
    // Measured on the live tower 2026-08-26: five `makemkvcon`
    // children signalled and still unreaped, three `scsi_eh_*`
    // threads in D state, and five bays held `starting` for 75
    // minutes with nothing running. A `starting` bay refuses every
    // tray command *and* the Tower off press, so the one control
    // that clears a wedged bus was disabled by the wedge.
    //
    // The signal is still sent — it lands if the process is
    // killable and costs nothing if it is not — but the ANSWER no
    // longer waits for the child to admit it died. `unref()` goes
    // with it: an unkillable child's handle would otherwise hold
    // the event loop open and block the daemon's own shutdown.
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      child.unref()
      settle({ events: collected, spawnFailure: null })
    }, input.timeoutMs ?? 120_000)

    // Whoever answers first wins, and the losers are no-ops: a
    // child that finally closes minutes after the timeout gave up
    // must not resolve a promise the caller has long since acted
    // on.
    const settle = (outcome: {
      events: MakemkvEvent[]
      spawnFailure: string | null
    }): void => {
      if (isSettled) return
      isSettled = true
      clearTimeout(timeout)
      resolve(outcome)
    }

    createInterface({ input: child.stdout }).on(
      "line",
      (line) => collected.push(parseMakemkvLine(line)),
    )

    // Reported, never swallowed. `spawn` emits `error` when the
    // binary is missing (ENOENT), not executable (EACCES), or the
    // fork itself fails — none of which are facts about the disc.
    child.once("error", (error) => {
      settle({
        events: [],
        spawnFailure: `${input.makemkv.command}: ${error.message}`,
      })
    })
    child.once("close", () => {
      settle({ events: collected, spawnFailure: null })
    })
  })

  return {
    discName: extractDiscName(outcome.events),
    events: outcome.events,
    spawnFailure: outcome.spawnFailure,
  }
}

/**
 * Pull the volume label out of an `info` event stream.
 *
 * Two sources, because neither is reliable alone: `CINFO:2` is
 * the disc name proper but is absent on some discs, while the
 * `DRV` line's disc-name field is populated more often but is
 * empty for a drive MakeMKV padded the list with.
 */
export const extractDiscName = (
  events: MakemkvEvent[],
): string | null => {
  for (const event of events) {
    if (
      event.type === "CINFO" &&
      event.id === CINFO_DISC_NAME &&
      event.value.trim() !== ""
    ) {
      return event.value.trim()
    }
  }

  for (const event of events) {
    if (
      event.type === "DRV" &&
      event.visible !== PADDING_VISIBLE &&
      event.discName.trim() !== ""
    ) {
      return event.discName.trim()
    }
  }

  return null
}

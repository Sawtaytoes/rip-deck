import { apiBase } from "../env"
import { trayReportToActionResult } from "../format"
import type {
  ActionResult,
  RipDeckDataSource,
  RipDeckState,
  TrayCommandReport,
} from "../types"

/**
 * The live data source — rip-deck's own HTTP surface.
 *
 *   GET  /json[?fake=<name>]        -> RipDeckState
 *   GET  /logs?job=<uuid>&lines=<n> -> text/plain capture tail
 *   POST /api/tray                  -> TrayCommandReport
 *
 * The daemon serves this app, `/json` and now the tray endpoint
 * on port 3007, so "same origin" is literal: `apiBase` is "" and
 * these are relative fetches against the page's own host. That is
 * why there is no CORS handling here and no base URL to
 * configure — and it is also the whole argument for `/api/tray`
 * existing. See `types.BayAction`.
 *
 * `mockDataSource` is the development-only alternative, chosen
 * at build time by `isMock`; a production bundle always lands
 * here.
 */

/**
 * Is this body the report both 200 and 400 carry?
 *
 * Structural rather than trusting the status code, because the
 * two statuses that matter answer with the SAME shape and the two
 * that do not (`405`, `503`) answer `{ok, msg}`. Checking the
 * shape means a proxy's HTML error page cannot arrive as a
 * `TrayCommandReport` with every field undefined.
 */
const isTrayCommandReport = (
  body: unknown,
): body is TrayCommandReport => {
  if (typeof body !== "object" || body === null)
    return false

  const candidate = body as Partial<TrayCommandReport>

  return (
    typeof candidate.is_accepted === "boolean" &&
    typeof candidate.message === "string" &&
    Array.isArray(candidate.bays)
  )
}

/** The body, or null when it was not JSON at all. */
const readJsonBody = async (
  response: Response,
): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export const httpDataSource: RipDeckDataSource = {
  async fetchState(fixture) {
    // `?fake=` is forwarded verbatim. The daemon resolves the
    // scenario server-side and stamps `is_fake: true` on the
    // response, which is what makes a fixture impossible to
    // mistake for the rack no matter which mode produced it.
    const query =
      fixture == null
        ? ""
        : `?${new URLSearchParams({ fake: fixture }).toString()}`

    const response = await fetch(
      `${apiBase}/json${query}`,
      // `/json` is a live snapshot of a nine-bay tower. A cached
      // one is a lie with a timestamp on it.
      { cache: "no-store" },
    )

    if (!response.ok) {
      throw new Error(`/json failed: ${response.status}`)
    }

    return (await response.json()) as RipDeckState
  },

  /**
   * The tail of one job's MakeMKV robot capture.
   *
   * ⚠️ A TAIL, and that is the whole design. These files are
   * 1–3 MB (`$RIP_DECK_STATE_DIR/<job_uuid>.robot.log`) and the
   * interesting part of one is the end, so the default asks for
   * the last few hundred lines and `"all"` is the explicit
   * opt-in. Reading a 3 MB log is not something a page should do
   * because somebody clicked a button labelled "Logs".
   *
   * A non-2xx is the daemon SAYING something — "no capture for
   * that job", "no such job" — so its body is surfaced rather
   * than swallowed for a bare status code. (It used to answer
   * 501 unconditionally, which is why this reads the body at
   * all; the habit is worth keeping now that the failures are
   * real ones.)
   */
  async fetchLog(jobUuid, lines = 600) {
    const params = new URLSearchParams({ job: jobUuid })

    // ⚠️ `all=1` REPLACES `lines` rather than joining it —
    // sending both would ask for the last 600 lines of the whole
    // file, which is a contradiction the daemon would have to
    // pick a winner for. A daemon that does not know `all` falls
    // back to its own default tail, so a caller offering "load
    // all" must not promise the operator it got everything.
    if (lines === "all") {
      params.set("all", "1")
    } else {
      params.set("lines", String(lines))
    }

    const response = await fetch(
      `${apiBase}/logs?${params.toString()}`,
    )

    if (!response.ok) {
      throw new Error(
        `/logs failed: ${response.status} ${await response.text()}`,
      )
    }

    return await response.text()
  },

  /**
   * The five JOB actions, which still have nowhere to go.
   *
   * ⚠️ This function used to refuse a TRAY command here too,
   * with the sentence the owner read on the live page: *"No REST
   * endpoint for this, by design — tray commands go over
   * MQTT."* That was wrong. The house rule is about
   * service-to-service integration, not about a page talking to
   * the daemon that served it, and widening it into a capability
   * ban is the third time this project has done that
   * (`docs/HANDOFF-stage7-ui-and-naming.md` §2). Tray commands
   * now go to `runTrayCommand` below, and a press moves a drawer.
   *
   * What is left is genuinely unbuilt, and the refusal now says
   * so accurately. `cancel`, `keep_trying`, `give_up`,
   * `clear_quarantine` and `retry_in_another_drive` have **no
   * transport at all** — not REST and NOT MQTT either, which the
   * previous message got backwards: `cmd/drive` is the only
   * inbound topic and `parseTrayCommand` accepts only the four
   * tray words, so publishing `cancel` there gets an explicit
   * rejection. There is nothing to paste.
   *
   * The control stays ENABLED rather than greyed out. A disabled
   * button has nowhere to put the reason at the moment somebody
   * wants it — and this refusal now names the one honest way to
   * stop a rip, which beats a button that quietly does nothing.
   */
  runBayAction({ driveId, action }) {
    // Tray words are routed rather than refused: `bayActionsFor`
    // still hands them to `useBayActions` today, and answering
    // them here means the existing per-bay control works the
    // moment this ships, without waiting on the UI units that
    // own the ⏏ toggle. `useTrayCommand` is the richer seam and
    // is what a new caller should use — this is the bridge, not
    // the destination.
    if (action === "open_bay" || action === "close_bay") {
      return httpDataSource
        .runTrayCommand({ command: action, driveId })
        .then((report) =>
          trayReportToActionResult({ driveId, report }),
        )
        .catch((error: unknown) => ({
          ok: false,
          msg: String(error),
        }))
    }

    const result: ActionResult = {
      ok: false,
      msg:
        `${action} on ${driveId} has no transport yet — ` +
        "Rip Deck serves no endpoint for it and `cmd/drive` " +
        "takes only tray commands. To stop a rip, open the " +
        "bay's tray (⏏) or restart the daemon; nothing else " +
        "reaches a running job today.",
    }

    return Promise.resolve(result)
  },

  /**
   * Move a tray, over the daemon's own write endpoint.
   *
   * `POST /api/tray` calls the same in-process
   * `watcher.runTrayCommand` the MQTT path calls, so the refusal
   * that protects a running rip (`decideTrayBayAction`'s first
   * branch) is authoritative on this path too — this function
   * cannot route around it and does not try. `cmd/drive` keeps
   * working unchanged; the physical button uses it.
   *
   * Body is the daemon's own `cmd/drive` JSON, so what the UI
   * sends and what an operator would publish are one payload.
   *
   * ⚠️ NO `cache: "no-store"` and no retry. It is a POST, so it
   * is not cached — and a tray command retried on a timeout is a
   * drawer that opens twice, or one that opens after the
   * operator gave up and walked over. One press, one command.
   */
  async runTrayCommand({ command, driveId, name }) {
    const response = await fetch(`${apiBase}/api/tray`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command,
        ...(driveId === undefined
          ? {}
          : { drive_id: driveId }),
        // Sent only when there is one. The daemon reads a blank
        // `name` as "no name given" either way, but omitting it
        // keeps a Try-again press byte-identical to what an
        // operator would publish on `cmd/drive` by hand.
        ...(name === undefined || name === ""
          ? {}
          : { name }),
      }),
    })

    const body = await readJsonBody(response)

    // 200 and 400 both carry a report, and a REFUSAL is a
    // result rather than an error: "this bay is ripping, nothing
    // was touched" is the most important sentence this endpoint
    // can say, and throwing it would strand it in a catch block
    // as a stringified Error.
    if (isTrayCommandReport(body)) return body

    // Everything else is the endpoint not answering: 405 from a
    // daemon too old to have it, 503 while the watcher is not
    // up, or a proxy page that is not JSON at all.
    const detail =
      typeof (body as { msg?: unknown })?.msg === "string"
        ? (body as { msg: string }).msg
        : response.statusText

    throw new Error(
      `/api/tray failed: ${response.status} ${detail}`,
    )
  },
}

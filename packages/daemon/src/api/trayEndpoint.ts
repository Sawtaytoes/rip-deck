import {
  buildTrayCommandRejection,
  parseTrayCommand,
  type TrayCommandRequest,
  type TrayCommandResponsePayload,
} from "../rip/trayCommand.ts"

/**
 * `POST /api/tray` — the dashboard moving its own daemon's trays.
 *
 * ## Why this is not the MQTT rule being broken
 *
 * The house rule is *"services talk to each other over MQTT — not
 * new REST/shell bridges"*, and it is about **service-to-service**
 * integration: nobody may build a bespoke HTTP bridge so Home
 * Assistant can poke rip-deck. Rip Deck's own dashboard calling
 * Rip Deck's own daemon is not two services — it is one
 * application's UI talking to its own backend, same origin, same
 * port that already serves `/json`. No bridge exists and nothing
 * else in the house gains a dependency.
 *
 * The owner pressed **Open tray** and got a red box refusing him
 * on those grounds. That refusal was wrong, and it was the third
 * time on this project a narrow rule was widened into a
 * capability ban (`docs/HANDOFF-stage7-ui-and-naming.md` §2).
 * When you cite a rule, read the rule.
 *
 * ## Why there is no second implementation here
 *
 * There is exactly ONE command path to a drive and it is
 * `watcher.runTrayCommand` — the same function `cmd/drive` calls.
 * This module reads an HTTP body and hands it over; it decides
 * nothing about which bay moves. In particular:
 *
 * ⚠️ **The refusal stays in the daemon.** `decideTrayBayAction`
 * refuses a `starting`/`ripping` bay as its FIRST branch, for
 * every command kind. The HTTP path goes THROUGH that, never
 * around it, so a UI bug cannot open a tray mid-rip.
 *
 * The body is fed to `parseTrayCommand` — the same parser
 * `cmd/drive` uses — so the two callers accept exactly the same
 * words, and a rejection is `buildTrayCommandRejection`, the same
 * payload `resp/drive` publishes. One shape serves both.
 */

/**
 * The watcher's tray command, narrowed to what HTTP needs.
 *
 * Deliberately the function rather than the whole watcher handle:
 * the API has no business reading the bay table or stopping rips,
 * and a narrow injection is one that cannot grow into either.
 * Structurally identical to `RunningWatcher["runTrayCommand"]`.
 */
export type TrayCommandRunner = (input: {
  request: TrayCommandRequest
  requestId?: string | null
}) => Promise<TrayCommandResponsePayload>

export type TrayEndpointResult = {
  status: number
  payload: TrayCommandResponsePayload
}

/**
 * What a tray POST means with no watcher in this process.
 *
 * A real runtime state, not a bug: the API can be served without
 * `rip-deck watch` supervising anything, and then there is no bay
 * table, no bus probe and nothing that may touch a drive. 503
 * rather than 501 — the endpoint exists, this process just
 * cannot answer it right now.
 */
const NO_WATCHER_REASON =
  "no watcher is attached to this process, so nothing here " +
  "may touch a drive. Tray commands need `rip-deck watch`."

export const handleTrayCommandRequest = async (input: {
  /** The raw POST body, exactly as `cmd/drive` would see it. */
  body: string
  runTrayCommand: TrayCommandRunner | null
  nowMs: number
}): Promise<TrayEndpointResult> => {
  const parsed = parseTrayCommand(input.body)

  if (!parsed.isValid) {
    return {
      status: 400,
      payload: buildTrayCommandRejection({
        requestId: parsed.requestId,
        reason: parsed.reason,
        atMs: input.nowMs,
      }),
    }
  }

  if (input.runTrayCommand === null) {
    return {
      status: 503,
      payload: buildTrayCommandRejection({
        requestId: parsed.requestId,
        reason: NO_WATCHER_REASON,
        atMs: input.nowMs,
      }),
    }
  }

  try {
    return {
      status: 200,
      payload: await input.runTrayCommand({
        request: parsed.request,
        requestId: parsed.requestId,
      }),
    }
  } catch (error) {
    // The same rule `mqtt/watchMqtt.ts` follows on this path: a
    // tray command that reports NOTHING is the bug this feature
    // exists to prevent. An operator who pressed a button and
    // saw nothing cannot tell a broken button from a broken
    // daemon, so a throw becomes a legible rejection payload.
    return {
      status: 500,
      payload: buildTrayCommandRejection({
        requestId: parsed.requestId,
        reason:
          error instanceof Error
            ? error.message
            : String(error),
        atMs: input.nowMs,
      }),
    }
  }
}

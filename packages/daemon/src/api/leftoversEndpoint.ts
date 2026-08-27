import {
  deleteLeftover,
  type Leftover,
  scanLeftovers,
} from "../rip/leftovers.ts"

/**
 * `GET /api/leftovers` and `POST /api/leftovers` — the folders a
 * rip left behind, and the button that clears one.
 *
 * ## Why this is not on `/json`
 *
 * Every other tower fact rides the 5-second snapshot. This one
 * does not, and deliberately: answering it means walking each
 * leftover's tree to size it, and a half-finished UHD rip is
 * 40 GB of `stat` calls. Folding that into the poll would put a
 * filesystem walk between the browser and the bay table twelve
 * times a minute, for a panel nobody has open.
 *
 * So it is on demand. The dashboard asks when the panel is shown
 * and again after a delete, and an idle dashboard costs nothing.
 *
 * ## Why the daemon deletes rather than the dashboard
 *
 * Same argument as `POST /api/tray`: this is one application's UI
 * talking to its own backend, on the same origin and the same
 * port that already serves `/json`. No new service-to-service
 * bridge exists and nothing else in the house gains a dependency.
 *
 * ⚠️ **The refusal lives in `refusalToDeleteLeftover`, not here.**
 * This module reads an HTTP body and hands the path over; it
 * decides nothing about what may be removed. That matters more
 * than usual — the target dataset holds 700-odd finished rips,
 * and the validation is the only thing between an HTTP body and
 * `rm -rf`.
 */

/**
 * One leftover as the wire carries it.
 *
 * snake_case, because every other JSON this server emits is —
 * `TowerView` sets the convention and a second style on the same
 * origin is a trap for whoever writes the next consumer.
 */
export type LeftoverView = {
  path: string
  name: string
  kind: Leftover["kind"]
  occupied_name: string | null
  size_bytes: number
  disc_structure: string | null
  modified_at_ms: number
  detail: string
  is_safe_to_delete: boolean
}

const buildLeftoverView = (
  leftover: Leftover,
): LeftoverView => ({
  path: leftover.path,
  name: leftover.name,
  kind: leftover.kind,
  occupied_name: leftover.occupiedName,
  size_bytes: leftover.sizeBytes,
  disc_structure: leftover.discStructure,
  modified_at_ms: leftover.modifiedAtMs,
  detail: leftover.detail,
  is_safe_to_delete: leftover.isSafeToDelete,
})

const listLeftovers = async (
  destinationRoot: string,
): Promise<LeftoverView[]> =>
  (await scanLeftovers({ rootPath: destinationRoot })).map(
    buildLeftoverView,
  )

export type LeftoversListPayload = {
  ok: true
  leftovers: LeftoverView[]
}

export type LeftoversDeletePayload = {
  ok: boolean
  msg: string
  /** The remaining leftovers, so the panel needs no refetch. */
  leftovers: LeftoverView[]
}

export type LeftoversEndpointResult = {
  status: number
  payload:
    | LeftoversListPayload
    | LeftoversDeletePayload
    | { ok: false; msg: string }
}

export const handleLeftoversList = async (input: {
  destinationRoot: string
}): Promise<LeftoversEndpointResult> => ({
  status: 200,
  payload: {
    ok: true,
    leftovers: await listLeftovers(input.destinationRoot),
  },
})

/**
 * What a delete POST means.
 *
 * The body mirrors `POST /api/tray`'s shape — a `command` field
 * naming the verb — so the two write endpoints read the same way
 * from the dashboard and from `curl`.
 */
export const handleLeftoversDelete = async (input: {
  body: string
  destinationRoot: string
}): Promise<LeftoversEndpointResult> => {
  const parsed = parseDeleteBody(input.body)

  if (typeof parsed === "string") {
    return {
      status: 400,
      payload: { ok: false, msg: parsed },
    }
  }

  const outcome = await deleteLeftover({
    rootPath: input.destinationRoot,
    path: parsed.path,
  })

  return {
    // A refusal is 400, not 500: the request was understood and
    // answered, and the answer is "not that one".
    status: outcome.isDeleted ? 200 : 400,
    payload: {
      ok: outcome.isDeleted,
      msg: outcome.message,
      leftovers: await listLeftovers(input.destinationRoot),
    },
  }
}

/** The parsed body, or the sentence explaining why not. */
export const parseDeleteBody = (
  body: string,
): { path: string } | string => {
  let payload: unknown

  try {
    payload = JSON.parse(body === "" ? "{}" : body)
  } catch {
    return "the body is not JSON."
  }

  if (typeof payload !== "object" || payload === null) {
    return "the body is not a JSON object."
  }

  const record = payload as Record<string, unknown>

  if (record.command !== "delete") {
    return (
      'no `command: "delete"` in the payload. That is the ' +
      "only command this endpoint accepts."
    )
  }

  const path = record.path

  if (typeof path !== "string" || path.trim() === "") {
    return (
      "no `path` in the payload. Name the leftover to clear, " +
      "exactly as `GET /api/leftovers` reported it."
    )
  }

  return { path }
}

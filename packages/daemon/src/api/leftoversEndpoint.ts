import {
  deleteLeftover,
  type Leftover,
  renameLeftover,
  scanLeftovers,
} from "../rip/leftovers.ts"

/**
 * `GET /api/leftovers` and `POST /api/leftovers` — the folders a
 * rip left behind, and the two controls that resolve one.
 *
 * ## One route, two verbs
 *
 * `POST` carries a `command`, which is `"delete"` or `"rename"`.
 * A second pathname was the alternative and it buys nothing: both
 * verbs take the same target, answer with the same remaining
 * list, and share every one of their refusal rules. `POST
 * /api/tray` already reads its verb out of a `command` field, so
 * this is the shape a reader of this server has already met.
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

/**
 * What a write answers with, whichever verb it was.
 *
 * One shape for both, because the panel does one thing with it
 * either way: render `msg` and redraw from `leftovers`. A rename
 * that succeeds still changes the list — the row keeps its place
 * but not its name — so it carries the fresh list for the same
 * reason a delete does.
 */
export type LeftoversWritePayload = {
  ok: boolean
  msg: string
  /** The remaining leftovers, so the panel needs no refetch. */
  leftovers: LeftoverView[]
}

/** @deprecated The delete-only name for `LeftoversWritePayload`. */
export type LeftoversDeletePayload = LeftoversWritePayload

export type LeftoversEndpointResult = {
  status: number
  payload:
    | LeftoversListPayload
    | LeftoversWritePayload
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

/**
 * Rename one leftover, in place.
 *
 * ⚠️ **Every rule is in `renameLeftover`, not here.** This reads
 * a body and hands two strings over; it decides nothing about
 * what may be renamed or what the result may be called. Same
 * split as the delete above it, and it matters for the same
 * reason — the target dataset holds 700-odd finished rips.
 */
export const handleLeftoversRename = async (input: {
  body: string
  destinationRoot: string
}): Promise<LeftoversEndpointResult> => {
  const parsed = parseRenameBody(input.body)

  if (typeof parsed === "string") {
    return {
      status: 400,
      payload: { ok: false, msg: parsed },
    }
  }

  const outcome = await renameLeftover({
    newName: parsed.new_name,
    path: parsed.path,
    rootPath: input.destinationRoot,
  })

  return {
    // A refusal is 400 for the same reason a refused delete is:
    // the request was understood and answered, and the answer is
    // "not to that name".
    status: outcome.isRenamed ? 200 : 400,
    payload: {
      ok: outcome.isRenamed,
      msg: outcome.message,
      leftovers: await listLeftovers(input.destinationRoot),
    },
  }
}

/**
 * Which verb a POST names, or the sentence explaining why none.
 *
 * Wrapped in an object rather than returned bare, so the failure
 * branch is a plain `string` and the success branch is not — the
 * same `T | string` idiom every `parse*Body` below uses, and the
 * only spelling a union of two literals and `string` does not
 * collapse into.
 *
 * A peek, on purpose. Each `parse*Body` still parses the whole
 * body and still refuses a command that is not its own, so a
 * caller reaching `handleLeftoversDelete` directly — a test, a
 * future route — keeps the guarantee it had before rename
 * existed. The cost is parsing a few hundred bytes of JSON
 * twice, once per operator button press.
 */
export const readLeftoversCommand = (
  body: string,
): { command: "delete" | "rename" } | string => {
  let payload: unknown

  try {
    payload = JSON.parse(body === "" ? "{}" : body)
  } catch {
    return "the body is not JSON."
  }

  if (typeof payload !== "object" || payload === null) {
    return "the body is not a JSON object."
  }

  const command = (payload as Record<string, unknown>)
    .command

  return command === "delete" || command === "rename"
    ? { command }
    : 'no `command: "delete"` or `command: "rename"` in the ' +
        "payload. Those are the only commands this endpoint " +
        "accepts."
}

/**
 * Dispatch one POST to its verb.
 *
 * The router calls this rather than either handler, so adding a
 * third verb never touches the router again.
 */
export const handleLeftoversWrite = async (input: {
  body: string
  destinationRoot: string
}): Promise<LeftoversEndpointResult> => {
  const read = readLeftoversCommand(input.body)

  if (typeof read === "string") {
    return {
      status: 400,
      payload: { ok: false, msg: read },
    }
  }

  return read.command === "delete"
    ? handleLeftoversDelete(input)
    : handleLeftoversRename(input)
}

/**
 * The parsed rename body, or the sentence explaining why not.
 *
 * `new_name` is snake_case like every other field this server
 * reads and writes. `LeftoverView` sets that convention and a
 * second style on one origin is a trap for whoever writes the
 * next consumer.
 */
export const parseRenameBody = (
  body: string,
): { path: string; new_name: string } | string => {
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

  if (record.command !== "rename") {
    return (
      'no `command: "rename"` in the payload. That is the ' +
      "only command this endpoint accepts."
    )
  }

  const path = record.path

  if (typeof path !== "string" || path.trim() === "") {
    return (
      "no `path` in the payload. Name the leftover to " +
      "rename, exactly as `GET /api/leftovers` reported it."
    )
  }

  const newName = record.new_name

  if (
    typeof newName !== "string" ||
    newName.trim() === ""
  ) {
    return (
      "no `new_name` in the payload. Say what the leftover " +
      "should be called."
    )
  }

  return { new_name: newName, path }
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

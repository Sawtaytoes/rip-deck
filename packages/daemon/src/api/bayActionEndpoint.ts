import type { BayAction } from "./towerView.ts"

/** A job control the dashboard may send to its own daemon. */
export type BayActionRequest = {
  driveId: string
  action: BayAction
}

export type BayActionResponse = {
  ok: boolean
  msg: string
}

/** The narrow control surface the HTTP API receives from a watcher. */
export type BayActionRunner = (
  request: BayActionRequest,
) => Promise<BayActionResponse>

const ACTIONS: readonly BayAction[] = [
  "clear_quarantine",
  "keep_trying",
  "give_up",
  "retry_in_another_drive",
  "cancel",
]

const isBayAction = (value: unknown): value is BayAction =>
  typeof value === "string" &&
  ACTIONS.includes(value as BayAction)

/**
 * `POST /api/bay-action` — job controls from Rip Deck's own page.
 *
 * This is intentionally separate from `/api/tray`: tray commands have a
 * shared MQTT vocabulary, while these are job-state operations and must not
 * be smuggled into a command parser that correctly rejects them.
 */
export const handleBayActionRequest = async (input: {
  body: string
  runBayAction: BayActionRunner | null
}): Promise<{
  status: number
  payload: BayActionResponse
}> => {
  let body: unknown

  try {
    body = JSON.parse(input.body) as unknown
  } catch {
    return {
      status: 400,
      payload: {
        ok: false,
        msg: "Bay action body must be JSON.",
      },
    }
  }

  if (typeof body !== "object" || body === null) {
    return {
      status: 400,
      payload: {
        ok: false,
        msg: "Bay action body must be an object.",
      },
    }
  }

  const request = body as {
    action?: unknown
    drive_id?: unknown
  }

  if (!isBayAction(request.action)) {
    return {
      status: 400,
      payload: {
        ok: false,
        msg: "Bay action is not recognised.",
      },
    }
  }

  if (
    typeof request.drive_id !== "string" ||
    request.drive_id.trim() === ""
  ) {
    return {
      status: 400,
      payload: {
        ok: false,
        msg: "Bay action needs a drive_id.",
      },
    }
  }

  if (input.runBayAction === null) {
    return {
      status: 503,
      payload: {
        ok: false,
        msg: "no watcher is attached to this process, so no bay can be controlled.",
      },
    }
  }

  try {
    return {
      status: 200,
      payload: await input.runBayAction({
        action: request.action,
        driveId: request.drive_id,
      }),
    }
  } catch (error) {
    return {
      status: 500,
      payload: {
        ok: false,
        msg:
          error instanceof Error
            ? error.message
            : String(error),
      },
    }
  }
}

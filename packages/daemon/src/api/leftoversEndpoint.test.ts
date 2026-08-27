import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  type LiveRips,
  NO_LIVE_RIPS,
} from "../rip/liveRips.ts"
import {
  handleLeftoversDelete,
  handleLeftoversList,
  handleLeftoversRename,
  handleLeftoversWrite,
  parseDeleteBody,
  parseRenameBody,
  readLeftoversCommand,
} from "./leftoversEndpoint.ts"

describe("reading a delete request", () => {
  it("takes the path out of a well-formed body", () => {
    expect(
      parseDeleteBody(
        JSON.stringify({
          command: "delete",
          path: "/media/Disc-Rips/.rip-deck-incomplete-abc",
        }),
      ),
    ).toEqual({
      path: "/media/Disc-Rips/.rip-deck-incomplete-abc",
    })
  })

  it("refuses a body that is not JSON", () => {
    expect(parseDeleteBody("not json")).toContain(
      "not JSON",
    )
  })

  it("⚠️ refuses any command other than delete", () => {
    // One verb. A second one arriving by accident — a copied
    // `/api/tray` body, say — must not be read as a delete.
    expect(
      parseDeleteBody(
        JSON.stringify({
          command: "open_trays",
          path: "/x",
        }),
      ),
    ).toContain('`command: "delete"`')
  })

  it("refuses a delete with no path, by name", () => {
    expect(
      parseDeleteBody(
        JSON.stringify({ command: "delete" }),
      ),
    ).toContain("no `path`")
  })

  it("refuses an empty body rather than defaulting one", () => {
    // The router sends "" when a caller offers no body reader.
    expect(parseDeleteBody("")).toContain(
      '`command: "delete"`',
    )
  })
})

describe("listing and clearing over HTTP", () => {
  const tmpRoot = join(
    tmpdir(),
    `rip-deck-leftovers-http-${process.pid}`,
  )

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it("lists what is there and clears one on request", async () => {
    await mkdir(
      join(tmpRoot, ".rip-deck-incomplete-http-1"),
      {
        recursive: true,
      },
    )
    await mkdir(join(tmpRoot, "[BACKUP] Kept Rip - DVD"), {
      recursive: true,
    })

    const listed = await handleLeftoversList({
      readLiveRips: async () => NO_LIVE_RIPS,
      destinationRoot: tmpRoot,
    })
    expect(listed.status).toBe(200)
    expect(
      "leftovers" in listed.payload
        ? listed.payload.leftovers.map((one) => one.name)
        : [],
    ).toEqual([".rip-deck-incomplete-http-1"])

    const deleted = await handleLeftoversDelete({
      readLiveRips: async () => NO_LIVE_RIPS,
      destinationRoot: tmpRoot,
      body: JSON.stringify({
        command: "delete",
        path: join(tmpRoot, ".rip-deck-incomplete-http-1"),
      }),
    })

    expect(deleted.status).toBe(200)
    expect(deleted.payload.ok).toBe(true)
    // The response carries the remaining list, so the panel
    // needs no second round trip to redraw.
    expect(
      "leftovers" in deleted.payload
        ? deleted.payload.leftovers
        : null,
    ).toEqual([])
  })

  /**
   * ⚠️ **The live-rip guard, seen from HTTP.**
   *
   * The list and the two verbs all take the SAME `readLiveRips`,
   * so a row the panel shows as locked is a row the endpoint
   * refuses, and neither can drift from the other.
   */
  it("⚠️ locks a folder a live rip is writing into", async () => {
    const jobUuid = "4d37d72e-7f72-4cee-a82b-7af82c10bfd3"
    const name = `.rip-deck-incomplete-${jobUuid}`
    await mkdir(join(tmpRoot, name), { recursive: true })

    const readLiveRips = async (): Promise<LiveRips> => ({
      isKnown: true,
      jobUuids: new Set([jobUuid]),
    })

    const listed = await handleLeftoversList({
      destinationRoot: tmpRoot,
      readLiveRips,
    })

    const row =
      "leftovers" in listed.payload
        ? listed.payload.leftovers.find(
            (one) => one.name === name,
          )
        : undefined

    expect(row?.is_locked).toBe(true)
    expect(row?.is_safe_to_delete).toBe(false)
    expect(row?.lock_reason).toContain(jobUuid)

    const refusedDelete = await handleLeftoversDelete({
      body: JSON.stringify({
        command: "delete",
        path: join(tmpRoot, name),
      }),
      destinationRoot: tmpRoot,
      readLiveRips,
    })

    expect(refusedDelete.status).toBe(400)
    expect(refusedDelete.payload.ok).toBe(false)
    // Still listed, because nothing was removed.
    expect(
      "leftovers" in refusedDelete.payload
        ? refusedDelete.payload.leftovers.map(
            (one) => one.name,
          )
        : [],
    ).toContain(name)

    const refusedRename = await handleLeftoversRename({
      body: JSON.stringify({
        command: "rename",
        new_name: "[BACKUP] Not While It Runs",
        path: join(tmpRoot, name),
      }),
      destinationRoot: tmpRoot,
      readLiveRips,
    })

    expect(refusedRename.status).toBe(400)
    expect(
      "msg" in refusedRename.payload
        ? refusedRename.payload.msg
        : "",
    ).toContain("writing into this folder")

    await rm(join(tmpRoot, name), {
      recursive: true,
      force: true,
    })
  })

  it("⚠️ refuses when this process cannot see the rips", async () => {
    // A router built with no `readLiveRips` is on the UNKNOWN
    // default, and unknown fails closed. Better a refusal for
    // the second or two before the watcher is up than a delete
    // during it.
    await mkdir(
      join(tmpRoot, ".rip-deck-incomplete-unknown-1"),
      { recursive: true },
    )

    const refused = await handleLeftoversDelete({
      body: JSON.stringify({
        command: "delete",
        path: join(
          tmpRoot,
          ".rip-deck-incomplete-unknown-1",
        ),
      }),
      destinationRoot: tmpRoot,
      readLiveRips: async () => ({
        isKnown: false,
        reason: "this API process was not told",
      }),
    })

    expect(refused.status).toBe(400)
    expect(
      "msg" in refused.payload ? refused.payload.msg : "",
    ).toContain("cannot tell which rips")

    await rm(
      join(tmpRoot, ".rip-deck-incomplete-unknown-1"),
      { recursive: true, force: true },
    )
  })

  it("⚠️ answers 400 rather than deleting a finished rip", async () => {
    // The request was understood and answered. It is not a
    // server fault, and it must not be a success either.
    const refused = await handleLeftoversDelete({
      readLiveRips: async () => NO_LIVE_RIPS,
      destinationRoot: tmpRoot,
      body: JSON.stringify({
        command: "delete",
        path: join(tmpRoot, "[BACKUP] Kept Rip - DVD"),
      }),
    })

    expect(refused.status).toBe(400)
    expect(refused.payload.ok).toBe(false)
    expect(refused.payload).toHaveProperty("msg")
  })
})

describe("reading a rename request", () => {
  it("takes the path and the new name out of a well-formed body", () => {
    expect(
      parseRenameBody(
        JSON.stringify({
          command: "rename",
          new_name: "[BACKUP] TMNT Season 4 Disc 2 - DVD",
          path: "/media/Disc-Rips/x (rip-deck-duplicate-01234567)",
        }),
      ),
    ).toEqual({
      new_name: "[BACKUP] TMNT Season 4 Disc 2 - DVD",
      path: "/media/Disc-Rips/x (rip-deck-duplicate-01234567)",
    })
  })

  it("⚠️ refuses a DELETE body reaching the rename parser", () => {
    // Two verbs on one route. A copied body must never be read
    // as the other verb.
    expect(
      parseRenameBody(
        JSON.stringify({ command: "delete", path: "/x" }),
      ),
    ).toContain('`command: "rename"`')
  })

  it("refuses a rename with no new name, by name", () => {
    expect(
      parseRenameBody(
        JSON.stringify({ command: "rename", path: "/x" }),
      ),
    ).toContain("no `new_name`")
  })

  it("refuses a whitespace-only new name", () => {
    expect(
      parseRenameBody(
        JSON.stringify({
          command: "rename",
          new_name: "   ",
          path: "/x",
        }),
      ),
    ).toContain("no `new_name`")
  })

  it("refuses a rename with no path, by name", () => {
    expect(
      parseRenameBody(
        JSON.stringify({
          command: "rename",
          new_name: "x",
        }),
      ),
    ).toContain("no `path`")
  })
})

describe("picking the verb out of a POST", () => {
  it("reads both commands", () => {
    expect(
      readLeftoversCommand(
        JSON.stringify({ command: "delete" }),
      ),
    ).toEqual({ command: "delete" })
    expect(
      readLeftoversCommand(
        JSON.stringify({ command: "rename" }),
      ),
    ).toEqual({ command: "rename" })
  })

  it("⚠️ names BOTH verbs when neither is there", () => {
    // The sentence is what a `curl` user reads. It has to say
    // what the route accepts, not just what it refused.
    const refusal = readLeftoversCommand(
      JSON.stringify({ command: "open_trays" }),
    )

    expect(refusal).toContain('"delete"')
    expect(refusal).toContain('"rename"')
  })

  it("refuses an empty body rather than defaulting one", () => {
    expect(readLeftoversCommand("")).toContain("delete")
  })

  it("refuses a body that is not JSON", () => {
    expect(readLeftoversCommand("not json")).toContain(
      "not JSON",
    )
  })
})

describe("renaming over HTTP", () => {
  const tmpRoot = join(
    tmpdir(),
    `rip-deck-rename-http-${process.pid}`,
  )

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it("renames through the dispatcher and answers the fresh list", async () => {
    await mkdir(
      join(
        tmpRoot,
        "[BACKUP] TMNT - DVD (rip-deck-duplicate-68fa9004)",
      ),
      { recursive: true },
    )

    const renamed = await handleLeftoversWrite({
      readLiveRips: async () => NO_LIVE_RIPS,
      body: JSON.stringify({
        command: "rename",
        new_name: "[BACKUP] TMNT Season 4 Disc 2 - DVD",
        path: join(
          tmpRoot,
          "[BACKUP] TMNT - DVD (rip-deck-duplicate-68fa9004)",
        ),
      }),
      destinationRoot: tmpRoot,
    })

    expect(renamed.status).toBe(200)
    expect(renamed.payload.ok).toBe(true)
    // Gone from the panel, because the new name is not a
    // leftover's — which is what the operator asked for.
    expect(
      "leftovers" in renamed.payload
        ? renamed.payload.leftovers
        : null,
    ).toEqual([])
  })

  it("⚠️ answers 400 rather than clobbering an existing name", async () => {
    await mkdir(join(tmpRoot, "[BACKUP] Kept - DVD"), {
      recursive: true,
    })
    const marked = join(
      tmpRoot,
      "[BACKUP] Kept - DVD (rip-deck-duplicate-01234567)",
    )
    await mkdir(marked, { recursive: true })

    const refused = await handleLeftoversWrite({
      readLiveRips: async () => NO_LIVE_RIPS,
      body: JSON.stringify({
        command: "rename",
        new_name: "[BACKUP] Kept - DVD",
        path: marked,
      }),
      destinationRoot: tmpRoot,
    })

    expect(refused.status).toBe(400)
    expect(refused.payload.ok).toBe(false)
    expect(
      "msg" in refused.payload ? refused.payload.msg : "",
    ).toContain("already taken")
    // Still listed, because nothing moved.
    expect(
      "leftovers" in refused.payload
        ? refused.payload.leftovers.map((one) => one.name)
        : [],
    ).toEqual([
      "[BACKUP] Kept - DVD (rip-deck-duplicate-01234567)",
    ])
  })

  it("⚠️ answers 400 for a command it does not know", async () => {
    const refused = await handleLeftoversWrite({
      readLiveRips: async () => NO_LIVE_RIPS,
      body: JSON.stringify({
        command: "chown",
        path: "/x",
      }),
      destinationRoot: tmpRoot,
    })

    expect(refused.status).toBe(400)
    expect(refused.payload.ok).toBe(false)
  })

  it("still routes a delete through the same dispatcher", async () => {
    const marked = join(
      tmpRoot,
      ".rip-deck-incomplete-dispatch-1",
    )
    await mkdir(marked, { recursive: true })

    const deleted = await handleLeftoversWrite({
      readLiveRips: async () => NO_LIVE_RIPS,
      body: JSON.stringify({
        command: "delete",
        path: marked,
      }),
      destinationRoot: tmpRoot,
    })

    expect(deleted.status).toBe(200)
    expect(deleted.payload.ok).toBe(true)
  })
})

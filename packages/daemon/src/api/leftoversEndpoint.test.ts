import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  handleLeftoversDelete,
  handleLeftoversList,
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
      destinationRoot: tmpRoot,
    })
    expect(listed.status).toBe(200)
    expect(
      "leftovers" in listed.payload
        ? listed.payload.leftovers.map((one) => one.name)
        : [],
    ).toEqual([".rip-deck-incomplete-http-1"])

    const deleted = await handleLeftoversDelete({
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

  it("⚠️ answers 400 rather than deleting a finished rip", async () => {
    // The request was understood and answered. It is not a
    // server fault, and it must not be a success either.
    const refused = await handleLeftoversDelete({
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

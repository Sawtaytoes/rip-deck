import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  handleLeftoversDelete,
  handleLeftoversList,
  parseDeleteBody,
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

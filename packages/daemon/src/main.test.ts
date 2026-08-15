import { describe, expect, it } from "vitest"
import {
  isWatchInvocation,
  startApiServer,
} from "./main.ts"

/**
 * The daemon entry point.
 *
 * Two things in `main.ts` are worth a test, and both are things
 * that are not console formatting.
 *
 * The predicate, because getting it wrong is not a wrong string
 * in a log — it is a nine-bay daemon starting inside a test run,
 * or `yarn dev` starting nothing at all. Everything else about
 * the console is formatting over decisions that live, and are
 * tested, in `rip/watcher.ts` and `rip/governor.ts`.
 *
 * And the API bind, because a rip must never depend on the API
 * being up. That is the same rule `docs/mqtt.md` states for the
 * broker, and the failure path is the half nobody exercises by
 * hand.
 *
 * That this test can import `main.ts` at all is the assertion:
 * the import is only safe because the predicate says no here.
 */

describe("isWatchInvocation", () => {
  it("runs when it is the process entry (`yarn dev`)", () => {
    expect(
      isWatchInvocation([
        "/usr/bin/node",
        "/app/packages/daemon/src/main.ts",
      ]),
    ).toBe(true)
  })

  it("runs when the CLI dispatched `watch` to it", () => {
    expect(
      isWatchInvocation([
        "/usr/bin/node",
        "/app/packages/daemon/src/cli.ts",
        "watch",
        "--max",
        "9",
      ]),
    ).toBe(true)
  })

  it("runs from the COMPILED entry — `node …/cli.js watch`", () => {
    // The deployed image runs the esbuild bundle on plain node, so
    // the entry is `cli.js`, not `cli.ts`. Keying on `.ts` made the
    // watcher exit 0 and leave the tower unwatched.
    expect(
      isWatchInvocation([
        "/usr/bin/node",
        "/app/packages/daemon/dist/cli.js",
        "watch",
      ]),
    ).toBe(true)
  })

  it("runs when the compiled daemon is the process entry", () => {
    expect(
      isWatchInvocation([
        "/usr/bin/node",
        "/app/packages/daemon/dist/main.js",
      ]),
    ).toBe(true)
  })

  it("stays put for every other subcommand", () => {
    // `rip-deck probe` imports nothing from here, but if it ever
    // did, it must not start ripping discs.
    expect(
      isWatchInvocation([
        "/usr/bin/node",
        "/app/packages/daemon/src/cli.ts",
        "probe",
      ]),
    ).toBe(false)
  })

  it("stays put under a test runner", () => {
    // `npx vitest watch` puts "watch" at argv[2] too. Matching on
    // that alone would start a daemon in the middle of a test run,
    // which is why the entry file is checked in both branches.
    expect(
      isWatchInvocation([
        "/usr/bin/node",
        "/app/node_modules/.bin/vitest",
        "watch",
      ]),
    ).toBe(false)

    expect(
      isWatchInvocation([
        "/usr/bin/node",
        "/app/node_modules/.bin/vitest",
        "run",
      ]),
    ).toBe(false)
  })

  it("stays put when there is no entry file at all", () => {
    expect(isWatchInvocation(["/usr/bin/node"])).toBe(false)
  })
})

describe("starting the JSON API", () => {
  it("says where it is serving", async () => {
    const lines: string[] = []

    await startApiServer({
      server: {
        listen: () => Promise.resolve({ port: 3007 }),
        close: () => Promise.resolve(),
      },
      log: (message) => lines.push(message),
    })

    expect(lines[0]).toContain("3007")
    expect(lines[0]).toContain("/json")
  })

  it("survives a port it cannot have", async () => {
    // EADDRINUSE — a second `rip-deck watch`, or the old ARM
    // viewer still holding the port. Three real rips must not
    // die over a dashboard, so this warns and returns.
    const warnings: string[] = []

    const api = await startApiServer({
      server: {
        listen: () =>
          Promise.reject(
            new Error("listen EADDRINUSE: 0.0.0.0:3007"),
          ),
        close: () =>
          Promise.reject(
            new Error("Server is not running."),
          ),
      },
      warn: (message) => warnings.push(message),
    })

    expect(warnings[0]).toContain("EADDRINUSE")
    expect(warnings[0]).toContain("NOT SERVED")

    // And the shutdown path must not then throw on a server that
    // never listened: closing it would reject with
    // ERR_SERVER_NOT_RUNNING and strand the rips being cancelled.
    await expect(api.close()).resolves.toBeUndefined()
  })

  it("hands back the close that lets the daemon exit", async () => {
    // A listening `node:http` server is a REF'D handle. Without
    // this close, `rip-deck watch` would never exit after Ctrl-C.
    let isClosed = false

    const api = await startApiServer({
      server: {
        listen: () => Promise.resolve({ port: 3007 }),
        close: () => {
          isClosed = true
          return Promise.resolve()
        },
      },
      log: () => {},
    })

    await api.close()

    expect(isClosed).toBe(true)
  })
})

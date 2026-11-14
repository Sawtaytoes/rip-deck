# The SPA fallback is Charcuterie's shared rule

**Status:** Accepted
**Date:** 2026-11-14
**Type:** Architecture / API surface
**Supersedes:** in part, [The dashboard has a client router](2026-08-16-the-dashboard-has-a-client-router.md):
only its "a path whose last segment contains a dot does not" clause, and the
hand-written `isClientRoutePathname` it described. The client router, the reserved
`/api` and `/assets` namespaces, the segment boundary, and the drift tests stand.
**Superseded by:** —

## Decision

The daemon decides which GET or HEAD miss gets the dashboard with Charcuterie's
`getIsShellPath`, imported from `@charcuterie/server/paths`. It no longer has its own
rule. A miss gets the shell unless it falls under `SERVER_PATH_PREFIXES` or under Vite's
hashed `/assets/`.

`SERVER_PATH_PREFIXES` is `SERVER_PATHNAMES` plus `/api` and `/assets`. It is the one
list the fallback reads, and `router.test.ts` pins it.

Everything else about serving the dashboard stays the same:

- The files are still read into memory once at startup, so serving one is a `Map.get`.
- A real file still wins over the router.
- HEAD still answers.
- A client route with no build is still the 503 text page.
- A miss under a server prefix or under `/assets/` is still the JSON 404.
- A write never gets the shell. Only GET and HEAD reach the fallback.
- The shell is still sent `no-store`.

## Why the shared rule

On 2026-11-14 the owner said *"Ah, we can fix these. Go ahead."* about the
2026-11-12 fleet audit. The audit found that each app's SPA fallback was hand-written
and that the copies had drifted. Charcuterie's `createStaticHandler` already
carries the fleet's rule as `serverPathPrefixes`, and every Hono app uses it.

The daemon cannot use `createStaticHandler` itself. It is Hono middleware that
streams each file from disk, and the daemon is plain `node:http`. Its router promises
that every asset path is a synchronous read of memory, so that a wedged drive can never
freeze the dashboard. Charcuterie therefore gained a framework-free entry,
`@charcuterie/server/paths` (0.9.0), that exports the rule alone. The handler and
this daemon now call the same function.

## Why the dot rule goes

The dot rule existed for one failure. A missing bundle such as
`/assets/index-abc123.js` must be a 404, never 200 + HTML that the browser tries to
run as JavaScript. The 2026-08-16 record already reserved `/assets` outright, so the
dot "stopped being the only thing standing between a moved hash and an HTML
response." Now the reserved namespace is the whole guard.

The dot rule also needed a special case. Drive IDs contain dots, so
`/kiosk/bays/2-2.3.2` had to be listed by hand as a client route. The shared rule
needs no special case.

## Consequences

- **A missing dotted file outside `/assets/` and the server's paths now gets the
  dashboard.** For example, a deleted `/kiosk/castkit.json` or a missing
  `/robots.txt` answers 200 HTML, not a JSON 404. Every file in `packages/web/public/`
  exists in every build, so this happens only if one is removed. Folio, Foyer, and
  Plinth took the same trade when they adopted the shared rule.
- **An exact server pathname now owns its subpaths.** `/json/extra` and
  `/health/deep` are the server's JSON 404, not the dashboard.
- A new top-level route still joins `SERVER_PATHNAMES`, and the drift tests still
  fail if it does not.

## Evidence

- Charcuterie PR [#426](https://github.com/Sawtaytoes/charcuterie/pull/426) added
  `@charcuterie/server/paths`. A test there walks the entry's import graph and fails if
  any module it reaches imports a package, so the entry cannot load Hono.
- `router.test.ts` pins the shared regression set. A client route (including a dotted
  kiosk ID) gets the shell. A missing `/assets/*.js` or `.css` is a JSON 404. A missing
  API route is a JSON 404. A POST to an unknown path, a client path, or `/index.html`
  is a JSON 404. A built asset is `immutable`. A client route with no build is a 503.

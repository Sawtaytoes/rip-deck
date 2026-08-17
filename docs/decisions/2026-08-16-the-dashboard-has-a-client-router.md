# The dashboard has a client router, and the daemon's index fallback widened with it

**Status:** Accepted
**Date:** 2026-08-16
**Type:** Architecture / frontend + API surface
**Supersedes:** the "these two paths and nothing else" index rule in
`packages/daemon/src/api/router.ts`
**Superseded by:** —

## Decision

The dashboard renders a `<BrowserRouter>` with a `<Routes>` table — one route (`/`)
today, plus a catch-all redirect — per the fleet decision
`2026-08-16-owned-web-apps-use-react-router-with-path-urls` in the `agentic` root repo,
which covers single-view apps deliberately.

**The daemon's index fallback widened in the same change**, because the two are one
feature. `router.ts` served the dashboard's HTML for exactly `/` and `/index.html` and
explained why:

> Deliberately just these two, and NOT "every path that is not an API path". The app has
> no client-side router […] **If a router is ever added, widen the fallback HERE and keep
> the API paths above it.**

That is now done, on the narrowest rule that works: **any extension-less path that is not
an API path serves the dashboard; a path whose last segment contains a dot does not.**

## Why extension-less, and not "anything that isn't an API path"

Because of the one failure the old comment was really protecting against, which has
nothing to do with typos:

- A missing bundle — `/assets/index-abc123.js` after a deploy moved the hashes — **must**
  fail as a 404 the browser reports. Answer it with 200 + HTML and the browser tries to
  execute HTML as JavaScript, and the error it raises says nothing about the actual
  problem. The dot is what tells those two cases apart.
- Every API path is matched above this point, so the API is untouched either way.

## Consequences

- **A mistyped extension-less path now renders the dashboard instead of a JSON 404.**
  `/jsonn` used to be a JSON 404 an API client could act on; it is a page now. That is
  the price of a client router and it is the trade every other app in the fleet makes.
  A mistyped path that *looks like a file* still 404s in JSON.
- `router.test.ts`'s "404s in JSON, never in HTML" split in two, which is a better test
  than it was: one case pins that an extension-less path is a client route, the other
  pins that a path naming a FILE still returns a JSON 404. The second is the one that
  was actually protecting anything.
- A real file still wins over the router — `/index.html` is both an asset and an index
  path, and an asset that exists is served as itself.
- `HEAD` behaves as before; `curl -I` on the daemon still answers.

## Evidence

> "Points-Market, Board Game Picker, and QueuePilot, Rip-Deck, CastKit, Image-Viewer,
> and the others need browser routing. I want them all the same" (owner, 2026-08-16)

Verified 2026-08-16 against a running daemon on the built dashboard:

| Request | Result |
| --- | --- |
| `GET /` | 200 `text/html` |
| `GET /index.html` | 200 `text/html` |
| `GET /nope` | 200 `text/html` — a client route |
| `GET /bay/3` | 200 `text/html` — a client route |
| `GET /assets/index-deadbeef.js` | **404 `application/json`** |
| `GET /json` | 200 `application/json` — API unaffected |

`tsc`, `biome check`, `eslint` and 1,294 tests all pass.

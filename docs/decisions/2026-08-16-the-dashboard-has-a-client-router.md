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

That is now done, on the narrowest rule that works: **a path the server owns — any of
`SERVER_PATHNAMES`, or anything under the `/api` or `/assets` namespace including the
bare segment — is never a client route; otherwise any extension-less path serves the
dashboard, and a path whose last segment contains a dot does not.**

## Why extension-less, and not "anything that isn't an API path"

Because of the one failure the old comment was really protecting against, which has
nothing to do with typos:

- A missing bundle — `/assets/index-abc123.js` after a deploy moved the hashes — **must**
  fail as a 404 the browser reports. Answer it with 200 + HTML and the browser tries to
  execute HTML as JavaScript, and the error it raises says nothing about the actual
  problem. The dot is what tells those two cases apart.

## Why two namespaces are excluded outright

"Every API path is matched above this point" is true of the paths that **exist**, and
that is not the same as leaving the API untouched. What reaches the fallback under
`/api/` is a typo or an endpoint that has not shipped yet, and answering those with
200 + HTML is the *same* failure the dot guard exists to prevent — a client that asked
for structured data getting a document it cannot parse — with a JSON client in the
browser's place. `GET /api/rips` answering 200 + HTML until the day that endpoint ships
is a debugging trap, so `/api/` is excluded outright and keeps its JSON 404.

`/assets/` is excluded for the matching reason: it is Vite's content-hashed output and
routes nothing, so a missing bundle should 404 on the strength of **where** it is and
not merely because Vite happens to put an extension on every file it emits. The dot
stops being the only thing standing between a moved hash and an HTML response.

Neither exclusion costs a client route — the table is `/` plus a catch-all, and the
dashboard routes nothing under either prefix — and a real file still wins over both,
because `readAsset` is consulted before the router test runs.

### The boundary is "equals, or starts with a slash", and both halves bite

The prefixes are stored **without** a trailing slash and matched as
`pathname === prefix || pathname.startsWith(prefix + "/")`, because each naive form is
wrong in its own direction:

- `startsWith("/api/")` alone lets **bare `/api`** fall through to the extension test,
  which sees no dot and serves the dashboard — 200 HTML where a JSON 404 stood before
  the router. This shipped in the first cut of this change and was caught in review.
- `startsWith("/api")` alone **over-matches**, swallowing a perfectly good client route
  like `/apiary`.

### `isServerRoutePathname` is where a new route gets declared

The fallback consults a predicate rather than testing prefixes inline, and the predicate
reads `SERVER_PATHNAMES`, which is built from the same constants the dispatch chain
matches on. `router.test.ts` fails if the two drift: one test forbids comparing
`pathname` against an inline string literal, another pins the exact set of constants the
chain compares against. Adding a top-level route without declaring it fails the second.

That guard exists because a sibling app in the fleet hit the failure it prevents — a
top-level `/version` its own frontend polled began returning `index.html` once the
fallback widened, and the frontend read the unparseable body as "server unreachable,
reload now".

## Navigation: there is none yet, and that is why there are no `<Link>`s

The fleet decision also asks for **real `<Link>` / `<a href>` navigation**, and a sibling
PR in this batch quietly skipped that item while satisfying the other three. Audited here
on 2026-08-19 rather than assumed: the dashboard renders **27 controls and zero anchors**,
and **ctrl+clicking every one of them opens no tab and changes no URL**.

Every control is an action or a setting — tray commands, `Tower off`, the column-count
radios, the `drive info` disclosures, per-bay `Cancel`, and the card overlay that opens
the log modal. None of them goes anywhere, because there is nowhere to go: the table is
one route.

So item 4 is **vacuously satisfied, not skipped**. The moment a second view exists — a
per-bay log at `/bay/:slot/log` is the obvious candidate, since that overlay is already
card-shaped — it must be a `<Link>`, not the `<button>` the overlay is today.
`@charcuterie/ui@2.17.0` (which this repo is on) ships `ButtonLink` and a `/react-router`
adapter for exactly that, wired with `<RouterLinkProvider link={ReactRouterLink}>` at the
root. Ctrl+click and middle-click are the tests that tell the two apart; a screenshot
cannot.

## Consequences

- **A mistyped extension-less path now renders the dashboard instead of a JSON 404.**
  `/jsonn` used to be a JSON 404 an API client could act on; it is a page now. That is
  the price of a client router and it is the trade every other app in the fleet makes.
  A mistyped path that *looks like a file* still 404s in JSON.
- `router.test.ts`'s "404s in JSON, never in HTML" split in two, which is a better test
  than it was: one case pins that an extension-less path is a client route, the other
  pins that a path naming a FILE still returns a JSON 404. The second is the one that
  was actually protecting anything.
- **The API's namespace is unchanged, not merely its existing paths.** `GET /api/anything`
  answers exactly as it did before the router arrived, so no API client can be handed a
  page it did not ask for.
- A real file still wins over the router — `/index.html` is both an asset and an index
  path, and an asset that exists is served as itself.
- `HEAD` behaves as before; `curl -I` on the daemon still answers.

## Evidence

> "Points-Market, Board Game Picker, and QueuePilot, Rip-Deck, CastKit, Image-Viewer,
> and the others need browser routing. I want them all the same" (owner, 2026-08-16)

Verified 2026-08-19 against a running daemon on the built dashboard, and driven in
Chromium at 1440 x 900:

| Request | Result |
| --- | --- |
| `GET /` | 200 `text/html` — the dashboard, 9 bays |
| `GET /index.html` | 200 `text/html` |
| `GET /nope` | 200 `text/html` — a client route |
| `GET /bay/3` | 200 `text/html` — a client route |
| `GET /settings/advanced` | 200 `text/html` — a client route |
| `GET /assets/index-<hash>.js` (real) | 200 `text/javascript` |
| `GET /assets/index-deadbeef.js` | **404 `application/json`** |
| `GET /assets/no-extension` | **404 `application/json`** — reserved |
| `GET /api/unknown` | **404 `application/json`** — reserved |
| `GET /api/tray/open` | **404 `application/json`** — reserved |
| `GET /api`, `GET /assets` (bare) | **404 `application/json`** — the namespace includes its root |
| `GET /apiary`, `GET /assetsomething` | 200 `text/html` — the prefix must not over-match |
| `GET /stop`, `/close`, `/hide`, `/unhide` | 501 `application/json` — unchanged |
| `GET /api/tray` | 405 `application/json` — POST only, as before |
| `GET /json`, `/health`, `/fixtures` | 200 `application/json` — API unaffected |
| `GET /eject` | 501 `application/json` — unchanged |

A cold load of `/bay/3` and an F5 on it both return 200 HTML and land on `/` via the
catch-all `<Navigate replace>`, with the dashboard rendered and no console error but a
pre-existing font 404 unrelated to routing.

`tsc`, `biome check .`, `eslint .` and the daemon's 1,035 tests all pass.

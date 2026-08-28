/**
 * The dependencies Vite must pre-bundle before the browser-mode suite
 * runs. Spread into `optimizeDeps.include` by `vitest.config.ts`.
 *
 * WHY THIS IS ITS OWN FILE, not an inline array in the Vitest config:
 * `charcuterie-check-optimize-deps` reads this list in a plain Node
 * process, after the suite, and compares it against what the optimizer
 * ACTUALLY optimized (`_metadata.json`). A plain Node process cannot
 * load `vitest.config.ts` — so the list lives here, where both the
 * config and the checker can import it.
 *
 * WHY THE LIST IS LOAD-BEARING: Vite discovers dependencies lazily.
 * Left to itself it starts a re-optimisation part-way through a run and
 * reloads the page under the tests, which throws away React's
 * compiler-runtime cache and surfaces as a `useMemoCache` null crash or
 * `Failed to fetch dynamically imported module: …?v=<hash>`. Neither
 * message names the missing package. It is a RACE, so an incomplete
 * list passes until it doesn't — and it is invisible locally, because
 * `node_modules/.vite` is warm after the first run, while CI has no
 * cache at all.
 *
 * Each SUBPATH is its own entry: `@charcuterie/logic` does NOT cover
 * `@charcuterie/logic/query`. mux-magic lost this exact race on CI (16
 * tests) after the fleet query adoption added an unlisted subpath here
 * too — this repo was short four entries at the same time.
 *
 * Source of truth is THIS package's own `_metadata.json`, written under
 * `packages/web/node_modules/.vite/vitest/<hash>/deps/` after a cold
 * run — not another repo's copy filtered by hand, which is how those
 * four went missing. Note the cache lives under `packages/web/`, not the
 * repo root; clearing the wrong one gives a warm run that proves nothing.
 *
 * You should not need to maintain this by hand any more: CI runs the
 * parity check after the suite and fails with the exact names to add.
 *
 * @type {readonly string[]}
 */
export const optimizeDepsInclude = [
  "@charcuterie/logic/query",
  "@charcuterie/tokens",
  "@charcuterie/ui",
  "@charcuterie/ui/react-router",
  "@tanstack/react-query",
  "@testing-library/jest-dom/vitest",
  "@testing-library/react",
  "@testing-library/user-event",
  // From Vitest itself rather than app source, but a top-level entry in
  // `_metadata.json` all the same.
  "expect-type",
  "react",
  "react-dom",
  "react-dom/client",
  // Entered the TEST graph on 2026-08-27, when `renderWithProviders`
  // gained a `MemoryRouter`. `app.tsx` had imported it since the
  // router shipped, but `app.tsx` is not in the suite's graph — so
  // the parity check went from silent to failing on the harness
  // change, not on the router one.
  "react-router",
  "react/jsx-dev-runtime",
  "react/jsx-runtime",
]

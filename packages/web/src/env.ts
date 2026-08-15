// Build-time configuration. Vite inlines `import.meta.env.VITE_*`
// at build, so these are fixed once the bundle is built.

/**
 * Run entirely on bundled fixtures, with no backend.
 *
 * Honoured in DEVELOPMENT ONLY, and that asymmetry is the whole
 * point. The daemon now serves this app and `/json` from one
 * origin, so a production bundle has a real API by definition,
 * and a shipped bundle that quietly ran on fixtures would be a
 * dashboard confidently showing nine invented rips on the real
 * tower — this project's recurring failure mode, and the reason
 * `is_fake` exists at all.
 *
 * `import.meta.env.DEV` is `false` in every `vite build` and Vite
 * inlines it, so `isMock` folds to a literal `false` in the
 * production bundle: a stray `.env` in the build context cannot
 * flip it, and `mockDataSource` is tree-shaken out entirely. The
 * failure direction is toward the real API, always.
 *
 * To see a scenario against a real deployment, ask the DAEMON for
 * it — `?fake=<name>` — which stamps `is_fake: true` on the reply
 * so the page says it is not looking at the rack.
 */
export const isMock =
  import.meta.env.DEV && import.meta.env.VITE_MOCK === "1"

/**
 * API base for the real data source, relative to the app origin.
 *
 * The SPA and the daemon are served on the same origin — the
 * daemon serves `dist/` itself on port 3007, behind NPM/Authelia
 * at `example.com` — so this is normally "".
 */
export const apiBase = import.meta.env.VITE_API_BASE ?? ""

/**
 * State-feed poll interval, ms.
 *
 * `/json` is a pure in-memory read on the daemon side — it opens
 * no device and cannot block — so polling it is cheap. 3s
 * matches the viewer's cadence and the sampler's 2s is the floor
 * worth asking for.
 */
export const pollMs = Number(
  import.meta.env.VITE_POLL_MS ?? "3000",
)

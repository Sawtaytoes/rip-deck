/**
 * Which fixture scenario the page is asking for.
 *
 * Deliberately the SAME `?fake=<name>` convention the daemon's
 * router already implements, and the same nine names, so one
 * URL means one thing in both modes: against the mock it selects
 * the bundled scenario, and against a live daemon it is forwarded
 * verbatim to `/json?fake=`. Two spellings for one idea is how a
 * demo ends up showing a state the backend cannot produce.
 *
 * Source of truth: `packages/daemon/src/api/fixtures.ts`
 * (`FIXTURE_NAMES`). The list is mirrored rather than imported
 * because that module lives in `@rip-deck/daemon`, which this
 * package must not pull into the browser bundle — see
 * `src/types.ts`. `mockDataSource.test.ts` fails if the two lists
 * ever disagree in count.
 */
export const FIXTURE_NAMES = [
  "empty",
  "nine-rips",
  "verdicts",
  "hub-fault",
  "confidence",
  "rising-eta",
  "quarantined",
  "held-at-startup",
  "unmeasured",
  "usb-flap",
] as const

export type FixtureName = (typeof FIXTURE_NAMES)[number]

export const isFixtureName = (
  name: string,
): name is FixtureName =>
  (FIXTURE_NAMES as readonly string[]).includes(name)

/**
 * The scenario shown when there is no rack to show.
 *
 * Nine concurrent rips, because that is what the owner asked the
 * daemon for and it is the layout most likely to be wrong.
 *
 * Belongs to `mockDataSource` and to nothing else. It is NOT what
 * a plain `/` means — see `readFixtureName`.
 */
export const DEFAULT_FIXTURE: FixtureName = "nine-rips"

/**
 * Read the scenario out of a query string.
 *
 * `null` — meaning "show me the rack" — whenever the URL does not
 * name a scenario, and this is the important part. It used to
 * answer `DEFAULT_FIXTURE` here, which was harmless while nothing
 * served `/json`: there was no rack to show, so the page had to
 * invent one. Now that the daemon serves this app and its data on
 * one origin, that same line would make a bare
 * `http://tower.example.com:3007/` open on nine invented rips while
 * standing in front of a tower that might be idle, or on fire.
 * That is the failure this project keeps having, and the reason
 * `is_fake` exists at all.
 *
 * The default did not go away, it moved to where it is true:
 * `mockDataSource.fetchState` picks it when asked for `null`,
 * because with no backend there is genuinely nothing else to
 * draw. `httpDataSource` asked for `null` fetches `/json` with no
 * query and gets the rack.
 *
 * An unknown name is treated the same way rather than throwing —
 * a mistyped URL should show the dashboard, not a stack trace,
 * and real data is never the wrong thing to fall back to.
 */
export const readFixtureName = (
  search: string,
): FixtureName | null => {
  const requested = new URLSearchParams(search).get("fake")

  if (requested === null) return null

  return isFixtureName(requested) ? requested : null
}

import { httpDataSource } from "./api/httpDataSource"
import { mockDataSource } from "./api/mockDataSource"
import { isMock } from "./env"
import type { RipDeckDataSource } from "./types"

/**
 * The single place the app chooses between fixtures and a live
 * daemon. `VITE_MOCK=1` in DEVELOPMENT -> bundled fixtures, no
 * backend. Everywhere else, including every production build,
 * the real HTTP source — see `isMock` for why that is not
 * configurable.
 *
 * The choice is build-time so it can never flip at runtime, and
 * every mock response carries `is_fake: true` so the page says
 * which one it got.
 */
export const defaultDataSource: RipDeckDataSource = isMock
  ? mockDataSource
  : httpDataSource

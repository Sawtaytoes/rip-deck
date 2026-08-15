import {
  createQueryClient as createSharedQueryClient,
  QueryProvider,
} from "@charcuterie/logic/query"
import type { QueryClient } from "@tanstack/react-query"
import { createContext, type ReactNode } from "react"

import { defaultDataSource } from "../dataSource"
import type { RipDeckDataSource } from "../types"

/**
 * Ported from the viewer's `AppProviders`, with the data source
 * moved from a module-level singleton import into context.
 *
 * That is the one structural change, and it is what makes the
 * components testable: HANDOFF §8 settles that component tests
 * get a fresh store per test, and here "the store" is the
 * react-query cache plus whatever is answering `/json`. A
 * singleton imported at module scope is shared across every test
 * in a file, so one test's poll leaks into the next one's
 * assertions.
 */

export const DataSourceContext =
  createContext<RipDeckDataSource>(defaultDataSource)

/**
 * A query client with retries off.
 *
 * The state feed is polled every few seconds anyway, so a failed
 * poll is already retried by the next tick — and react-query's
 * default exponential backoff would keep a stale card on screen
 * for tens of seconds after the daemon came back.
 *
 * Built through the fleet's `createQueryClient` from
 * `@charcuterie/logic/query`. That shared default leaves retries
 * **on** (recovering a transient blip is the right default for an
 * ordinary HTTP backend), so rip-deck's polling opt-out is passed
 * **explicitly** here rather than inherited.
 */
export const createQueryClient = (): QueryClient =>
  createSharedQueryClient({
    defaultOptions: { queries: { retry: false } },
  })

const defaultQueryClient = createQueryClient()

export function AppProviders({
  children,
  queryClient = defaultQueryClient,
  dataSource = defaultDataSource,
}: {
  children: ReactNode
  queryClient?: QueryClient
  dataSource?: RipDeckDataSource
}) {
  return (
    <QueryProvider client={queryClient}>
      <DataSourceContext value={dataSource}>
        {children}
      </DataSourceContext>
    </QueryProvider>
  )
}

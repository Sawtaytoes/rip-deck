import { RouterLinkProvider } from "@charcuterie/ui"
import { ReactRouterLink } from "@charcuterie/ui/react-router"
import {
  type RenderResult,
  render,
} from "@testing-library/react"
import type { ReactElement } from "react"
import { MemoryRouter } from "react-router"

import {
  AppProviders,
  createQueryClient,
} from "../components/AppProviders"
import type { RipDeckDataSource } from "../types"

/**
 * Render a tree with a FRESH query client and data source.
 *
 * HANDOFF §8 settles that component tests get a fresh store per
 * test. Here "the store" is two things — the react-query cache
 * and whatever is answering `/json` — and both are module-level
 * singletons in the shipping app. Sharing either across tests
 * means one test's poll settles into the next one's assertions,
 * which is the flake that looks like a real bug for an afternoon.
 */
export const renderWithProviders = (
  ui: ReactElement,
  dataSource: RipDeckDataSource,
): RenderResult =>
  render(
    <RouterLinkProvider link={ReactRouterLink}>
      <MemoryRouter>
        <AppProviders
          queryClient={createQueryClient()}
          dataSource={dataSource}
        >
          {ui}
        </AppProviders>
      </MemoryRouter>
    </RouterLinkProvider>,
  )

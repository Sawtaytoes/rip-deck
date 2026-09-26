import "../styles/tailwind.css"

import { RouterLinkProvider } from "@charcuterie/ui"
import { ReactRouterLink } from "@charcuterie/ui/react-router"
import { cleanup, render } from "@testing-library/react"
import type { ReactElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router"
import {
  afterEach,
  beforeEach,
  describe,
  inject,
  it,
  vi,
} from "vitest"
import { page } from "vitest/browser"

// The clock is pinned BEFORE any import below runs: the mock history
// stamps its rows with `Date.now()` when the module loads, and every
// elapsed, "ago" and estimated-finish string on the page is measured
// against the same clock. Only `Date` is faked — react-query and the
// mock's own response delay still need real timers.
vi.hoisted(() => {
  vi.useFakeTimers({
    now: new Date("2026-07-26T12:12:00").getTime(),
    toFake: ["Date"],
  })
})

import {
  createFixtureState,
  mockDataSource,
  resetMockDrift,
} from "../api/mockDataSource"
import {
  AppProviders,
  createQueryClient,
} from "../components/AppProviders"
import { Dashboard } from "../components/Dashboard"
import { History } from "../components/History"
import { Kiosk } from "../components/Kiosk"
import { KioskLoading } from "../components/KioskLoading"
import {
  DEFAULT_FIXTURE,
  type FixtureName,
  isFixtureName,
} from "../fixture"
import type { RipDeckDataSource } from "../types"

/**
 * Visual-regression shots of the real routes, on fixture data.
 *
 * The Storybook covers three components; the pages the owner looks
 * at — the dashboard, the 480x320 kiosk CastKit shows, and the
 * history — exist only here. Each shot renders the route's own
 * component on `mockDataSource`'s scenarios, which are the daemon's
 * fixtures transcribed name for name, so a picture here is a state
 * the rack can actually be in.
 *
 * Determinism, in the order it bit:
 *
 *  - the clock (above);
 *  - the mock's drift, which moves the lead rip 0.6% per poll —
 *    `fetchState` below re-reads the scenario without advancing it,
 *    so a poll that lands mid-capture draws the same pixels;
 *  - fonts, awaited through `document.fonts.ready`;
 *  - motion, frozen by the stylesheet below and the context's
 *    `reducedMotion` (`vitest.vrt.config.ts`);
 *  - the page's own idea of its size — see `sizeViewport`;
 *  - time zone, locale and pixel ratio, pinned on the browser
 *    context, so a runner's defaults cannot move a glyph.
 */

type Scheme = "dark" | "light"

const SCHEMES: readonly Scheme[] = ["dark", "light"]

const WIDE_VIEW = { width: 1280, height: 800 } as const
const NARROW_VIEW = { width: 390, height: 844 } as const
// The kiosk is a fixed panel: `/kiosk/castkit.json` asks CastKit
// for exactly this viewport.
const KIOSK_PANEL = { width: 480, height: 320 } as const

const FREEZE_MOTION_CSS = `
*, *::before, *::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
`

/** The mock, minus its drift: every poll answers the same document. */
const frozenDataSource: RipDeckDataSource = {
  ...mockDataSource,
  fetchState: (fixture) =>
    Promise.resolve(
      createFixtureState(
        typeof fixture === "string" &&
          isFixtureName(fixture)
          ? fixture
          : DEFAULT_FIXTURE,
      ),
    ),
}

const freezeMotion = () => {
  const style = document.createElement("style")
  style.dataset.vrt = "freeze-motion"
  style.textContent = FREEZE_MOTION_CSS
  document.head.append(style)
}

const applyScheme = (scheme: Scheme) => {
  // The switcher reads the persisted pick on mount and writes
  // `data-scheme`; setting both means the first frame is already
  // right and the switcher agrees with it.
  window.localStorage.setItem("charcuterie-scheme", scheme)
  document.documentElement.dataset.scheme = scheme
}

const renderRoute = ({
  path,
  url,
  element,
}: {
  path: string
  url: string
  element: ReactElement
}) =>
  render(
    <RouterLinkProvider link={ReactRouterLink}>
      <MemoryRouter initialEntries={[url]}>
        <AppProviders
          queryClient={createQueryClient()}
          dataSource={frozenDataSource}
        >
          <Routes>
            <Route element={element} path={path} />
          </Routes>
        </AppProviders>
      </MemoryRouter>
    </RouterLinkProvider>,
  )

const waitForImages = () =>
  Promise.all(
    [...document.images].map((image) => image.decode()),
  )

/**
 * Size the iframe, and pin what the page READS as its size.
 *
 * `useLayoutColumns` spends height before width, so it reads
 * `window.innerHeight`. A full-page shot grows the iframe to the
 * page's height, and without the pin the dashboard reflowed from
 * three columns to two under the shutter and was cut off mid-card.
 */
const sizeViewport = async (viewport: {
  width: number
  height: number
}) => {
  await page.viewport(viewport.width, viewport.height)
  vi.stubGlobal("innerWidth", viewport.width)
  vi.stubGlobal("innerHeight", viewport.height)
}

const shoot = async ({
  name,
  isReady,
  viewport,
  isFullPage = true,
}: {
  name: string
  isReady: () => Promise<unknown>
  viewport: { width: number; height: number }
  isFullPage?: boolean
}) => {
  await isReady()
  await document.fonts.ready
  await waitForImages()

  // Let the second poll and any post-mount layout settle, then
  // make sure nothing is still loading before the shutter.
  await new Promise((resolve) => {
    setTimeout(resolve, 250)
  })
  await document.fonts.ready

  // Grow the iframe to the whole page. An element screenshot past the
  // iframe's own fold paints BLANK, not the rest of the page — the
  // first run cut the nine-rips dashboard off under the second row.
  if (isFullPage) {
    // Until it settles: a taller frame can still move the content.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const height = Math.max(
        viewport.height,
        document.documentElement.scrollHeight,
      )

      if (height === document.documentElement.clientHeight)
        break

      await page.viewport(viewport.width, height)
      await new Promise((resolve) => {
        setTimeout(resolve, 100)
      })
    }
  }

  const directory = inject("vrtActualDirectory")

  await page.screenshot({
    path: `${directory}/routes/${name}.png`,
  })
}

const byText = (text: string | RegExp) => () =>
  page.getByText(text).first().element()

beforeEach(() => {
  resetMockDrift()
  window.localStorage.clear()
  freezeMotion()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.head
    .querySelectorAll("style[data-vrt]")
    .forEach((style) => {
      style.remove()
    })
})

/** Poll for an element until it appears, like `findBy*`. */
const eventually = (probe: () => Element) => async () => {
  const deadline = performance.now() + 10_000

  for (;;) {
    try {
      return probe()
    } catch (error) {
      if (performance.now() > deadline) throw error

      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
  }
}

// Every scenario the daemon can be asked for. The wide dashboard is
// the page that shows them all at once.
const DASHBOARD_FIXTURES: readonly FixtureName[] = [
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
  "showcase",
  "data-disc",
]

// The Narrow View reflows the cards into one column and moves the
// poster inline; these are the scenarios that exercise that most.
const NARROW_DASHBOARD_FIXTURES: readonly FixtureName[] = [
  "empty",
  "nine-rips",
  "verdicts",
  "showcase",
]

const KIOSK_FIXTURES: readonly FixtureName[] = [
  "empty",
  "nine-rips",
  "verdicts",
  "showcase",
]

describe.each(SCHEMES)("%s scheme", (scheme) => {
  beforeEach(() => {
    applyScheme(scheme)
  })

  it.each(DASHBOARD_FIXTURES)(
    "dashboard %s, Wide View",
    async (fixture) => {
      await sizeViewport(WIDE_VIEW)
      renderRoute({
        path: "/",
        url: `/?fake=${fixture}`,
        element: (
          <Dashboard fixture={fixture} now={Date.now()} />
        ),
      })
      await shoot({
        viewport: WIDE_VIEW,
        name: `dashboard--${fixture}--wide__${scheme}`,
        isReady: eventually(
          byText(`Fixture data · ${fixture}`),
        ),
      })
    },
  )

  it.each(NARROW_DASHBOARD_FIXTURES)(
    "dashboard %s, Narrow View",
    async (fixture) => {
      await sizeViewport(NARROW_VIEW)
      renderRoute({
        path: "/",
        url: `/?fake=${fixture}`,
        element: (
          <Dashboard fixture={fixture} now={Date.now()} />
        ),
      })
      await shoot({
        viewport: NARROW_VIEW,
        name: `dashboard--${fixture}--narrow__${scheme}`,
        isReady: eventually(
          byText(`Fixture data · ${fixture}`),
        ),
      })
    },
  )

  it("history, Wide View", async () => {
    await sizeViewport(WIDE_VIEW)
    renderRoute({
      path: "/history",
      url: "/history",
      element: <History />,
    })
    await shoot({
      viewport: WIDE_VIEW,
      name: `history--wide__${scheme}`,
      isReady: eventually(byText(/Finished/)),
    })
  })

  it("history, Narrow View", async () => {
    await sizeViewport(NARROW_VIEW)
    renderRoute({
      path: "/history",
      url: "/history",
      element: <History />,
    })
    await shoot({
      viewport: NARROW_VIEW,
      name: `history--narrow__${scheme}`,
      isReady: eventually(byText(/Finished/)),
    })
  })
})

// The kiosk pins `data-scheme="dark"` on its own `<main>` — the panel
// is dark whatever the operator's pick — so every kiosk shot is taken
// once, with no scheme suffix. Shot in both, the two came out
// byte-identical.
it.each(KIOSK_FIXTURES)("kiosk %s", async (fixture) => {
  await sizeViewport(KIOSK_PANEL)
  renderRoute({
    path: "/kiosk",
    url: `/kiosk?fake=${fixture}`,
    element: <Kiosk />,
  })
  await shoot({
    viewport: KIOSK_PANEL,
    // A fixed panel: nothing lives below its fold.
    isFullPage: false,
    name: `kiosk--${fixture}`,
    isReady: eventually(() => {
      const main = document.querySelector("main")

      if (main === null || main.getAttribute("aria-busy")) {
        throw new Error("kiosk still loading")
      }

      return main
    }),
  })
})

// The slot's own page: the poster, the disc details and the
// full-size tray buttons CastKit hands a tap on a row to.
it("kiosk slot detail", async () => {
  const [bay] = createFixtureState("showcase").ripDeck.bays

  await sizeViewport(KIOSK_PANEL)
  renderRoute({
    path: "/kiosk/slots/:driveId",
    url: `/kiosk/slots/${bay.drive_id}?fake=showcase`,
    element: <Kiosk />,
  })
  await shoot({
    viewport: KIOSK_PANEL,
    // A fixed panel: nothing lives below its fold.
    isFullPage: false,
    name: `kiosk--showcase--slot-detail`,
    isReady: eventually(() =>
      page.getByRole("button", { name: "Open" }).element(),
    ),
  })
})

// The loading card is the image CastKit caches for the panel, dark
// for the same reason.
it("kiosk loading", async () => {
  await sizeViewport(KIOSK_PANEL)
  renderRoute({
    path: "/kiosk/loading",
    url: "/kiosk/loading",
    element: <KioskLoading />,
  })
  await shoot({
    viewport: KIOSK_PANEL,
    // A fixed panel: nothing lives below its fold.
    isFullPage: false,
    name: "kiosk--loading",
    isReady: eventually(byText("Loading disc details…")),
  })
})

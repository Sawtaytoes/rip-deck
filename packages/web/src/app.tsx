import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router"

import { AppProviders } from "./components/AppProviders"
import { Dashboard } from "./components/Dashboard"
import { History } from "./components/History"
import "./styles/tailwind.css"

const rootElement = document.getElementById("root")

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      {/* Two routes. The router shipped 2026-08-16 with one, per the fleet
          decision 2026-08-16-owned-web-apps-use-react-router-with-path-urls —
          every app we own gets one, including the single-view ones, so the
          second view is a route rather than a `useState` fork bolted on later.
          `/history` is that second view, and it cost a `<Route>` line.

          The daemon's fallback was widened in the same change, because it had to
          be: `router.ts` answered index HTML for exactly `/` and `/index.html`,
          and said in so many words that a router arriving should widen it there.
          Any extension-less non-API path now serves the app; a path with a dot
          still 404s, so a missing bundle fails as a 404 rather than as HTML the
          browser tries to execute. That is also what makes a RELOAD on
          `/history` work rather than 404 — the SPA fallback and the route are
          the same change, as the fleet rule requires. */}
      <BrowserRouter>
        <AppProviders>
          <Routes>
            <Route element={<Dashboard />} path="/" />
            <Route element={<History />} path="/history" />
            <Route
              element={<Navigate replace to="/" />}
              path="*"
            />
          </Routes>
        </AppProviders>
      </BrowserRouter>
    </StrictMode>,
  )
}

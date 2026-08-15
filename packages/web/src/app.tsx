import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { AppProviders } from "./components/AppProviders"
import { Dashboard } from "./components/Dashboard"
import "./styles/tailwind.css"

const rootElement = document.getElementById("root")

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <AppProviders>
        <Dashboard />
      </AppProviders>
    </StrictMode>,
  )
}

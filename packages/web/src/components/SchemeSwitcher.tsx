import type { ColorSchemeIcons } from "@charcuterie/ui"
import { ColorSchemeSwitcher } from "@charcuterie/ui"
import type { ReactNode } from "react"

/**
 * The colour-scheme control in the header: one cycling button,
 * light → dark → **system**, that follows the OS by default and
 * remembers the operator's pick.
 *
 * `@charcuterie/ui`'s `ColorSchemeSwitcher` is the whole engine —
 * it wires `useColorScheme` to the three browser defaults from
 * `@charcuterie/logic/browser` (`matchMedia` + `localStorage` +
 * `data-scheme` on `<html>`), so this file only hands it its
 * glyphs. The persisted key is the shared default
 * (`charcuterie-scheme`), which is the same key
 * `index.html`'s first-paint script reads — the two must agree or
 * the page flashes the wrong theme for a frame.
 *
 * **The icons are inline SVG, not a new dependency.** rip-deck
 * ships no icon library, and the fleet convention Charcuterie's
 * own boards use is a hand-drawn `<svg>` inheriting
 * `currentColor` — so the sun/moon/monitor here match that,
 * decoration beside the `IconButton`'s real accessible name
 * rather than glyphs a screen reader is left to guess at.
 * `DiscKindLogo` is the same convention carrying real brand
 * marks, and it names itself because it is the only place some
 * cards say what kind of disc is in the bay.
 */

const iconProps = {
  className: "size-[1.15em] shrink-0",
  fill: "none",
  focusable: false,
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.75,
  viewBox: "0 0 24 24",
  xmlns: "http://www.w3.org/2000/svg",
} as const

const SunIcon = (): ReactNode => (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="12" cy="12" r="4" />

    <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4" />
  </svg>
)

const MoonIcon = (): ReactNode => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.2 6.2 0 0 0 10.5 10.5z" />
  </svg>
)

const MonitorIcon = (): ReactNode => (
  <svg {...iconProps} aria-hidden="true">
    <rect height="12" rx="2" width="18" x="3" y="4.5" />

    <path d="M8 20.5h8M12 16.5v4" />
  </svg>
)

const SCHEME_ICONS: ColorSchemeIcons = {
  dark: <MoonIcon />,
  light: <SunIcon />,
  system: <MonitorIcon />,
}

export function SchemeSwitcher(): ReactNode {
  // `intent="neutral"` is the default in `@charcuterie/ui@2.2.0`
  // and is stated here on purpose. Before 2.2.0 the switcher
  // inherited `IconButton`'s accent, so it rendered accent-violet
  // with an effectively invisible hover; 2.2.0 gave the toggle its
  // own `intent` prop defaulting to `neutral`
  // (`hover:bg-intent-neutral-surface`, `text-intent-neutral-content`).
  // Naming it keeps this a header chrome control rather than an
  // accent action, and survives any future change to the default.
  return (
    <ColorSchemeSwitcher
      icons={SCHEME_ICONS}
      intent="neutral"
    />
  )
}

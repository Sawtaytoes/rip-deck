import {
  installThemeAxes,
  themeParameters,
} from "@charcuterie/storybook-config/preview"

/**
 * The whole point-of-truth stylesheet: `tailwind.css` pulls in
 * Tailwind's utilities, `@charcuterie/tokens/theme.css` (every
 * `--color-*` under `[data-scheme]`) and `@charcuterie/ui/styles.css`.
 * Without it the components render unstyled and the toolbars look
 * inert. (The globals writer and the React-Aria focus preload come
 * from the shared `/preview` entry.)
 */
import "../src/styles/tailwind.css"

// Two axes: `data-variant` stays at `:root`/daylight. a11y stays
// report-only (`isA11yEnforced` off) while the app still carries
// un-tokenised colours — see `.storybook/main.ts`.
const themeAxes = installThemeAxes(["density", "scheme"])

export const globalTypes = themeAxes.globalTypes

export default {
  initialGlobals: themeAxes.initialGlobals,
  decorators: themeAxes.decorators,
  parameters: {
    layout: "padded",
    ...themeParameters(),
  },
}

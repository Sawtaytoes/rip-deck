import {
  buildPreviewHead,
  docsAddonWithGfm,
} from "@charcuterie/storybook-config"
import { charcuterieViteFinal } from "@charcuterie/storybook-config/vite"
import type { StorybookConfig } from "@storybook/react-vite"

/**
 * rip-deck's Storybook host. It lives in `packages/web` rather than
 * a separate `docs` package — this repo has one web package and no
 * others to keep stories out of — which is how castkit and mux-magic
 * host theirs. `example.com` composes it in through
 * `storybook-container/refs.json`; nothing here knows about that.
 *
 * The theme setup (first-paint seed, the `density`/`scheme` toolbars
 * and their writer, the Tailwind `viteFinal`) is
 * `@charcuterie/storybook-config` — see
 * `charcuterie/docs/how-we-do-storybook.md`. This app themes two
 * axes, not three: `data-variant` stays at `:root`/daylight.
 */
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [
    docsAddonWithGfm,
    // Reports axe violations in the panel rather than enforcing them
    // (`themeParameters` defaults `isA11yEnforced` off in preview.tsx):
    // this app still carries 155 hardcoded colours in eight unmigrated
    // files (RipCard among them), so `test: "error"` would fail the
    // build on contrast the migration has not reached yet. It surfaces
    // them for the migration to chip at, which is what a first
    // Storybook is for.
    "@storybook/addon-a11y",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  // The token first-paint `<style>` + the axis-seed `<script>`, from
  // the shared package. Load-bearing on the composed site, where the
  // cold load deep-links straight at a story and a missing
  // `data-scheme` paints stock Storybook white.
  previewHead: buildPreviewHead({
    axes: ["density", "scheme"],
  }),
  // Tailwind v4 + the React dedupe (a standalone app repo, so its
  // symlinked `@charcuterie/ui` must not pull a second React).
  viteFinal: charcuterieViteFinal({ isReactDeduped: true }),
}

export default config

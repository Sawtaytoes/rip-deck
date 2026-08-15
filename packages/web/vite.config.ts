import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

/**
 * Ported from the ARM viewer's dashboard, minus its fixed
 * `host: true` — in production this `dist/` is served by the
 * daemon itself on port 3007 (see
 * `packages/daemon/src/api/webAssets.ts`), behind NPM/Authelia
 * on `example.com`; the dev server is only ever bound
 * locally.
 *
 * Deliberately NO react-compiler babel pass. mux-magic runs one;
 * the viewer does not, and this is a port of the viewer. That
 * matters beyond taste: the `useMemoCache` null crash HANDOFF §8
 * warns about is a react-compiler-runtime failure, so not
 * adopting the compiler is the other way to not have it.
 */
export default defineConfig(({ mode }) => {
  // `src/env.ts` gates `VITE_MOCK` on `import.meta.env.DEV`, so a
  // production bundle can never ship on fixtures no matter what
  // the environment says. Say that out loud at build time rather
  // than leaving someone to wonder why their `.env` did nothing
  // — a silently ignored setting is how the next person
  // "confirms" mock mode is off by reading the wrong file.
  //
  // `"."` rather than a resolved directory: this file is in the
  // browser program, which deliberately has no `node` types, and
  // `loadEnv` resolves a relative dir against the cwd — which is
  // this package for both `yarn build` and `yarn workspace
  // @rip-deck/web build`. Worst case it finds nothing and this
  // says nothing, which is the safe direction.
  if (
    mode === "production" &&
    loadEnv(mode, ".", "VITE_").VITE_MOCK === "1"
  ) {
    console.warn(
      "\nVITE_MOCK=1 is set and is being IGNORED: this is a " +
        "production build, and it always talks to the real " +
        "/json. Use ?fake=<name> against the daemon for the " +
        "fixture scenarios.\n",
    )
  }

  return {
    plugins: [react(), tailwindcss()],
    /**
     * **Written when `@charcuterie/ui` was a `portal:`, which
     * means a symlink, which means two Reacts unless this line
     * exists.** It is a registry install at `^1.0.0` now, so the
     * hazard is far smaller — the line stays for the reason at the
     * bottom of this comment, not because a symlink is still here.
     *
     * Node and Vite both resolve a symlinked module from its REAL
     * path, so a component living at
     * `charcuterie/packages/ui/…` resolves its own `react` by
     * walking up from THERE — landing on charcuterie's copy, while
     * this app's tree renders with `rip-deck`'s. The failure is
     * `Cannot read properties of null (reading 'useRef')` on the
     * first hook in the first shared component, and it says
     * nothing at all about symlinks.
     *
     * `react` is a **peer** dependency of `@charcuterie/ui`
     * precisely so that a registry install would hoist one copy
     * and this could not happen. The line stays after publish
     * anyway: it costs nothing when there is only one copy, and it
     * is the difference between a working `yarn link` session and
     * an hour of confusion.
     */
    resolve: { dedupe: ["react", "react-dom"] },
    server: {
      port: 5173,
      strictPort: true,
    },
  }
})

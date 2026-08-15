// `?raw` inlines index.html as a string at build time, so this test needs no
// `node:fs` at runtime — it runs in the vitest browser (chromium) suite like
// the rest of the package, where node builtins are externalized.

import {
  buildFirstPaintScript,
  daylight,
} from "@charcuterie/tokens"
import { expect, test } from "vitest"
import indexHtml from "../index.html?raw"

/**
 * The first-paint snippet, pinned to the one tokens generates.
 *
 * `index.html` sets `data-scheme` and paints a background before any
 * stylesheet has parsed — that is the entire job of the inline
 * `<script>` in `<head>`. The value has to be a literal at that
 * instant, and it is a copy, and a copy needs a test or it is a copy
 * that drifts.
 *
 * **This app now FOLLOWS THE OS by default** rather than pinning
 * dark ([decision](docs/decisions/2026-08-03-first-paint-follows-the-os-scheme.md),
 * superseding the pinned-`data-scheme="dark"` note in the old HTML).
 * A static attribute + a single-scheme fallback was enough while the
 * scheme was constant; a dynamic scheme (persisted, or `system`)
 * needs the attribute set AND the fallback hex chosen — both before
 * paint — which only inline `<head>` script can do. So the test that
 * used to assert a bare `data-scheme="dark"` in the tag now asserts
 * the script that resolves it.
 *
 * Since `@charcuterie/tokens@1.0.0` the whole snippet is **generated**
 * by `buildFirstPaintScript`, so this file no longer reassembles the
 * declaration by hand and hopes the punctuation matches — it asserts
 * the library's own string. Reassembling it here would gate the hex
 * and miss the `var()`, the resolution rule, the `storageKey` and the
 * `color-scheme` — the exact things this app has already got wrong
 * once.
 *
 * The second test below is the one written in blood: `index.html`
 * used to assert a BARE `background-color: #131822`, and that bare
 * form was the bug. An inline `<style>` is unlayered, unlayered CSS
 * outranks every `@layer`, and Tailwind's `bg-surface-base` lives in
 * `@layer utilities` — so the hex pinned the canvas dark and
 * `data-scheme="light"` could never reach it. Written as a `var()`
 * FALLBACK the literal applies only before the token exists, which is
 * all it was ever for. Following the OS makes the branch mandatory:
 * the fallback is now chosen per resolved scheme, so a light-resolved
 * load never flashes the dark hex.
 */
test("the first-paint snippet is the one tokens generates", () => {
  const expected = buildFirstPaintScript(daylight)

  // A sanity check on the reach into the token package: if the
  // shape ever changes, an empty or `undefined`-bearing string here
  // would otherwise make the assertion below vacuously true against
  // something `index.html` will never contain. Both schemes' surface
  // hexes must be present, because following the OS means the
  // fallback BRANCHES rather than pinning one.
  expect(expected).toContain(`var(--color-surface-base,`)

  expect(expected).toContain(
    daylight.schemes.dark.surface.base,
  )

  expect(expected).toContain(
    daylight.schemes.light.surface.base,
  )

  expect(indexHtml).toContain(expected)
})

test("no unlayered rule pins a raw colour on the canvas", () => {
  // Only the executable `<script>`, never the surrounding HTML
  // comment (which quotes `background-color: #131822` on purpose to
  // explain the bug and would be a false positive here).
  const script = indexHtml.match(
    /<script>([\s\S]*?)<\/script>/,
  )?.[1]

  expect(script).toBeTypeOf("string")

  // Every place a background is set for first paint — the inline
  // script builds a `<style>` string at runtime — must route the
  // colour through `var(--color-surface-base, …)`. A bare literal
  // (`background-color:#131822`) reintroduces the exact bug: an
  // unlayered rule outranks `bg-surface-base` and pins the canvas so
  // no `[data-scheme]` flip can repaint it.
  const backgroundDeclarations = (script ?? "").match(
    /background-color\s*:[^"'};]+/g,
  )

  // The snippet does set a background, so this must not be empty —
  // an empty match would make the loop vacuously pass.
  expect(
    backgroundDeclarations?.length ?? 0,
  ).toBeGreaterThan(0)

  for (const declaration of backgroundDeclarations ?? []) {
    expect(declaration).toContain("var(--color-")
  }
})

test("the scheme is resolved before paint, not pinned in the tag", () => {
  // The default now follows the OS: `data-scheme` is NOT a constant
  // in the `<html>` tag any more — the script sets it. Asserting its
  // absence keeps a well-meaning future edit from re-pinning it and
  // silently killing OS-follow (the "flag: default now follows OS"
  // change this file records).
  expect(indexHtml).not.toContain('data-scheme="dark"')

  expect(indexHtml).not.toContain('data-scheme="light"')

  // The script sets the attribute from the resolved choice and reads
  // the shared persistence key, so pre-paint and hydrated React state
  // agree — no flash of the wrong theme on reload.
  expect(indexHtml).toContain(
    'document.documentElement.setAttribute("data-scheme", scheme)',
  )

  expect(indexHtml).toContain(
    'var KEY = "charcuterie-scheme"',
  )

  // `color-scheme` (the CSS property the browser reads for scrollbars
  // and native controls) is set from the same resolved scheme, not a
  // constant.
  expect(indexHtml).toContain('");color-scheme:" + scheme')
})

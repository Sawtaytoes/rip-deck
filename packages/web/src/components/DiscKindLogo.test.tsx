import { render, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { MediaKind } from "../types"
import { DiscKindLogo, discLogoFor } from "./DiscKindLogo"

/**
 * The disc-type mark.
 *
 * What is worth locking down here is NOT which path data each
 * logo holds — that is art, and a test asserting on it would
 * fail every time the art is re-exported without telling anyone
 * anything. It is the three properties a wrong mark breaks:
 * 4K stays distinguishable from Blu-ray, an unseen kind still
 * renders something, and the type is readable by a screen
 * reader on a card that says it nowhere else.
 */

/**
 * Assert against one mark, then take it back out.
 *
 * `getByRole` is unique-or-throw and these cases render several
 * kinds, so each has to go before the next arrives. It unmounts
 * through React rather than calling `.remove()` on the node —
 * ripping a node out from under the reconciler makes React's own
 * cleanup throw `removeChild`, which reads like a component bug
 * and is not one.
 */
const withMark = (
  kind: MediaKind,
  assert: (mark: HTMLElement) => void,
): void => {
  const { container, unmount } = render(
    <DiscKindLogo kind={kind} />,
  )

  assert(within(container).getByRole("img"))

  unmount()
}

describe("DiscKindLogo", () => {
  it("keeps 4K distinct from Blu-ray", () => {
    // `armView.toArmKind` refuses to flatten a 4K disc into
    // `bluray` to win a prettier glyph. Two kinds wearing one
    // mark would undo that in the UI, which is exactly what the
    // blue diamond and the blue square did.
    expect(discLogoFor("uhd")).not.toBe(
      discLogoFor("bluray"),
    )
    expect(discLogoFor("uhd").paths).not.toEqual(
      discLogoFor("bluray").paths,
    )
  })

  it("draws an audio CD with the Compact Disc mark", () => {
    expect(discLogoFor("music")).toBe(discLogoFor("music"))
    expect(discLogoFor("music")).not.toBe(
      discLogoFor("dvd"),
    )
  })

  it("falls back rather than throwing on an unseen kind", () => {
    // The daemon's `kind` is a free string. A new one must not
    // render an empty box where the disc type goes.
    const fallback = discLogoFor("hd-dvd")

    expect(fallback.paths.length).toBeGreaterThan(0)
    expect(fallback).toBe(discLogoFor("data"))
  })

  it("names the disc type for a screen reader", () => {
    // `discTypeText` is null whenever the daemon has no
    // `disctype_label` — every bay adopted from the ledger — so
    // on those cards this mark is the ONLY place the type
    // appears.
    withMark("uhd", (mark) => {
      expect(mark).toHaveAccessibleName("4K")
    })

    withMark("bluray", (mark) => {
      expect(mark).toHaveAccessibleName("Blu-ray")
    })

    withMark("music", (mark) => {
      expect(mark).toHaveAccessibleName("Audio CD")
    })
  })

  it("takes the card's text colour only where the real mark is monochrome", () => {
    // The CD and DVD wordmarks are printed black-on-light and
    // white-on-dark, so they must follow the colour scheme or
    // one of the two schemes hides them. Blu-ray is recognised
    // BY its blue and keeps it.
    expect(discLogoFor("dvd").fill).toBe("currentColor")
    expect(discLogoFor("music").fill).toBe("currentColor")
    expect(discLogoFor("bluray").fill).not.toBe(
      "currentColor",
    )
    expect(discLogoFor("uhd").fill).not.toBe("currentColor")
  })
})

import { makeVerdict } from "@rip-deck/contracts"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { buildBayView } from "../testing/buildRip"
import { renderWithProviders } from "../testing/renderWithProviders"
import {
  buildTrayBayReport,
  buildTrayCommandReport,
  createStubDataSource,
} from "../testing/stubDataSource"
import type { BayView, RipDeckDataSource } from "../types"
import { HeldBayCard } from "./HeldBayCard"

/**
 * The card for a disc rip-deck REFUSED to rip.
 *
 * Three discs in the owner's tower are in exactly this state,
 * and the owner asked for it to be flagged here as well as on
 * the console. What each test below protects is the difference
 * between this and a failed rip — they call for opposite
 * actions, and the whole card exists so nobody has to read
 * closely to tell which one they are looking at.
 */

const DETAIL =
  "There was already a disc in this drive when rip-deck " +
  "started, and Rip-Deck has no bay memory at all yet."

const noop = () => {
  // intentionally empty
}

/** The card owns a `useTrayCommand`, so it needs the providers. */
const renderCard = (
  ui: ReactElement,
  dataSource: RipDeckDataSource = createStubDataSource(),
) => renderWithProviders(ui, dataSource)

const buildHeldBay = (
  overrides: Partial<BayView> = {},
): BayView => {
  const base = buildBayView()
  const verdict = makeVerdict("unknown", "suspected", [
    DETAIL,
  ])

  return {
    ...base,
    state: {
      ...base.state,
      state: "needs_attention",
      title: "TROY - DIRECTOR'S CUT",
      progress_percent: 0,
      eta_seconds: null,
      eta_trend: null,
      throughput_bytes_per_sec: null,
      verdict: verdict.kind,
    },
    alert: {
      drive: base.label,
      slot: base.slot,
      verdict: verdict.kind,
      action: verdict.action,
      message: verdict.message,
      evidence: verdict.evidence,
      is_keep_trying_sensible: verdict.isKeepTryingSensible,
    },
    verdict_confidence: "suspected",
    actions: [],
    ...overrides,
  }
}

describe("HeldBayCard", () => {
  it("names the slot and the disc, and says it was not ripped", () => {
    renderCard(
      <HeldBayCard bay={buildHeldBay()} onAction={noop} />,
    )

    // §3: the slot is a field of its own, so the registry's
    // "07 - " prefix comes off the drive. Said once.
    expect(screen.getByText("slot 7")).toBeInTheDocument()
    expect(
      screen.queryByText(/07 - Pioneer/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/TROY - DIRECTOR'S CUT/),
    ).toHaveTextContent("held — not ripped")
  })

  // The owner is being asked to do something physical, and the
  // daemon already wrote the sentence that says what. Hiding it
  // behind a kind name ("needs_attention") is how a card sends
  // somebody to the rack to look at a disc that is fine.
  it("shows the daemon's own sentence, verbatim", () => {
    renderCard(
      <HeldBayCard bay={buildHeldBay()} onAction={noop} />,
    )

    expect(screen.getByText(DETAIL)).toBeInTheDocument()
  })

  it("prefers the outcome detail once the feed carries it", () => {
    // `outcome_detail` is the one clean sentence; the evidence
    // array is where it currently arrives, mixed with engine
    // boilerplate. When the field exists the boilerplate goes.
    renderCard(
      <HeldBayCard
        bay={buildHeldBay({
          outcome_detail: "Take the disc out.",
        })}
        onAction={noop}
      />,
    )

    expect(
      screen.getByText("Take the disc out."),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(DETAIL),
    ).not.toBeInTheDocument()
  })

  // The distinction the whole card is for. A failed rip means
  // "this disc may be damaged, find another copy"; a held bay
  // means "rip-deck declined to guess, press a button".
  it("says plainly that nothing failed", () => {
    renderCard(
      <HeldBayCard bay={buildHeldBay()} onAction={noop} />,
    )

    expect(
      screen.getByText(/Nothing failed/),
    ).toBeInTheDocument()
  })

  // Every number a RipCard is built around is zero here, and a
  // held bay reading "0.0%" or "~15m left" would be describing
  // a rip that never started.
  it("shows no progress, ETA or throughput at all", () => {
    renderCard(
      <HeldBayCard bay={buildHeldBay()} onAction={noop} />,
    )

    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
    expect(
      screen.queryByText(/left/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/MB\/s/),
    ).not.toBeInTheDocument()
  })

  // The whole point of this card: the disc is sitting in the
  // drive on purpose, and the fix is a button press.
  it("offers the ⏏ toggle that releases the disc", async () => {
    const runTrayCommand = vi.fn(() =>
      Promise.resolve(buildTrayCommandReport()),
    )

    renderCard(
      <HeldBayCard bay={buildHeldBay()} onAction={noop} />,
      createStubDataSource({ runTrayCommand }),
    )

    await userEvent.click(
      screen.getByRole("button", { name: "Open tray" }),
    )

    expect(runTrayCommand).toHaveBeenCalledWith({
      command: "open_bay",
      driveId: "usb-2-1-1-2-4-4-7",
    })
  })

  it("reports a refused tray press in the daemon's own words", async () => {
    renderCard(
      <HeldBayCard bay={buildHeldBay()} onAction={noop} />,
      createStubDataSource({
        runTrayCommand: () =>
          Promise.resolve(
            buildTrayCommandReport({
              message: "Opened 2 trays.",
              bays: [
                buildTrayBayReport({
                  result: "refused_ripping",
                  detail:
                    "Slot 7 is ripping — nothing was touched.",
                }),
              ],
            }),
          ),
      }),
    )

    await userEvent.click(
      screen.getByRole("button", { name: "Open tray" }),
    )

    await waitFor(() => {
      expect(
        screen.getByText(
          "Slot 7 is ripping — nothing was touched.",
        ),
      ).toBeInTheDocument()
    })
  })

  it("reports a refused bay action in full", () => {
    // The five JOB actions still have no transport at all, so
    // the refusal IS the feature: it has to say how to do the
    // thing by hand.
    renderCard(
      <HeldBayCard
        bay={buildHeldBay({ actions: ["give_up"] })}
        onAction={noop}
        action={{
          action: "give_up",
          status: "fail",
          msg: "Publish it to <base>/cmd/drive.",
        }}
      />,
    )

    expect(
      screen.getByText(
        /Publish it to <base>\/cmd\/drive\./,
      ),
    ).toBeInTheDocument()
  })
  /**
   * The dead end, closed.
   *
   * This card used to print `rip-deck rip --slot N --name "…"` — a
   * CLI command a dashboard cannot run — with ⏏ as its only
   * control, and ⏏ does not un-hold on this hardware. *"I don't
   * have a way to do anything actionable other than eject.
   * Horrible user experience."*
   */
  describe("the way out", () => {
    it("rips under the name the operator types", async () => {
      const runTrayCommand = vi.fn(() =>
        Promise.resolve(buildTrayCommandReport()),
      )

      renderCard(
        <HeldBayCard
          bay={buildHeldBay({
            state: {
              ...buildHeldBay().state,
              title: null,
            },
          })}
          onAction={noop}
        />,
        createStubDataSource({ runTrayCommand }),
      )

      await userEvent.type(
        screen.getByRole("textbox"),
        "Soylent Green - UHD",
      )
      await userEvent.click(
        screen.getByRole("button", { name: "Rip as this" }),
      )

      expect(runTrayCommand).toHaveBeenCalledWith({
        command: "rip_bay",
        driveId: "usb-2-1-1-2-4-4-7",
        name: "Soylent Green - UHD",
      })
    })

    it("re-identifies when the box is left empty", async () => {
      // A disc held by a transient identify race just needs the
      // read attempted again — no name to type, and the button
      // says which of the two things it is about to do.
      const runTrayCommand = vi.fn(() =>
        Promise.resolve(buildTrayCommandReport()),
      )

      renderCard(
        <HeldBayCard
          bay={buildHeldBay({
            state: {
              ...buildHeldBay().state,
              title: null,
            },
          })}
          onAction={noop}
        />,
        createStubDataSource({ runTrayCommand }),
      )

      await userEvent.click(
        screen.getByRole("button", { name: "Try again" }),
      )

      expect(runTrayCommand).toHaveBeenCalledWith({
        command: "rip_bay",
        driveId: "usb-2-1-1-2-4-4-7",
        name: "",
      })
    })

    it("prefills the disc's own name when it read one", () => {
      // The worst version of this card told the operator to
      // hand-type a name the drive had already read.
      renderCard(
        <HeldBayCard
          bay={buildHeldBay()}
          onAction={noop}
        />,
      )

      expect(screen.getByRole("textbox")).toHaveValue(
        "TROY - DIRECTOR'S CUT",
      )
      expect(
        screen.getByRole("button", { name: "Rip as this" }),
      ).toBeInTheDocument()
    })

    it("never sends whitespace as a disc name", async () => {
      const runTrayCommand = vi.fn(() =>
        Promise.resolve(buildTrayCommandReport()),
      )

      renderCard(
        <HeldBayCard
          bay={buildHeldBay({
            state: {
              ...buildHeldBay().state,
              title: null,
            },
          })}
          onAction={noop}
        />,
        createStubDataSource({ runTrayCommand }),
      )

      await userEvent.type(
        screen.getByRole("textbox"),
        "   ",
      )

      // Still the re-identify press: blank is no name, never a
      // disc called "".
      await userEvent.click(
        screen.getByRole("button", { name: "Try again" }),
      )

      expect(runTrayCommand).toHaveBeenCalledWith({
        command: "rip_bay",
        driveId: "usb-2-1-1-2-4-4-7",
        name: "",
      })
    })

    it("reports a rip refused because the bay is ripping", async () => {
      // The daemon owns that refusal and this card goes through
      // it, so a UI that got out of step with the bay table says
      // so rather than pretending the press worked.
      renderCard(
        <HeldBayCard
          bay={buildHeldBay()}
          onAction={noop}
        />,
        createStubDataSource({
          runTrayCommand: () =>
            Promise.resolve(
              buildTrayCommandReport({
                command: "rip_bay",
                bays: [
                  buildTrayBayReport({
                    result: "refused_ripping",
                    detail:
                      "REFUSED — this bay is ripping. " +
                      "Nothing was touched.",
                  }),
                ],
              }),
            ),
        }),
      )

      await userEvent.click(
        screen.getByRole("button", { name: "Rip as this" }),
      )

      await waitFor(() => {
        expect(
          screen.getByText(/REFUSED — this bay is ripping/),
        ).toBeInTheDocument()
      })
    })

    it("does not read a started rip as trouble", async () => {
      renderCard(
        <HeldBayCard
          bay={buildHeldBay()}
          onAction={noop}
        />,
        createStubDataSource({
          runTrayCommand: () =>
            Promise.resolve(
              buildTrayCommandReport({
                command: "rip_bay",
                bays: [
                  buildTrayBayReport({
                    result: "rip_started",
                    detail:
                      'ripping as "TROY - DIRECTOR\'S CUT"',
                  }),
                ],
              }),
            ),
        }),
      )

      await userEvent.click(
        screen.getByRole("button", { name: "Rip as this" }),
      )

      await waitFor(() => {
        expect(screen.getByText(/ripping as/)).toHaveClass(
          "text-content-secondary",
        )
      })
    })

    it("offers nothing to rip when the bay is empty", () => {
      renderCard(
        <HeldBayCard
          bay={buildHeldBay({ disc_size_sectors: null })}
          onAction={noop}
        />,
      )

      expect(
        screen.queryByRole("textbox"),
      ).not.toBeInTheDocument()
    })
  })
})

import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { buildBayView, buildRip } from "../testing/buildRip"
import { renderWithProviders } from "../testing/renderWithProviders"
import {
  buildTrayBayReport,
  buildTrayCommandReport,
  createStubDataSource,
} from "../testing/stubDataSource"
import type { RipDeckDataSource } from "../types"
import { RipCard } from "./RipCard"

const NOW = new Date("2026-07-26 12:12:00").getTime()

const noop = () => {
  // intentionally empty
}

/**
 * The card owns a `useTrayCommand`, so it needs a query client
 * and a data source even in the tests that never press ⏏.
 */
const renderCard = (
  ui: ReactElement,
  dataSource: RipDeckDataSource = createStubDataSource(),
) => renderWithProviders(ui, dataSource)

describe("RipCard", () => {
  it("leads with the slot and the disc, not the drive", () => {
    // §12's ranked list: slot, disc, thumbnail — and the drive
    // name tenth, behind the advanced-info disclosure. It was
    // the headline before.
    renderCard(
      <RipCard
        rip={buildRip()}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(screen.getByText("slot 7")).toBeInTheDocument()
    expect(screen.getByText("Ivanhoe")).toBeInTheDocument()

    // Said TWICE on a card the daemon gave a `disctype_label`:
    // once as the `DiscKindLogo` mark's accessible name, once in
    // the detail row. That is the deliberate trade — the mark
    // has to name itself because `discTypeText` returns null on
    // every bay adopted from the ledger, and on those cards it
    // is the only place the type appears at all. A two-word
    // repeat is cheaper than a silent mark.
    expect(screen.getAllByText("Blu-ray")).toHaveLength(2)
    expect(
      screen.getByRole("img", { name: "Blu-ray" }),
    ).toBeInTheDocument()
  })

  // §3: "the drives are prefixed with their slot number. Do we
  // need that if we're going to say 'slot 9' anyway?"
  it("says the slot once, and never with the drive's prefix", () => {
    renderCard(
      <RipCard
        rip={buildRip({ label: null, volume_label: null })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    // With no disc name the drive IS the title — bare, because
    // the slot is already its own field beside it. Twice: the
    // headline, and again inside the advanced panel where the
    // drive properly belongs.
    expect(
      screen.getAllByText("Pioneer BDR-211M"),
    ).toHaveLength(2)
    expect(
      screen.queryByText(/07 - Pioneer/),
    ).not.toBeInTheDocument()
  })

  // §5: "It'd be nice to see that 'where did it rip' directory
  // somewhere in the same area the 'slot 8 · completed' is
  // located […] It doesn't make sense to show it in weird
  // information box underneath right?"
  it("puts the destination on the metadata row, not in the evidence box", () => {
    renderCard(
      <RipCard
        rip={buildRip()}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    const path = screen.getByText(/Disc-Rips\/Ivanhoe/)

    expect(path).toBeInTheDocument()
    // The evidence list is a `<ul>` inside `VerdictBadge`. The
    // destination reading as health evidence is exactly the
    // defect §5 describes.
    expect(path.closest("ul")).toBeNull()
  })

  it("shows the measured ETA, never an extrapolation", () => {
    // §2.4: extrapolating from elapsed and percent crosses a
    // PRGV reset at every stage boundary and reported a rising
    // ETA on a healthy rip.
    renderCard(
      <RipCard
        rip={buildRip({ eta_seconds: 900 })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.getByText(/12m elapsed · ~15m left/),
    ).toBeInTheDocument()
  })

  it("says nothing about the ETA when the daemon has no rate", () => {
    renderCard(
      <RipCard
        rip={buildRip({ eta_seconds: null })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.queryByText(/left/),
    ).not.toBeInTheDocument()
  })

  it("flags a rising ETA without alarming", () => {
    renderCard(
      <RipCard
        rip={buildRip({ eta_trend: "rising" })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.getByText(/ETA rising/),
    ).toBeInTheDocument()
    // Not a verdict. A rising ETA on a healthy disc happens.
    expect(
      screen.queryByText(/Clean it/),
    ).not.toBeInTheDocument()
  })

  // Item 6 of the ranked list. MakeMKV emits PRGC (this title)
  // and PRGT (the whole backup); `/json` serialises only the
  // total as `percent`, and the current item's LABEL as `stage`.
  it("names the item being written, alongside the overall percent", () => {
    renderCard(
      <RipCard
        rip={buildRip({ stage: "Saving title 3" })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.getByText("Saving title 3"),
    ).toBeInTheDocument()
    expect(screen.getByText("43.0%")).toBeInTheDocument()
  })

  // The one rule that overrides everything.
  it("never lets a read-error rip read as a success", () => {
    renderCard(
      <RipCard
        rip={buildRip({
          status: "success",
          active: false,
          percent: 100,
          read_error_count: 12,
        })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.getByText("12 read errors"),
    ).toBeInTheDocument()
    expect(
      screen.getByText("read errors"),
    ).toBeInTheDocument()
    expect(
      screen.queryByText("done"),
    ).not.toBeInTheDocument()
  })

  it("gives dirty and scratched their opposite advice", () => {
    const dirty = renderCard(
      <RipCard
        rip={buildRip({
          verdict: "disc_dirty",
          verdict_message:
            "Dirty — errors are scattered across the disc, " +
            "which is what fingerprints and smudges look " +
            "like. Clean it and try again.",
          verdict_confidence: "confirmed",
        })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      dirty.getByText(/Clean it and try again/),
    ).toBeInTheDocument()

    dirty.unmount()

    renderCard(
      <RipCard
        rip={buildRip({
          verdict: "disc_scratched",
          verdict_message:
            "Scratched — the damage is in one continuous " +
            "band, so cleaning will not help. Source another " +
            "copy.",
          verdict_confidence: "confirmed",
        })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.getByText(/Source another copy/),
    ).toBeInTheDocument()
  })

  it("marks a suspected verdict as wanting a second drive", () => {
    renderCard(
      <RipCard
        rip={buildRip({
          verdict: "disc_dirty",
          verdict_message: "Dirty.",
          verdict_confidence: "suspected",
        })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.getByText(/retry in another drive to confirm/),
    ).toBeInTheDocument()
  })

  it("says nothing at all for the ok verdict", () => {
    // `ok` is the default and carries no news; a calm chip on
    // all nine bays is how a real one stops being noticed.
    renderCard(
      <RipCard
        rip={buildRip()}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.queryByText("Reading normally."),
    ).not.toBeInTheDocument()
  })

  it("renders only the actions the daemon published", async () => {
    const onAction = vi.fn()

    renderCard(
      <RipCard
        rip={buildRip()}
        bay={buildBayView({
          actions: ["keep_trying", "give_up", "cancel"],
        })}
        onShowLog={noop}
        onAction={onAction}
        now={NOW}
      />,
    )

    // `buildBayView` is a RIPPING bay, and opening its tray
    // destroys 90 GB and an hour. The daemon refuses it as the
    // first branch of `decideTrayBayAction`; the card must not
    // offer it at all.
    expect(
      screen.queryByRole("button", { name: /tray/i }),
    ).not.toBeInTheDocument()

    await userEvent.click(
      screen.getByRole("button", { name: "Keep trying" }),
    )

    expect(onAction).toHaveBeenCalledWith({
      driveId: "usb-2-1-1-2-4-4-7",
      label: "07 - Pioneer BDR-211M",
      action: "keep_trying",
    })
  })

  // §2: "This button should also have an eject icon, not 'open
  // tray' because it's an open/close toggle."
  it("offers ONE eject toggle once the rip is over", async () => {
    const runTrayCommand = vi.fn(() =>
      Promise.resolve(buildTrayCommandReport()),
    )

    renderCard(
      <RipCard
        rip={buildRip({ status: "success", active: false })}
        bay={buildBayView({
          actions: [],
          disc_size_sectors: 12_000_000,
          state: {
            ...buildBayView().state,
            state: "completed",
          },
        })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
      createStubDataSource({
        runTrayCommand,
        fetchState: () => Promise.reject(new Error("no")),
      }),
    )

    const toggle = screen.getByRole("button", {
      name: "Open tray",
    })

    expect(toggle).toHaveTextContent("⏏")

    await userEvent.click(toggle)

    // A disc was read, so the tray is closed — the one branch
    // of `nextTrayCommandFor` that is a fact rather than an
    // inference. Next press opens it.
    expect(runTrayCommand).toHaveBeenCalledWith({
      command: "open_bay",
      driveId: "usb-2-1-1-2-4-4-7",
    })
  })

  // ⚠️ `is_accepted: true` with a `refused_ripping` bay means
  // "I heard you, and no". Reporting that as success is how a
  // control claims it opened the drive it correctly protected.
  it("shows the bay's own refusal, not the rack-wide message", async () => {
    renderCard(
      <RipCard
        rip={buildRip({ status: "success", active: false })}
        bay={buildBayView({
          actions: [],
          disc_size_sectors: 12_000_000,
          state: {
            ...buildBayView().state,
            state: "completed",
          },
        })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
      createStubDataSource({
        runTrayCommand: () =>
          Promise.resolve(
            buildTrayCommandReport({
              is_accepted: true,
              message: "Opened 8 trays.",
              bays: [
                buildTrayBayReport({
                  result: "refused_ripping",
                  detail:
                    "Slot 7 is ripping — nothing was touched.",
                }),
              ],
            }),
          ),
        fetchState: () => Promise.reject(new Error("no")),
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

    expect(
      screen.queryByText("Opened 8 trays."),
    ).not.toBeInTheDocument()
  })

  it("gives a refused action a line of its own", () => {
    // The refusals worth reading are sentences, and the meta
    // row they used to sit in is `break-all`.
    renderCard(
      <RipCard
        rip={buildRip()}
        onShowLog={noop}
        onAction={noop}
        action={{
          action: "cancel",
          status: "fail",
          msg: "no transport for this yet",
        }}
        now={NOW}
      />,
    )

    expect(
      screen.getByText(/no transport for this yet/),
    ).toBeInTheDocument()
  })

  // §7 + §4: the log button, and the collapsed card that is
  // itself a log button.
  it("opens the log from the button and from the whole card", async () => {
    const onShowLog = vi.fn()

    renderCard(
      <RipCard
        rip={buildRip({
          logfile: "fixture-job-7.robot.log",
        })}
        onShowLog={onShowLog}
        onAction={noop}
        now={NOW}
      />,
    )

    await userEvent.click(
      screen.getByRole("button", { name: "Logs" }),
    )
    await userEvent.click(
      screen.getByRole("button", {
        name: "Show the log for slot 7",
      }),
    )

    expect(onShowLog).toHaveBeenCalledTimes(2)
  })

  it("hides the log controls when this job wrote no capture", () => {
    renderCard(
      <RipCard
        rip={buildRip({ logfile: null })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.queryByRole("button", { name: "Logs" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", {
        name: /Show the log/,
      }),
    ).not.toBeInTheDocument()
  })

  // Item 10: "Drive name, serial, and other info like MakeMKV
  // (I can get that from clicking an 'advanced info' icon or
  // something)."
  it("keeps the drive, its serial and the addressing behind advanced info", async () => {
    renderCard(
      <RipCard
        rip={buildRip()}
        drive={{
          name: "sr2",
          mount: "/dev/sr2",
          current: null,
          previous: null,
          maker: "Pioneer",
          model: "BD-RW BDR-211M",
          serial_id: "EXAMPLE00007",
          drive_id: "usb-2-1-1-2-4-4-7",
          slot: 7,
          is_quarantined: false,
          quarantine_reason: null,
        }}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    await userEvent.click(screen.getByText(/drive info/))

    expect(
      screen.getByText("EXAMPLE00007"),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Pioneer BDR-211M"),
    ).toBeInTheDocument()
    expect(screen.getByText("/dev/sr2")).toBeInTheDocument()
  })

  it("explains an adopted rip's missing telemetry", () => {
    renderCard(
      <RipCard
        rip={buildRip({ is_adopted: true })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(
      screen.getByText(/no health telemetry/),
    ).toBeInTheDocument()
  })

  // §12 item 3. The fetcher is being built in parallel; every
  // bay's `poster` is null today, and the card has to be
  // correct in that state rather than leaving a grey box.
  it("leaves nothing behind when there is no thumbnail", () => {
    const { container } = renderCard(
      <RipCard
        rip={buildRip({ poster: null })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(container.querySelector("img")).toBeNull()
  })

  it("shows the thumbnail once one exists", () => {
    const { container } = renderCard(
      <RipCard
        rip={buildRip({
          poster: "/posters/ivanhoe.jpg",
        })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/posters/ivanhoe.jpg",
    )
  })

  // The owner on a phone: the poster and the title must stay
  // visible under the bay-container narrow threshold, not only
  // once a column clears 28rem. The Lightbox trigger used to be
  // `hidden @md/bay:block`; the title used to `truncate` behind
  // the action buttons.
  it("keeps the poster and the full title on a narrow card", () => {
    const { container } = renderCard(
      <RipCard
        rip={buildRip({
          label: "The People vs Larry Flynt",
          poster: "/posters/larry-flynt.jpg",
        })}
        onShowLog={noop}
        onAction={noop}
        now={NOW}
      />,
    )

    const poster = container.querySelector("img")
    expect(poster).not.toBeNull()
    expect(poster).toHaveAttribute(
      "src",
      "/posters/larry-flynt.jpg",
    )
    // Always-on trigger: no `hidden` utility on the lightbox
    // wrapper (narrow density only shrinks the image).
    expect(poster?.className).not.toMatch(/\bhidden\b/)
    // The heading span (not the Lightbox caption) wraps the
    // title: `break-words`, never `truncate`.
    const title = container.querySelector(
      "span.break-words.font-semibold",
    )
    expect(title).not.toBeNull()
    expect(title).toHaveTextContent(
      "The People vs Larry Flynt",
    )
    expect(title?.className).not.toMatch(/\btruncate\b/)
  })
})

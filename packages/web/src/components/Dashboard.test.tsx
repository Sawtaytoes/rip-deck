import {
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  mockDataSource,
  resetMockDrift,
} from "../api/mockDataSource"
import type { FixtureName } from "../fixture"
import { renderWithProviders } from "../testing/renderWithProviders"
import type { RipDeckDataSource } from "../types"
import { Dashboard } from "./Dashboard"

/**
 * The whole page, against the real fixture scenarios.
 *
 * Deliberately NOT a fake data source: these tests exist to
 * check that the states HANDOFF §8 lists as the reason rip-deck
 * exists survive the trip through `/json`'s shape and out onto
 * the screen. Substituting a hand-built document here would test
 * the components against a story instead of against the fixture
 * set.
 *
 * Each render gets a fresh query client and a fresh drift state,
 * so one test's poll cannot settle into the next one's
 * assertions.
 */

const showFixture = (fixture: FixtureName) =>
  renderWithProviders(
    <Dashboard fixture={fixture} />,
    mockDataSource,
  )

beforeEach(() => {
  resetMockDrift()
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("zero drives present", () => {
  // F3. The owner powers the tower independently of the host, so
  // an empty rack is how he normally leaves it. It is not an
  // error, and rendering it as one trains him to ignore errors.
  it("reads as switched off, not as a fault", async () => {
    showFixture("empty")

    expect(
      await screen.findByText(/the tower is switched off/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/collector failed/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/unreachable/i),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/0 bays/)).toBeInTheDocument()
  })
})

describe("nine concurrent rips", () => {
  it("shows every bay at once", async () => {
    showFixture("nine-rips")

    expect(
      await screen.findByText(/9 bays · 9 ripping/),
    ).toBeInTheDocument()

    // §3 + §12: the slot is its own field and the disc is the
    // headline. The card used to lead with
    // "0N - Pioneer BDR-211M", which said the slot twice and put
    // the drive above the disc.
    for (const slot of [1, 5, 9]) {
      expect(
        screen.getByText(`Slot ${slot}`),
      ).toBeInTheDocument()
      expect(
        screen.getByText(`Fixture Disc ${slot}`),
      ).toBeInTheDocument()
    }
  })

  it("says out loud that this is not the rack", async () => {
    showFixture("nine-rips")

    expect(
      await screen.findByText(/this is not the rack/i),
    ).toBeInTheDocument()
  })
})

describe("a hub fault across several bays", () => {
  // ONE problem with the hub, not four bad discs. Four cards
  // each saying "the disc may need cleaning" is four wrong
  // instructions, and it is the failure this model exists to
  // prevent.
  it("leads with one grouped alert naming all four bays", async () => {
    showFixture("hub-fault")

    const alerts = await screen.findByRole("region", {
      name: "Tower alerts",
    })

    expect(alerts).toHaveTextContent(
      "this is the hub or its power, not your discs",
    )
    expect(alerts).toHaveTextContent("4 bays")
    // Not four separate alerts. Counting `Alert`s rather than the
    // group's child `<div>`s, which is what this asserted before
    // M5 — a count of an element name is a count of the markup,
    // and it went to zero on a change that altered nothing about
    // what the page says.
    expect(
      alerts.querySelectorAll(":scope > section"),
    ).toHaveLength(1)
  })

  it("never tells the owner to clean a disc", async () => {
    showFixture("hub-fault")

    await screen.findByRole("region", {
      name: "Tower alerts",
    })

    expect(
      screen.queryByText(/Clean it and try again/),
    ).not.toBeInTheDocument()
  })

  it("states the cause once and has the cards defer to it", async () => {
    showFixture("hub-fault")

    // Four cards each repeating the same paragraph is four
    // paragraphs the reader has to work out are one problem —
    // the very thing the grouped alert exists to say.
    expect(
      await screen.findAllByText(/not your discs/),
    ).toHaveLength(1)
    expect(
      screen.getAllByText(/Part of the tower-wide problem/),
    ).toHaveLength(4)
  })

  it("does not promise a finish time for a bay that stopped answering", async () => {
    showFixture("hub-fault")

    // The fixture gives the stalled bays no ETA. A confident
    // "~15m left" on a drive that has gone quiet is worse than
    // no number at all.
    await screen.findAllByText(
      /Part of the tower-wide problem/,
    )

    expect(
      screen.queryByText(/left/),
    ).not.toBeInTheDocument()
  })

  it("says stalled rather than the ARM-flattened 'ripping'", async () => {
    showFixture("hub-fault")

    // `toArmStatus` folds ripping/throttled/stalled into one
    // word. Telling those three apart is most of why this
    // dashboard exists, so the card reads the native state.
    const slotFour = (
      await screen.findByText("Slot 4")
    ).closest("article")

    expect(slotFour).not.toBeNull()
    expect(
      within(slotFour as HTMLElement).getByText("stalled"),
    ).toBeInTheDocument()
  })
})

describe("suspected vs confirmed", () => {
  it("offers a retry on the suspected bay only", async () => {
    showFixture("confidence")

    const retries = await screen.findAllByRole("button", {
      name: "Retry in another drive",
    })

    // Bay 2 is the single-drive sighting; bay 8 is the second
    // drive that agreed, which is what upgrades it.
    expect(retries).toHaveLength(1)
    expect(
      screen.getByText(/retry in another drive to confirm/),
    ).toBeInTheDocument()
  })

  it("keeps both bays' verdicts in full rather than collapsing them", async () => {
    showFixture("confidence")

    // Two bays sharing `disc_dirty` are two discs — or one disc
    // deliberately re-tested in a second drive. Deferring them
    // to the summary the way a hub fault does would erase the
    // two-drive rule at the moment it is being applied.
    expect(
      await screen.findAllByText(/Clean it and try again/),
    ).toHaveLength(3)
    expect(
      screen.queryByText(/Part of the tower-wide problem/),
    ).not.toBeInTheDocument()
  })
})

describe("a rising ETA", () => {
  it("shows the trend and stays calm", async () => {
    showFixture("rising-eta")

    expect(
      await screen.findByText(/ETA rising/),
    ).toBeInTheDocument()
    // A rising ETA on a healthy disc happens: no alert, no
    // verdict, no red.
    expect(
      screen.queryByRole("region", {
        name: "Tower alerts",
      }),
    ).not.toBeInTheDocument()
  })
})

describe("a quarantined drive", () => {
  it("gives the out-of-service bay a card and its clear control", async () => {
    showFixture("quarantined")

    expect(
      await screen.findByText(
        /Pioneer BDR-211M · out of service/,
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /clear it once the drive has been looked at/i,
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "Clear quarantine",
      }),
    ).toBeInTheDocument()
  })

  it("clears only when the human presses the control", async () => {
    showFixture("quarantined")

    const clear = await screen.findByRole("button", {
      name: "Clear quarantine",
    })

    await userEvent.click(clear)

    await waitFor(() => {
      expect(
        screen.queryByText(
          /05 - Pioneer BDR-211M · out of service/,
        ),
      ).not.toBeInTheDocument()
    })
  })
})

describe("discs held at startup", () => {
  /**
   * The owner's own tower, tonight. Three Troy discs held by the
   * fail-closed startup branch, and his instruction was
   * explicit: "Flag it in the Web UI as well."
   */
  it("flags every held bay by name, with what to do", async () => {
    showFixture("held-at-startup")

    expect(
      await screen.findByText(
        /held · 3 discs Rip Deck would not rip without asking/,
      ),
    ).toBeInTheDocument()

    for (const slot of [7, 8, 9]) {
      expect(
        screen.getByText(`Slot ${slot}`),
      ).toBeInTheDocument()
    }

    expect(
      screen.getAllByText(/held — not ripped/),
    ).toHaveLength(3)

    // The daemon's own sentence, naming the physical next step —
    // said ONCE. The startup hold fires on every loaded bay at
    // once, so all three carry the identical paragraph, and
    // three copies of it bury the only thing that differs
    // between the cards: which disc is in which slot. The other
    // two point at it, the way `VerdictBadge` already points at
    // a hub fault.
    expect(
      screen.getAllByText(/Press Rip to rip it anyway/),
    ).toHaveLength(1)
    expect(
      screen.getAllByText("Same reason as above."),
    ).toHaveLength(2)
  })

  // The distinction that matters most on this page. Both bays
  // want a human; only one of them wants another copy of a disc.
  it("does not read like the failed rip beside it", async () => {
    showFixture("held-at-startup")

    expect(
      await screen.findAllByText(/Nothing failed\./),
    ).toHaveLength(3)

    // The failure keeps its own card, its own bucket and its
    // own advice.
    expect(
      screen.getByText("41 read errors"),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Source another copy/),
    ).toBeInTheDocument()
    // …and the held discs are not in that bucket.
    expect(
      screen.getByText(/needs attention · one bay/),
    ).toBeInTheDocument()
  })

  /**
   * `towerFeed` stamps a placeholder `unknown` verdict — "Not
   * enough information to judge this rip yet." — on every bay
   * with an outcome, so three held bays group into one alert.
   * Bannering it would put a sentence about a rip that never
   * ran above the cards, in the HARDWARE red tone, saying less
   * than the amber cards below it. Caught by screenshotting the
   * dev server, which is the method §4 exists to record.
   */
  it("does not banner the held bays as a tower-wide fault", async () => {
    showFixture("held-at-startup")

    await screen.findByText(
      /held · 3 discs Rip Deck would not rip without asking/,
    )

    expect(
      screen.queryByText(
        /Not enough information to judge this rip yet/,
      ),
    ).not.toBeInTheDocument()
  })

  // The chip would otherwise read "unknown", which describes
  // rip-deck's confidence rather than the bay.
  it("labels the held chips on the rail 'held'", async () => {
    showFixture("held-at-startup")

    expect(await screen.findAllByText("held")).toHaveLength(
      3,
    )
  })

  it("offers the tray control that releases the disc", async () => {
    showFixture("held-at-startup")

    const open = await screen.findAllByRole("button", {
      name: "Open tray",
    })

    // Three held bays and the failed one — every bay with a
    // disc rip-deck is finished with, and none that is ripping.
    expect(open).toHaveLength(4)

    await userEvent.click(open[0])

    await waitFor(() => {
      expect(
        screen.queryByText(
          /07 - Pioneer BDR-211M.*held — not ripped/,
        ),
      ).not.toBeInTheDocument()
    })
  })
})

describe("each verdict kind", () => {
  // All nine bays are mid-rip in this scenario, which is the
  // point: ARM could only compute a verdict at rip END, so "bay
  // 7 is struggling, go clean the disc" always arrived after the
  // rip had already failed. Every one of these cards is a
  // verdict on a rip that is still running.
  it("renders every verdict on a live card", async () => {
    showFixture("verdicts")

    // Dirty and scratched, side by side, with their opposite
    // advice intact.
    expect(
      await screen.findByText(/Clean it and try again/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Source another copy/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Suspect the drive, not the disc/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/MakeMKV's key has expired/),
    ).toBeInTheDocument()
    // `ok` is the default verdict and says nothing.
    expect(
      screen.queryByText("Reading normally."),
    ).not.toBeInTheDocument()
  })

  it("offers keep-trying and give-up on a troubled live rip", async () => {
    showFixture("verdicts")

    // D4: let a struggling rip keep chugging, or stop it. Eight
    // of the nine bays carry a non-ok verdict.
    expect(
      await screen.findAllByRole("button", {
        name: "Keep trying",
      }),
    ).toHaveLength(8)
  })
})

describe("a failing daemon", () => {
  it("says so rather than rendering an empty tower", async () => {
    const failing: RipDeckDataSource = {
      fetchState: () =>
        Promise.reject(new Error("/json failed: 503")),
      fetchLog: () => Promise.resolve(""),
      runBayAction: () =>
        Promise.resolve({ ok: false, msg: "" }),
      runTrayCommand: () =>
        Promise.reject(new Error("not used in this test")),
      fetchLeftovers: () =>
        Promise.reject(new Error("not used in this test")),
      deleteLeftover: () =>
        Promise.reject(new Error("not used in this test")),
      fetchHistory: () =>
        Promise.reject(new Error("not used in this test")),
    }

    renderWithProviders(
      <Dashboard fixture={null} />,
      failing,
    )

    expect(
      await screen.findByText(/Rip Deck unreachable/),
    ).toBeInTheDocument()
    // An unreachable daemon is NOT an empty rack, and must
    // never borrow the empty rack's calm wording.
    expect(
      screen.queryByText(/switched off/),
    ).not.toBeInTheDocument()
  })
})

/**
 * The live rack, 2026-07-26 — and the render that made three
 * successful 225 GB backups look like a fault.
 *
 * Every assertion here is a thing the deployed 0.5.0 dashboard
 * actually did, screenshotted at
 * `__screenshots__/2026-07-26-live-dashboard-0.5.0.png`. The
 * suite was green for all of it, because the suite had no
 * scenario in which a COMPLETED job carried a verdict other than
 * `ok`.
 */
describe("finished rips that nothing measured", () => {
  it("does not banner them as a fault", async () => {
    showFixture("unmeasured")

    await screen.findAllByText(/completed/)

    // A full-width red "Not enough information to judge this rip
    // yet." was the loudest thing on the page, above three
    // finished backups.
    expect(
      screen.queryByRole("region", {
        name: "Tower alerts",
      }),
    ).not.toBeInTheDocument()
  })

  it("does not file them under needs attention", async () => {
    showFixture("unmeasured")

    await screen.findAllByText(/completed/)

    expect(
      screen.queryByText(/needs attention/),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/^recent$/)).toBeInTheDocument()
  })

  // ⚠️ The dangerous one. On a completed 225 GB rip this invites
  // exactly the duplicate the bay ledger was built to prevent,
  // and it was offered on all three bays at once.
  it("offers no re-rip control at all", async () => {
    showFixture("unmeasured")

    await screen.findAllByText(/completed/)

    expect(
      screen.queryByRole("button", {
        name: "Retry in another drive",
      }),
    ).not.toBeInTheDocument()
  })

  it("drops the caveat and keeps what the rip did", async () => {
    showFixture("unmeasured")

    await screen.findAllByText(/completed/)

    // ⚠️ This used to assert the OPPOSITE — that "Not enough
    // information to judge this rip yet." stayed on the card,
    // quietly. The owner's answer was that it should not stay at
    // all: it is a statement about rip-deck's own build state,
    // it repeated on every finished bay, and there is nothing he
    // can do about it. `health/publish.ts` now decides when a
    // real verdict may replace it.
    expect(
      screen.queryByText(
        /Not enough information to judge this rip yet/,
      ),
    ).not.toBeInTheDocument()

    // What the rip itself did is a different thing and survives.
    expect(
      await screen.findAllByText(
        /held on startup: the bay ledger already had this disc/,
      ),
    ).toHaveLength(3)

    // And still with no invitation to re-rip attached to it.
    expect(
      screen.queryByText(
        /retry in another drive to confirm/,
      ),
    ).not.toBeInTheDocument()
  })

  it("says nothing where it has no disc name", async () => {
    showFixture("unmeasured")

    await screen.findAllByText(/completed/)

    // Every card read `disc (unknown)` on the live page. The
    // name is not recoverable on this side: `towerFeed` gives an
    // adopted bay `identity: null` and puts the real name only
    // inside the outcome's English sentence, which its own
    // header says not to parse.
    expect(
      screen.queryByText(/· disc /),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/\(unknown\)/),
    ).not.toBeInTheDocument()
  })

  it("still offers the tray control that hands the discs back", async () => {
    showFixture("unmeasured")

    expect(
      await screen.findAllByRole("button", {
        name: "Open tray",
      }),
    ).toHaveLength(3)
  })
})

/**
 * §1. The product is Rip Deck; `rip-deck` is what you type.
 *
 * The owner read the lowercase `<h1>` and asked whether the page
 * was showing him the Docker image name.
 */
describe("what the page calls itself", () => {
  it("is Rip Deck, two words, title-cased", async () => {
    showFixture("nine-rips")

    expect(
      await screen.findByRole("heading", {
        name: /Rip Deck/,
      }),
    ).toBeInTheDocument()
  })
})

/**
 * §2. The bulk control at the top.
 *
 * > "We can have a 'open all complete' button somewhere at the
 * > top."
 */
describe("the tray controls", () => {
  it("reports what the daemon answered", async () => {
    showFixture("unmeasured")

    const open = await screen.findByRole("button", {
      name: /Open trays/,
    })

    await userEvent.click(open)

    // Three finished bays. The report is the daemon's sentence,
    // rendered rather than re-summarised here.
    expect(
      await screen.findByText(/Opened 3 drives\./),
    ).toBeInTheDocument()
  })

  /**
   * ⚠️ The sentence that matters most. A bay that is ripping is
   * REFUSED, the command still succeeds everywhere else, and the
   * refusal resolves — `is_accepted: true` with a per-bay
   * `refused_ripping`. Treating that as an error would throw
   * away the only line telling the owner that bay 4 still holds
   * a rip.
   */
  it("names the bay it would not touch", async () => {
    showFixture("nine-rips")

    const open = await screen.findByRole("button", {
      name: /Open trays/,
    })

    await userEvent.click(open)

    expect(
      await screen.findByText(/Refused to open 9 drives/),
    ).toBeInTheDocument()
    expect(
      screen.getAllByText(
        /Opening the tray now would destroy/,
      ),
    ).not.toHaveLength(0)
  })

  // A control above a switched-off tower has nothing behind it,
  // and pressing it teaches the owner the button does nothing.
  it("is not offered when there is no rack", async () => {
    showFixture("empty")

    await screen.findByText(/the tower is switched off/i)

    expect(
      screen.queryByRole("button", {
        name: /Open trays/,
      }),
    ).not.toBeInTheDocument()
  })
})

/**
 * §4. Columns: auto by default, overridable, remembered.
 */
describe("the column layout", () => {
  const gridColumns = (): string[] =>
    Array.from(
      document.querySelectorAll("[data-columns]"),
    ).map((grid) => grid.getAttribute("data-columns") ?? "")

  it("lays every bucket out at the same width", async () => {
    showFixture("held-at-startup")

    await screen.findByText(
      /held · 3 discs Rip Deck would not rip without asking/,
    )

    // Held, needs-attention and recent are one page, not three.
    expect(new Set(gridColumns()).size).toBe(1)
  })

  it("takes the number the owner picked", async () => {
    showFixture("nine-rips")

    await screen.findByText(/9 bays · 9 ripping/)
    // `radio`, not `button`: the five choices are mutually
    // exclusive and now say so. Five `aria-pressed` buttons said
    // only that each one was independently on or off.
    await userEvent.click(
      screen.getByRole("radio", { name: "3" }),
    )

    expect(gridColumns()).toContain("3")
    expect(
      window.localStorage.getItem(
        "rip-deck.layout-columns",
      ),
    ).toBe("3")
  })

  // ⚠️ Not a one-way door: `auto` stays in the row, so a layout
  // tried once can be handed back.
  it("keeps auto reachable after a manual choice", async () => {
    showFixture("nine-rips")

    await screen.findByText(/9 bays · 9 ripping/)
    await userEvent.click(
      screen.getByRole("radio", { name: "4" }),
    )
    expect(gridColumns()).toContain("4")

    await userEvent.click(
      screen.getByRole("radio", { name: /^auto/ }),
    )

    expect(gridColumns()).not.toContain("4")
    expect(
      window.localStorage.getItem(
        "rip-deck.layout-columns",
      ),
    ).toBe("auto")
  })

  /**
   * The card decides its own density from the space it was
   * handed, not from the window — at three columns on a wide
   * monitor a card is phone-shaped while the viewport is not.
   * This is the contract `RipCard` reads.
   */
  it("gives every card its own query container", async () => {
    showFixture("nine-rips")

    await screen.findByText(/9 bays · 9 ripping/)

    expect(
      document.querySelectorAll(".\\@container\\/bay"),
    ).toHaveLength(9)
  })
})

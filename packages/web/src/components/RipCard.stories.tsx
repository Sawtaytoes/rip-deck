import type { Meta, StoryObj } from "@storybook/react-vite"

import { createStubDataSource } from "../testing/stubDataSource"
import type { Rip } from "../types"
import {
  AppProviders,
  createQueryClient,
} from "./AppProviders"
import { RipCard } from "./RipCard"

/**
 * A fixed `now` so elapsed/ETA text is deterministic across
 * reloads and the visual-regression eye — the same instant
 * `RipCard.test.tsx` pins.
 */
const NOW = new Date("2026-07-26 12:12:00").getTime()

/**
 * An inline SVG poster rather than a network image: it decodes
 * synchronously and needs no fetch, so the enlarged 2:3 thumbnail
 * is deterministic in CI. `poster` is `null` on every live bay
 * today (the fetcher is still being built), so a story is the only
 * place the poster slot is exercised at all.
 */
const POSTER = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="#1B1B2F"/><rect x="14" y="14" width="172" height="272" fill="none" stroke="#C9A227" stroke-width="2"/><text x="100" y="150" fill="#C9A227" font-family="Georgia, serif" font-size="26" letter-spacing="2" text-anchor="middle">THE</text><text x="100" y="184" fill="#F5F3E7" font-family="Georgia, serif" font-size="24" letter-spacing="2" text-anchor="middle">OUTFIT</text></svg>`,
)}`

const buildRip = (overrides: Partial<Rip> = {}): Rip => ({
  job_id: 3_141_592,
  status: "ripping",
  kind: "bluray",
  label: "The Outfit",
  drive: "/dev/sr2",
  path: "/data/Film/Disc-Rips/The Outfit",
  percent: 19,
  stage: "Copying file",
  active: true,
  logfile: "the-outfit-slot7.log",
  ejected: false,
  poster: null,
  drive_name: "07 - Pioneer BDR-211M",
  tray: "closed",
  start: "2026-07-26 12:00:00",
  stop: null,
  job_uuid: "ace3f66f-a4a6-4847-be91-c5369e3119f3",
  drive_id: "2-1.3.3",
  slot: 7,
  disctype: "bluray",
  disctype_label: "Blu-ray",
  volume_label: "THE_OUTFIT",
  eta_seconds: 2_340,
  eta_trend: "rising",
  throughput_bytes_per_sec: 16.3 * 1024 * 1024,
  read_error_count: 0,
  warnings: [],
  verdict: "ok",
  verdict_message: "Reading normally.",
  verdict_confidence: "suspected",
  failure_reason: null,
  is_adopted: false,
  is_keep_trying_requested: false,
  ...overrides,
})

const noop = () => {
  // stories do not assert on the callbacks
}

const meta = {
  title: "Rip Deck/RipCard",
  component: RipCard,
  parameters: { layout: "padded" },
  // Two things the app gives this card that a bare render does not:
  //
  //  - **Providers.** The card owns a `useTrayCommand`, so even a
  //    story that never presses ⏏ needs a query client and a data
  //    source — the same providers `renderWithProviders` gives the
  //    tests, a fresh client per render so one story's poll never
  //    settles into another.
  //  - **The `bay` container.** The card deliberately declares no
  //    container of its own and relies on `BayGrid`'s
  //    `@container/bay` cell (see RipCard's own note). Without it
  //    every `@md/bay:` utility silently loses — the poster size
  //    (`@md/bay:w-28`) stays at the narrow `w-16` and the wide-only
  //    drive-info block (`@max-md/bay:hidden`) shows unconditionally.
  //    `w-full` gives the container a definite inline size (a bare
  //    `@container` in a shrink-to-fit context collapses to
  //    min-content), and 42rem clears the 28rem / 448px `@md/bay:`
  //    threshold so the story renders the full-density card.
  decorators: [
    (Story) => (
      <AppProviders
        dataSource={createStubDataSource()}
        queryClient={createQueryClient()}
      >
        <div className="@container/bay w-full max-w-2xl">
          <Story />
        </div>
      </AppProviders>
    ),
  ],
  args: {
    now: NOW,
    onAction: noop,
    onShowLog: noop,
    // A default so `render`-based stories (AllStates) satisfy the
    // required `rip` prop without restating it — the stories that
    // want a specific state override it.
    rip: buildRip(),
  },
} satisfies Meta<typeof RipCard>

export default meta

type Story = StoryObj<typeof meta>

/** A healthy Blu-ray mid-rip — the common case. */
export const Ripping: Story = {
  args: { rip: buildRip() },
}

/**
 * With the poster populated: the enlarged 2:3 thumbnail, clickable
 * to open full-size through Charcuterie's `Lightbox`. Invisible on
 * every live bay until the poster fetcher lands, so this story is
 * the only place it renders at all.
 */
export const WithPoster: Story = {
  args: { rip: buildRip({ poster: POSTER }) },
}

/**
 * Health engine flags a scratched disc, and there are read errors.
 * The one rule that overrides everything: a rip with read errors is
 * never reported as success.
 */
export const HealthWarning: Story = {
  args: {
    rip: buildRip({
      poster: POSTER,
      read_error_count: 12,
      verdict: "disc_scratched",
      verdict_confidence: "confirmed",
      verdict_message:
        "12 read errors clustered near the disc edge — a scratch, most likely.",
      eta_trend: "rising",
    }),
  },
}

/** A finished rip. `status: "success"` is one of the two special-cased. */
export const Completed: Story = {
  args: {
    rip: buildRip({
      status: "success",
      stage: "Done",
      percent: 100,
      active: false,
      eta_seconds: 0,
      eta_trend: null,
      stop: "2026-07-26 12:39:00",
      verdict_message: "Saved 78 titles, no read errors.",
    }),
  },
}

/** A failed rip. `status: "fail"` is the other special-cased value. */
export const Failed: Story = {
  args: {
    rip: buildRip({
      status: "fail",
      stage: "Stopped",
      active: false,
      percent: null,
      read_error_count: 204,
      verdict: "drive_failing",
      verdict_confidence: "confirmed",
      verdict_message:
        "The drive stopped responding mid-read.",
      failure_reason: "drive stopped responding",
      eta_seconds: null,
      eta_trend: null,
    }),
  },
}

/**
 * Every state stacked, so a scheme flip in the toolbar re-themes
 * the whole set at once — the fastest way to spot a hardcoded
 * colour that does not follow `data-scheme` (RipCard still carries
 * 57 of them).
 */
export const AllStates: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      <RipCard
        {...args}
        rip={buildRip({ poster: POSTER })}
      />

      <RipCard
        {...args}
        rip={buildRip({
          read_error_count: 12,
          verdict: "disc_scratched",
          verdict_confidence: "confirmed",
          verdict_message: "A scratch, most likely.",
        })}
      />

      <RipCard
        {...args}
        rip={buildRip({
          status: "success",
          stage: "Done",
          percent: 100,
          active: false,
          verdict_message:
            "Saved 78 titles, no read errors.",
        })}
      />

      <RipCard
        {...args}
        rip={buildRip({
          status: "fail",
          stage: "Stopped",
          active: false,
          percent: null,
          read_error_count: 204,
          verdict: "drive_failing",
          failure_reason: "drive stopped responding",
        })}
      />
    </div>
  ),
}

/**
 * One card per disc type, so the marks can be compared side by
 * side and checked against a colour-scheme flip in the toolbar.
 *
 * > *"Rip Deck uses these diamond and square emojis for the
 * > different types of discs. Can we just add the CD/DVD/BD/UHD
 * > BD logos next to it for the type of disc instead?"*
 *
 * The two that matter most are Blu-ray and 4K. They were a blue
 * diamond and a blue square, which is the pair the daemon works
 * hardest to keep apart (`armView.toArmKind` will not flatten a
 * 4K disc into `bluray`) and the pair the old glyphs made look
 * most alike. `data` is last and wears the drawn fallback: a
 * data disc carries whichever mark its blank was pressed with,
 * so there is no logo to be right about.
 *
 * ⚠️ Check this story in BOTH schemes. The CD and DVD wordmarks
 * follow `currentColor` because that is how they are printed;
 * a hardcoded white would vanish against the light surface.
 */
export const EveryDiscKind: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      {(
        [
          ["music", "cd", "Audio CD", "Kind of Blue"],
          ["dvd", "dvd", "DVD", "Ivanhoe"],
          ["bluray", "bluray", "Blu-ray", "The Outfit"],
          ["uhd", "uhd", "4K", "Dune Part Two"],
          ["data", "unknown", null, "BACKUP_2019"],
        ] as const
      ).map(([kind, disctype, label, title], index) => (
        <RipCard
          {...args}
          key={kind}
          rip={buildRip({
            disctype,
            disctype_label: label,
            drive_name: `0${index + 1} - Pioneer BDR-211M`,
            kind,
            label: title,
            path: `/data/Film/Disc-Rips/${title}`,
            slot: index + 1,
          })}
        />
      ))}
    </div>
  ),
}

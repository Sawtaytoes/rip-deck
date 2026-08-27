import { makeVerdict } from "@rip-deck/contracts"
import type { Meta, StoryObj } from "@storybook/react-vite"

import type { BayView } from "../types"
import { DriveRail } from "./DriveRail"

/**
 * The rail is nine chips, and its whole job is that a glance at
 * the row answers "does anything want me?". So the story that
 * matters is the WHOLE row at once: a chip's colour is only ever
 * read against the eight beside it.
 *
 * These are hand-built `BayView`s rather than a `mockDataSource`
 * fixture, because no fixture holds one bay per chip state — the
 * scenarios are each about one situation. The rail is about the
 * contrast between them.
 */
const buildBay = (input: {
  slot: number
  state: BayView["state"]["state"]
  verdict?: BayView["state"]["verdict"]
  percent?: number
  hasWarnings?: boolean
  isQuarantined?: boolean
}): BayView => ({
  drive_id: `usb-slot-${input.slot}`,
  label: `0${input.slot} - Pioneer BDR-211M`,
  slot: input.slot,
  dev_path: `/dev/sr${input.slot}`,
  is_present: true,
  is_quarantined: input.isQuarantined ?? false,
  quarantine_reason: null,
  state: {
    drive: `0${input.slot} - Pioneer BDR-211M`,
    slot: input.slot,
    state: input.state,
    job_id: `story-job-${input.slot}`,
    title: "Ivanhoe",
    disctype: "bluray",
    progress_percent: input.percent ?? 0,
    eta_seconds: null,
    eta_trend: null,
    throughput_bytes_per_sec: null,
    read_error_count: input.hasWarnings === true ? 4 : 0,
    has_warnings: input.hasWarnings ?? false,
    verdict: makeVerdict(
      input.verdict ?? "ok",
      "suspected",
      [],
    ).kind,
    updated_at: 0,
  },
  state_topic: `rip-deck/tower/drive/usb_slot_${input.slot}`,
  alert: null,
  alert_topic: `rip-deck/tower/drive/usb_slot_${input.slot}/alert`,
  verdict_confidence: "suspected",
  is_announceable: false,
  actions: [],
})

const meta = {
  title: "Rip Deck/DriveRail",
  component: DriveRail,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DriveRail>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Every chip state the rail can show, in one row.
 *
 * Slot 03 is the one this story was written for. A rip that
 * FAILED produced no backup, and the chip used to paint it the
 * same green as slot 02, which produced a 90 GB one — because
 * `failed` sat in a "latched" set beside `completed`. Slot 04
 * shows the other half: the owner's own cancel is not an alarm,
 * and it is not a success either. Slot 08 is the third state —
 * a rip that WORKED and has something wrong with it.
 */
export const EveryState: Story = {
  args: {
    bays: [
      buildBay({ slot: 1, state: "ripping", percent: 43 }),
      buildBay({ slot: 2, state: "completed" }),
      buildBay({ slot: 3, state: "failed" }),
      buildBay({ slot: 4, state: "cancelled" }),
      buildBay({
        slot: 5,
        state: "failed",
        verdict: "disc_scratched",
      }),
      buildBay({ slot: 6, state: "needs_attention" }),
      buildBay({
        slot: 7,
        state: "completed",
        isQuarantined: true,
      }),
      buildBay({
        slot: 8,
        state: "completed",
        hasWarnings: true,
      }),
      buildBay({ slot: 9, state: "idle" }),
    ],
  },
}

/**
 * The three finished outcomes, and only those.
 *
 * The row that made this story necessary: `done`, `warning` and
 * `failed` have to be three colours a glance from the doorway
 * tells apart. Slot 05 is a real rip — a CSS DVD that reached
 * `Backup done`, left a mountable 8 GB ISO and hit one bad
 * sector. It wore slot 08's colours until 2026-08-27
 * ([decision](https://mkdocs.octen.dev/workspace/rip-deck/docs/decisions/2026-08-27-a-read-error-on-a-verified-backup-is-a-warning-not-a-failure/)).
 */
export const ThreeOutcomes: Story = {
  args: {
    bays: [
      buildBay({ slot: 1, state: "completed" }),
      buildBay({
        slot: 5,
        state: "completed",
        hasWarnings: true,
      }),
      buildBay({ slot: 8, state: "failed" }),
      // A HELD bay, for the contrast that matters most: it is
      // the same hue as the warning and a louder fill, because
      // it wants the owner NOW.
      buildBay({ slot: 9, state: "needs_attention" }),
    ],
  },
}

/**
 * The reported state on its own: one bay whose rip failed, with
 * the placeholder `unknown` verdict `towerFeed` stamps on
 * anything the health engine never judged. That verdict asks for
 * nothing, so nothing else on the card is loud — the chip is the
 * only thing saying the backup does not exist.
 */
export const FailedAndUnmeasured: Story = {
  args: {
    bays: [
      buildBay({ slot: 1, state: "completed" }),
      buildBay({
        slot: 2,
        state: "failed",
        verdict: "unknown",
      }),
      buildBay({ slot: 3, state: "idle" }),
    ],
  },
}

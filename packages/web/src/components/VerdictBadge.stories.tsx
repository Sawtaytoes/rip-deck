import type { Meta, StoryObj } from "@storybook/react-vite"

import { VerdictBadge } from "./VerdictBadge"

/**
 * Pure props, no providers — the health engine's verdict as the
 * operator reads it. `ok` renders nothing on purpose (a calm chip
 * on all nine bays is nine chips saying nothing), so there is no
 * `ok` story to look at.
 */
const meta = {
  title: "Rip Deck/VerdictBadge",
  component: VerdictBadge,
  parameters: { layout: "padded" },
  args: {
    confidence: "confirmed",
    evidence: [],
    isShared: false,
  },
} satisfies Meta<typeof VerdictBadge>

export default meta

type Story = StoryObj<typeof meta>

export const Scratched: Story = {
  args: {
    verdict: "disc_scratched",
    message:
      "12 read errors clustered near the disc edge — a scratch, most likely.",
    evidence: [
      "read_error_count = 12",
      "errors clustered at 92–98% of the disc radius",
    ],
  },
}

/** `suspected` reads differently from `confirmed` — only `confirmed` may announce. */
export const SuspectedDirty: Story = {
  args: {
    verdict: "disc_dirty",
    confidence: "suspected",
    message:
      "Throughput keeps dipping — the disc may need a wipe.",
  },
}

export const DriveFailing: Story = {
  args: {
    verdict: "drive_failing",
    message: "The drive stopped responding mid-read.",
    evidence: ["204 read errors", "no progress for 90s"],
  },
}

/**
 * Shared: this bay's trouble is one a tower-wide alert already
 * states in full, so the badge defers rather than repeating it nine
 * times.
 */
export const SharedWithTower: Story = {
  args: {
    verdict: "hub_fault",
    isShared: true,
    message: "Part of the tower-wide problem above.",
  },
}

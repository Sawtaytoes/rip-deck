import { makeVerdict } from "@rip-deck/contracts"

import type { BayView, Rip } from "../types"

/**
 * A healthy mid-rip `Rip`, so a test only has to name what it is
 * actually about.
 *
 * Deliberately NOT wired to `mockDataSource`: these are unit
 * fixtures for one card, and a test that has to describe a whole
 * nine-bay tower to assert one badge is a test nobody reads.
 * `mockDataSource.test.ts` is where the daemon-shaped scenarios
 * are pinned.
 */
export const buildRip = (
  overrides: Partial<Rip> = {},
): Rip => ({
  job_id: 3_141_592,
  status: "ripping",
  kind: "bluray",
  label: "Ivanhoe",
  drive: "/dev/sr2",
  path: "/media/Disc-Rips/Ivanhoe",
  percent: 43,
  stage: "Saving file 3 of 78",
  active: true,
  logfile: null,
  ejected: false,
  poster: null,
  drive_name: "07 - Pioneer BDR-211M",
  tray: "unknown",
  start: "2026-07-26 12:00:00",
  stop: null,
  job_uuid: "fixture-job-7",
  drive_id: "usb-2-1-1-2-4-4-7",
  slot: 7,
  disctype: "bluray",
  disctype_label: "Blu-ray",
  volume_label: "IVANHOE",
  eta_seconds: 900,
  eta_trend: "falling",
  throughput_bytes_per_sec: 21 * 1024 * 1024,
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

/** The native view of the same bay. */
export const buildBayView = (
  overrides: Partial<BayView> = {},
): BayView => {
  const verdict = makeVerdict("ok", "suspected", [])

  return {
    drive_id: "usb-2-1-1-2-4-4-7",
    label: "07 - Pioneer BDR-211M",
    slot: 7,
    dev_path: "/dev/sr2",
    is_present: true,
    is_quarantined: false,
    quarantine_reason: null,
    state: {
      drive: "07 - Pioneer BDR-211M",
      slot: 7,
      state: "ripping",
      job_id: "fixture-job-7",
      title: "Ivanhoe",
      disctype: "bluray",
      progress_percent: 43,
      eta_seconds: 900,
      eta_trend: "falling",
      throughput_bytes_per_sec: 21 * 1024 * 1024,
      read_error_count: 0,
      verdict: verdict.kind,
      updated_at: 0,
    },
    state_topic: "rip-deck/tower/drive/usb_2_1_1_2_4_4_7",
    alert: null,
    alert_topic:
      "rip-deck/tower/drive/usb_2_1_1_2_4_4_7/alert",
    verdict_confidence: "suspected",
    is_announceable: false,
    actions: ["cancel"],
    ...overrides,
  }
}

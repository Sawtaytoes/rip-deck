import type {
  RipDeckDataSource,
  TrayBayReport,
  TrayCommandReport,
} from "../types"

/**
 * A data source that answers nothing, for card tests.
 *
 * `mockDataSource` is a whole simulated rack and is pinned by
 * its own suite; a test about one card's ⏏ button should not
 * have to describe nine bays to press it. Every member throws
 * unless the test overrode it, so a card that quietly starts
 * fetching something shows up as a failure rather than as a
 * hang.
 */
export const createStubDataSource = (
  overrides: Partial<RipDeckDataSource> = {},
): RipDeckDataSource => ({
  fetchState: () => {
    throw new Error("stub: fetchState not provided")
  },
  fetchLog: () => {
    throw new Error("stub: fetchLog not provided")
  },
  runBayAction: () => {
    throw new Error("stub: runBayAction not provided")
  },
  runTrayCommand: () => {
    throw new Error("stub: runTrayCommand not provided")
  },
  fetchLeftovers: () => {
    throw new Error("stub: fetchLeftovers not provided")
  },
  deleteLeftover: () => {
    throw new Error("stub: deleteLeftover not provided")
  },
  fetchHistory: () => {
    throw new Error("stub: fetchHistory not provided")
  },
  renameLeftover: () => {
    throw new Error("stub: renameLeftover not provided")
  },
  ...overrides,
})

export const buildTrayBayReport = (
  overrides: Partial<TrayBayReport> = {},
): TrayBayReport => ({
  drive_id: "usb-2-1-1-2-4-4-7",
  slot: 7,
  label: "07 - Pioneer BDR-211M",
  result: "opened",
  detail: "Slot 7 opened.",
  ...overrides,
})

/**
 * One tray answer.
 *
 * `is_accepted: true` with a `refused_ripping` bay is the case
 * worth remembering: the daemon heard the command and said no
 * about that one bay. A test that only sets the top-level flag
 * is testing the shape the UI must NOT believe.
 */
export const buildTrayCommandReport = (
  overrides: Partial<TrayCommandReport> = {},
): TrayCommandReport => ({
  request_id: null,
  command: "open_bay",
  is_accepted: true,
  message: "Opened 1 tray.",
  started_at: 0,
  finished_at: 1,
  counts: {
    opened: 1,
    opened_not_ripped: 0,
    closed: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
  },
  bays: [buildTrayBayReport()],
  ...overrides,
})

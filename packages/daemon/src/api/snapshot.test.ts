import { describe, expect, it } from "vitest"
import {
  createBaySnapshot,
  createTowerStore,
} from "./snapshot.ts"

/**
 * The store is the API's only source of truth, and it is a
 * MEMORY read on purpose: the parent process must never make a
 * device call, because a drive wedged in D-state would freeze
 * all nine bays' monitoring and this API with them.
 */

describe("the tower store", () => {
  it("holds all nine bays at once", () => {
    const store = createTowerStore()

    for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      store.setBay({
        bay: createBaySnapshot({
          driveId: `usb-2-1-1-2-4-4-${slot}`,
          label: `0${slot} - Pioneer BDR-211M`,
          slot,
        }),
      })
    }

    expect(store.readSnapshot().bays).toHaveLength(9)
  })

  it("orders bays the way the owner walks up to the rack", () => {
    const store = createTowerStore()

    for (const slot of [7, 1, 4]) {
      store.setBay({
        bay: createBaySnapshot({
          driveId: `usb-2-1-1-2-4-4-${slot}`,
          label: `0${slot} - Pioneer BDR-211M`,
          slot,
        }),
      })
    }

    store.setBay({
      bay: createBaySnapshot({
        driveId: "usb-unplaced",
        label: "Unknown drive",
      }),
    })

    expect(
      store.readSnapshot().bays.map((bay) => bay.slot),
    ).toEqual([1, 4, 7, null])
  })

  it("replaces a bay rather than duplicating it", () => {
    const store = createTowerStore()

    const bay = createBaySnapshot({
      driveId: "usb-2-1-1-2-4-4-2",
      label: "02 - Pioneer BDR-211M",
      slot: 2,
    })

    store.setBay({ bay })
    store.setBay({ bay: { ...bay, isPresent: false } })

    const bays = store.readSnapshot().bays

    expect(bays).toHaveLength(1)
    expect(bays[0].isPresent).toBe(false)
  })

  it("forgets a drive that has gone away", () => {
    const store = createTowerStore()

    store.setBay({
      bay: createBaySnapshot({
        driveId: "usb-2-1-1-2-4-4-2",
        label: "02 - Pioneer BDR-211M",
        slot: 2,
      }),
    })
    store.removeBay({ driveId: "usb-2-1-1-2-4-4-2" })

    const snapshot = store.readSnapshot()

    expect(snapshot.bays).toEqual([])
    // F3: an empty rack is the tower being switched off. It is
    // not a collector failure and must not be reported as one.
    expect(snapshot.collectorError).toBe("")
  })

  it("reports a real collector failure when told to", () => {
    const store = createTowerStore()

    store.setCollectorError({
      error: "registry file unreadable",
    })

    expect(store.readSnapshot().collectorError).toBe(
      "registry file unreadable",
    )
  })

  it("defaults to the host label the viewer already uses", () => {
    expect(createTowerStore().readSnapshot().host).toBe(
      "tower",
    )
  })
})

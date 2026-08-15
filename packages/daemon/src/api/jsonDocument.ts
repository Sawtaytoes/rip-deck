import type { TopicConfig } from "../mqtt/topics.ts"
import { type ArmHost, buildArmState } from "./armView.ts"
import type { TowerSnapshot } from "./snapshot.ts"
import {
  buildTowerView,
  type TowerView,
} from "./towerView.ts"

/**
 * What `GET /json` returns.
 *
 * ONE document with two readers:
 *
 *  - `hosts` is exactly the ARM viewer's `ArmState`, so the
 *    dashboard that already exists can be pointed here with a
 *    base-URL change and nothing else.
 *  - `rip-deck` is the native view: every bay's live MQTT payload,
 *    the verdict cards including the `suspected` ones MQTT
 *    withholds, and the grouped tower alerts.
 *
 * Shipping both in one response rather than on two endpoints is
 * deliberate — two endpoints polled independently would show the
 * dashboard two different instants of a nine-bay tower, and the
 * disagreement would look like a bug in the rips.
 */
export type RipDeckJsonDocument = {
  hosts: ArmHost[]
  ripDeck: TowerView
}

export const buildJsonDocument = (input: {
  snapshot: TowerSnapshot
  nowMs: number
  isFake?: boolean
  fixture?: string | null
  topicConfig?: TopicConfig
}): RipDeckJsonDocument => ({
  hosts: buildArmState({ snapshot: input.snapshot }).hosts,
  ripDeck: buildTowerView(input),
})

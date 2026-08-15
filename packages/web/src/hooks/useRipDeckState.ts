import { useQuery } from "@tanstack/react-query"

import { pollMs } from "../env"
import type { FixtureName } from "../fixture"
import type { RipDeckState } from "../types"
import { useDataSource } from "./useDataSource"

/** The one query key the whole app invalidates against. */
export const RIP_DECK_STATE_KEY = "rip-deck-state"

/**
 * Poll `/json` every `pollMs`.
 *
 * Ported from `useArmState`, renamed because the document is no
 * longer ARM's — it is `RipDeckJsonDocument`, of which the
 * ARM-shaped `hosts` array is one half.
 *
 * `placeholderData` keeps the last good document on screen while
 * a refetch is in flight. That matters more here than it did in
 * the viewer: nine cards flashing empty every three seconds is
 * unreadable, and a dashboard that blinks is one nobody watches
 * during a rip.
 */
export function useRipDeckState(
  fixture: FixtureName | null,
) {
  const dataSource = useDataSource()

  return useQuery<RipDeckState>({
    queryKey: [RIP_DECK_STATE_KEY, fixture],
    queryFn: () => dataSource.fetchState(fixture),
    refetchInterval: pollMs,
    refetchIntervalInBackground: true,
    placeholderData: (previous) => previous,
  })
}

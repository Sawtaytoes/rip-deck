import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useState } from "react"

import type { Leftover } from "../types"
import { useDataSource } from "./useDataSource"

/** The query key the delete writes its own answer into. */
export const LEFTOVERS_KEY = "rip-deck-leftovers"

/**
 * The folders a rip left behind, and clearing one.
 *
 * ## Why this is not on the 5-second poll
 *
 * `useRipDeckState` polls `/json` forever, and this deliberately
 * does not join it. Listing leftovers means walking each one's
 * tree to size it, and a half-finished UHD rip is 40 GB of
 * `stat` calls — twelve times a minute, for a panel that is
 * usually empty. So it is fetched when the panel mounts and after
 * a delete, and never on a timer.
 *
 * ## Why the delete writes the cache instead of invalidating it
 *
 * `POST /api/leftovers` answers with the REMAINING list, computed
 * by the daemon after the removal. Writing that straight into the
 * cache means the row disappears the moment the answer lands,
 * with no second round trip and no window where a deleted folder
 * is still on screen with a live Delete button beside it.
 *
 * ## Why a refusal is not an error
 *
 * The daemon refuses to delete a FINISHED rip, and says so. That
 * sentence is the most useful thing this endpoint produces — it
 * is how the operator learns the duplicate he is looking at is a
 * real rip and not litter — so it is rendered as an answer, not
 * thrown. `lastMessage` carries it either way; `isLastRefused`
 * says which it was.
 */
export function useLeftovers(): {
  leftovers: Leftover[]
  isLoading: boolean
  loadError: string | null
  clear: (path: string) => void
  /** The path currently being deleted, so one row can spin. */
  pendingPath: string | null
  lastMessage: string | null
  isLastRefused: boolean
} {
  const dataSource = useDataSource()
  const queryClient = useQueryClient()
  const [lastMessage, setLastMessage] = useState<
    string | null
  >(null)
  const [isLastRefused, setIsLastRefused] = useState(false)
  const [pendingPath, setPendingPath] = useState<
    string | null
  >(null)

  const listed = useQuery<Leftover[]>({
    queryKey: [LEFTOVERS_KEY],
    queryFn: () => dataSource.fetchLeftovers(),
  })

  const deleting = useMutation({
    mutationFn: (path: string) =>
      dataSource.deleteLeftover({ path }),
    onMutate: (path: string) => {
      setPendingPath(path)
      setLastMessage(null)
    },
    onSuccess: (result) => {
      // The daemon's own words, whichever way it went.
      setLastMessage(result.msg)
      setIsLastRefused(!result.ok)
      queryClient.setQueryData<Leftover[]>(
        [LEFTOVERS_KEY],
        result.leftovers,
      )
    },
    onError: (error: unknown) => {
      // No answer at all — a 503, a 405, a dead network. Distinct
      // from a refusal, and it must not read like one: nothing
      // was decided, so nothing is known about the folder.
      setLastMessage(
        error instanceof Error
          ? error.message
          : String(error),
      )
      setIsLastRefused(true)
    },
    onSettled: () => setPendingPath(null),
  })

  return {
    leftovers: listed.data ?? [],
    isLoading: listed.isLoading,
    loadError:
      listed.error === null || listed.error === undefined
        ? null
        : listed.error instanceof Error
          ? listed.error.message
          : String(listed.error),
    clear: (path: string) => deleting.mutate(path),
    pendingPath,
    lastMessage,
    isLastRefused,
  }
}

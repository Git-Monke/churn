import { useQuery } from "@tanstack/react-query";

import { fetchResume } from "@/api/client";
import type { ContinueWatchingItem } from "@/api/types";

/**
 * Jellyfin's own resume list for the signed-in profile. The backend forwards the
 * user's token, so each profile sees its own progress and there is nothing to
 * persist in Churn.
 *
 * A signed-out, unconfigured, unreachable or empty list all yield `[]`, which
 * hides the row instead of showing an error: the rest of the library still
 * works. The auth provider clears the query cache on sign in/out, so the key
 * needs no user id.
 */
export function useContinueWatching(): ContinueWatchingItem[] {
  const query = useQuery({
    queryKey: ["resume"],
    queryFn: fetchResume,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  return query.data?.state === "ok" ? query.data.items : [];
}

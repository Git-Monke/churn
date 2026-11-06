import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchLibrary, fetchRequestedLibrary } from "@/api/client";
import {
  findTitleAttribution,
  type MediaAddedBy,
  type TitleIdentity,
} from "@/features/title/attribution";

/**
 * Attribution for a detail page. Reuses the library page's query keys so a
 * visit to either page serves both, but never adds polling here.
 */
export function useTitleAttribution(
  identity: TitleIdentity,
  playable: boolean,
): MediaAddedBy | undefined {
  const libraryQuery = useQuery({
    queryKey: ["library"],
    queryFn: fetchLibrary,
    staleTime: 60_000,
    refetchInterval: false,
  });
  const requestedQuery = useQuery({
    queryKey: ["requested-library"],
    queryFn: fetchRequestedLibrary,
    staleTime: 60_000,
    refetchInterval: false,
  });

  const library = libraryQuery.data?.state === "ok" ? libraryQuery.data.items : undefined;

  return useMemo(
    () =>
      findTitleAttribution(identity, {
        library,
        requested: requestedQuery.data?.items,
        playable,
      }),
    // `identity` is rebuilt by callers; its fields are what matter.
    [
      identity.kind,
      identity.tmdbId,
      identity.tvdbId,
      identity.title,
      identity.year,
      library,
      requestedQuery.data?.items,
      playable,
    ],
  );
}

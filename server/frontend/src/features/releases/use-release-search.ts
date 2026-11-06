import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  fetchEpisodeReleases,
  fetchMovieReleases,
  fetchSeasonReleases,
  grabMovieRelease,
  grabShowRelease,
  refreshEpisodeReleases,
  refreshMovieReleases,
  refreshSeasonReleases,
} from "@/api/client";
import type {
  CachedReleasesResponse,
  ReleaseGroup,
  ReleaseSearchProgress,
  ShowRelease,
} from "@/api/types";

/**
 * A release search target: a movie, or a season (optionally narrowed to one
 * episode). Both the movie picker and the season/episode pickers search through
 * the same backend routes; only the target differs.
 */
export type ReleaseSearchTarget =
  | { kind: "movie"; movieId: number }
  | {
      kind: "series";
      seriesId: number;
      seasonNumber: number;
      episodeNumber?: number;
    };

/** Shared cache key so page-level prefetches and the pickers agree. */
export function releaseSearchQueryKey(target: ReleaseSearchTarget) {
  return target.kind === "movie"
    ? (["movie-releases", target.movieId] as const)
    : ([
        "season-releases",
        target.seriesId,
        target.seasonNumber,
        target.episodeNumber ?? null,
      ] as const);
}

function fetchReleases(target: ReleaseSearchTarget): Promise<CachedReleasesResponse> {
  if (target.kind === "movie") {
    return fetchMovieReleases(target.movieId);
  }
  return target.episodeNumber === undefined
    ? fetchSeasonReleases(target.seriesId, target.seasonNumber)
    : fetchEpisodeReleases(target.seriesId, target.seasonNumber, target.episodeNumber);
}

function refreshReleases(target: ReleaseSearchTarget): Promise<CachedReleasesResponse> {
  if (target.kind === "movie") {
    return refreshMovieReleases(target.movieId);
  }
  return target.episodeNumber === undefined
    ? refreshSeasonReleases(target.seriesId, target.seasonNumber)
    : refreshEpisodeReleases(target.seriesId, target.seasonNumber, target.episodeNumber);
}

export interface UseReleaseSearchOptions {
  /** Called after a grab succeeds, so the page can refresh its own state. */
  onGrabbed?: () => void;
}

export interface ReleaseSearch {
  data: CachedReleasesResponse | undefined;
  groups: ReleaseGroup[];
  progress: ReleaseSearchProgress | undefined;
  /** Loading the cached snapshot for the first time. */
  isLoading: boolean;
  /** Hard failure of the cached-release request itself. */
  queryError: Error | null;
  /** A search or refresh is still running in the background. */
  refreshing: boolean;
  refresh: () => void;
  refreshPending: boolean;
  grab: (release: ShowRelease) => void;
  grabbingId: string | undefined;
  grabbing: boolean;
  grabError: Error | null;
  clearGrabError: () => void;
}

/**
 * The cached release search plus its refresh and grab mutations. The backend
 * runs a Prowlarr-first parallel search, streams indexer results into the
 * snapshot and grabs go straight to qBittorrent (`churn-direct`), so this hook
 * only polls and posts.
 */
export function useReleaseSearch(
  target: ReleaseSearchTarget,
  options: UseReleaseSearchOptions = {},
): ReleaseSearch {
  const queryClient = useQueryClient();
  const queryKey = releaseSearchQueryKey(target);
  // Keep the callback in a ref so an inline arrow does not rebuild the mutation.
  const onGrabbedRef = useRef(options.onGrabbed);
  useEffect(() => {
    onGrabbedRef.current = options.onGrabbed;
  }, [options.onGrabbed]);

  const releasesQuery = useQuery<CachedReleasesResponse>({
    queryKey,
    queryFn: () => fetchReleases(target),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.state === "searching" || query.state.data?.refreshing
        ? 1_000
        : false,
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshReleases(target),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      toast.info("Refreshing release options…");
    },
    onError: (error) => {
      toast.error("Could not refresh releases", { description: error.message });
    },
  });

  const grabMutation = useMutation({
    mutationFn: (release: ShowRelease) =>
      target.kind === "movie"
        ? grabMovieRelease(target.movieId, { releaseId: release.id })
        : grabShowRelease("sonarr", String(target.seriesId), {
            seasonNumber: release.searchSeasonNumber ?? target.seasonNumber,
            releaseId: release.id,
          }),
    onSuccess: (data) => {
      toast.success(`Sent ${data.title} to qBittorrent`);
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
      void queryClient.invalidateQueries({ queryKey: ["show"] });
      void queryClient.invalidateQueries({ queryKey: ["movie"] });
      void queryClient.invalidateQueries({ queryKey: ["requested-library"] });
      void queryClient.invalidateQueries({ queryKey });
      onGrabbedRef.current?.();
    },
  });

  const data = releasesQuery.data;

  return {
    data,
    groups: data?.groups ?? [],
    progress: data?.progress,
    isLoading: releasesQuery.isLoading,
    queryError: releasesQuery.error ?? null,
    refreshing: refreshMutation.isPending || data?.refreshing === true,
    refresh: () => refreshMutation.mutate(),
    refreshPending: refreshMutation.isPending,
    grab: (release) => grabMutation.mutate(release),
    grabbingId: grabMutation.isPending ? grabMutation.variables?.id : undefined,
    grabbing: grabMutation.isPending,
    grabError: grabMutation.error ?? null,
    clearGrabError: () => grabMutation.reset(),
  };
}

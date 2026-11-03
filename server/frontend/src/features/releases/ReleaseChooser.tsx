import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";

import {
  fetchMovieReleases,
  fetchSeasonReleases,
  grabMovieRelease,
  grabShowRelease,
  refreshMovieReleases,
  refreshSeasonReleases,
} from "@/api/client";
import type {
  CachedReleasesResponse,
  ReleaseGroup,
  ReleaseIndexerProgress,
  ShowRelease,
} from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ReleaseChooserProps =
  | {
      kind: "series";
      seriesId: number;
      seasonNumber: number;
      title?: string;
      onGrabbed?: () => void;
    }
  | {
      kind: "movie";
      movieId: number;
      title?: string;
      onGrabbed?: () => void;
    };

export function ReleaseChooser(props: ReleaseChooserProps) {
  const queryClient = useQueryClient();
  const isSeries = props.kind === "series";
  const queryKey = isSeries
    ? ["season-releases", props.seriesId, props.seasonNumber]
    : ["movie-releases", props.movieId];

  const releasesQuery = useQuery<CachedReleasesResponse>({
    queryKey,
    queryFn: () =>
      isSeries
        ? fetchSeasonReleases(props.seriesId, props.seasonNumber)
        : fetchMovieReleases(props.movieId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.state === "searching" || query.state.data?.refreshing
        ? 1_000
        : false,
  });

  const refreshMutation = useMutation({
    mutationFn: () =>
      isSeries
        ? refreshSeasonReleases(props.seriesId, props.seasonNumber)
        : refreshMovieReleases(props.movieId),
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
      isSeries
        ? grabShowRelease("sonarr", String(props.seriesId), {
            seasonNumber: release.searchSeasonNumber ?? props.seasonNumber,
            releaseId: release.id,
          })
        : grabMovieRelease(props.movieId, { releaseId: release.id }),
    onSuccess: (data) => {
      toast.success(`Sent ${data.title} to the download queue`);
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
      void queryClient.invalidateQueries({ queryKey: ["show"] });
      void queryClient.invalidateQueries({ queryKey: ["requested-library"] });
      void queryClient.invalidateQueries({ queryKey });
      props.onGrabbed?.();
    },
    onError: (error) => {
      toast.error("Could not grab that release", { description: error.message });
    },
  });

  const data = releasesQuery.data;
  const groups = data?.groups ?? [];
  const [selectedTier, setSelectedTier] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (groups.length === 0) {
      setSelectedTier(null);
      return;
    }
    setSelectedTier((current) =>
      current !== null && groups.some((group) => group.tier === current)
        ? current
        : defaultTier(groups),
    );
  }, [groups]);

  useEffect(() => {
    setExpanded(false);
  }, [selectedTier]);

  const selectedGroup = groups.find((group) => group.tier === selectedTier) ?? groups[0];
  // Keep releases from indexers the arr cannot grab visible, but disable their
  // Download button. This is how the user sees that a source exists but needs
  // to be added to Sonarr/Radarr first.
  const availableReleases = selectedGroup?.releases ?? [];
  const visibleReleases = expanded
    ? availableReleases
    : availableReleases.slice(0, 1);
  const grabbingId = grabMutation.isPending ? grabMutation.variables?.id : undefined;
  const refreshing = refreshMutation.isPending || data?.refreshing === true;

  return (
    <Card className="gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">
            {isSeries ? `Releases for ${seasonName(props.seasonNumber)}` : "Available releases"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {data?.state === "searching"
              ? data.progress
                ? `Searching ${data.progress.total} indexers. Results appear as each one finishes${
                    data.progress.finished > 0
                      ? ` — ${data.progress.finished}/${data.progress.total} finished`
                      : ""
                  }.`
                : "Searching the indexers. Results appear here as they finish."
              : data?.state === "error"
                ? data.detail ?? "The release search failed."
                : "Pick a quality tier, then choose a release. Higher seeder counts are more reliable."}
            {data?.state !== "searching" && data?.fetchedAt
              ? ` · found ${formatAge(data.fetchedAt)}`
              : ""}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshing}
        >
          <RefreshCwIcon
            data-icon="inline-start"
            className={refreshing ? "animate-spin" : undefined}
          />
          {refreshing ? "Refreshing…" : "Search again"}
        </Button>
      </div>

      {data?.progress ? <IndexerProgress progress={data.progress} /> : null}

      <CardContent className="flex flex-col gap-3 px-4">
        {releasesQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading cached releases…
          </div>
        ) : null}

        {releasesQuery.error ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Release search failed</p>
              <p className="text-muted-foreground">{releasesQuery.error.message}</p>
            </div>
          </div>
        ) : null}

        {!releasesQuery.isLoading &&
        !releasesQuery.error &&
        data?.state === "searching" &&
        groups.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Searching indexers in the background…
          </div>
        ) : null}

        {data?.state === "error" && groups.length === 0 ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">No release options yet</p>
              <p className="text-muted-foreground">
                {data.detail ?? "The last search failed. Try again."}
              </p>
            </div>
          </div>
        ) : null}

        {!releasesQuery.isLoading && !releasesQuery.error && data?.state === "ready" && groups.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-4">
            <p className="text-sm text-muted-foreground">
              No releases were found. Try searching again later or add another indexer.
            </p>
            <Button variant="outline" size="sm" onClick={() => refreshMutation.mutate()}>
              <RefreshCwIcon data-icon="inline-start" />
              Search again
            </Button>
          </div>
        ) : null}

        {groups.length > 0 && selectedGroup ? (
          <Tabs
            value={String(selectedGroup.tier)}
            onValueChange={(value) => setSelectedTier(Number(value))}
          >
            <TabsList className="flex h-auto flex-wrap justify-start">
              {groups.map((group) => (
                <TabsTrigger key={group.tier} value={String(group.tier)}>
                  {group.label} ({group.releases.length})
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value={String(selectedGroup.tier)} className="flex flex-col gap-2">
              {selectedGroup.lowSeeders ? (
                <Alert>
                  <TriangleAlertIcon />
                  <AlertTitle>Fewer than 50 seeders</AlertTitle>
                  <AlertDescription>
                    The best option in this tier has fewer than 50 seeders, so these results may
                    be stale. Refresh before downloading if speed matters.
                  </AlertDescription>
                </Alert>
              ) : null}

              {visibleReleases.map((release) => (
                <ReleaseRow
                  key={release.id}
                  release={release}
                  isSeries={isSeries}
                  grabbing={grabbingId === release.id}
                  disabled={grabMutation.isPending}
                  onGrab={() => grabMutation.mutate(release)}
                />
              ))}

              {availableReleases.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-fit"
                  onClick={() => setExpanded((current) => !current)}
                >
                  {expanded
                    ? "Show fewer options"
                    : `Show ${availableReleases.length - 1} more option${
                        availableReleases.length - 1 === 1 ? "" : "s"
                      }`}
                </Button>
              ) : null}
            </TabsContent>
          </Tabs>
        ) : null}
      </CardContent>
    </Card>
  );
}

function IndexerProgress({
  progress,
}: {
  progress: NonNullable<CachedReleasesResponse["progress"]>;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-4">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {progress.finished}/{progress.total} indexers finished
        </span>
        {progress.finished < progress.total ? (
          <span className="inline-flex items-center gap-1">
            <Loader2Icon className="size-3 animate-spin" />
            more results may arrive
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {progress.indexers.map((indexer) => (
          <IndexerChip key={indexer.id} indexer={indexer} />
        ))}
      </div>
    </div>
  );
}

function IndexerChip({ indexer }: { indexer: ReleaseIndexerProgress }) {
  const title = indexer.detail
    ? `${indexer.name}: ${indexer.detail}`
    : `${indexer.name}: ${indexer.state}${indexer.count > 0 ? ` (${indexer.count})` : ""}`;
  return (
    <Badge
      variant={indexer.state === "error" ? "destructive" : "outline"}
      className="max-w-full gap-1 font-normal"
      title={title}
    >
      {indexer.state === "pending" || indexer.state === "searching" ? (
        <Loader2Icon className="size-3 animate-spin" />
      ) : null}
      <span className="max-w-32 truncate">{indexer.name}</span>
      {indexer.state === "finished" ? <span>{indexer.count}</span> : null}
      {indexer.state === "error" ? <span>failed</span> : null}
      {!indexer.canGrab ? <span>· no arr</span> : null}
    </Badge>
  );
}

function ReleaseRow({
  release,
  isSeries,
  grabbing,
  disabled,
  onGrab,
}: {
  release: ShowRelease;
  isSeries: boolean;
  grabbing: boolean;
  disabled: boolean;
  onGrab: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {!release.canGrab ? (
          <Badge variant="outline">Indexer not in arr</Badge>
        ) : (
          <Badge variant="secondary">Matched</Badge>
        )}
        {release.multiSeason ? <Badge variant="outline">Multi-season</Badge> : null}
        {release.seeders !== undefined && release.seeders < 50 ? (
          <Badge variant="outline">Low seeders</Badge>
        ) : null}
        {isSeries ? (
          <span className="text-xs text-muted-foreground">
            {release.episodeLabel ?? release.seasonLabel}
          </span>
        ) : release.quality ? (
          <span className="text-xs text-muted-foreground">{release.quality}</span>
        ) : null}
      </div>

      <p className="break-words text-sm font-medium" title={release.title}>
        {release.title}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{formatBytes(release.sizeBytes)}</span>
        {release.quality && isSeries ? <span>{release.quality}</span> : null}
        {release.seeders !== undefined ? (
          <span>
            {release.seeders} seeder{release.seeders === 1 ? "" : "s"}
          </span>
        ) : null}
        {release.indexer ? <span>{release.indexer}</span> : null}
        {release.ageHours !== undefined ? <span>{formatAgeHours(release.ageHours)}</span> : null}
        {release.mappedEpisodeCount > 0 ? (
          <span>
            {release.mappedEpisodeCount}{" "}
            {release.mappedEpisodeCount === 1 ? "episode" : "episodes"} matched
          </span>
        ) : null}
      </div>

      {release.rejections.length > 0 ? (
        <p className="text-xs text-muted-foreground">{release.rejections.join(" · ")}</p>
      ) : null}
      {release.downloadDetail ? (
        <p className="text-xs text-muted-foreground">{release.downloadDetail}</p>
      ) : null}

      <div className="flex justify-end">
        <Button
          size="sm"
          variant={release.approved ? "default" : "outline"}
          disabled={!release.canGrab || disabled}
          onClick={onGrab}
        >
          {grabbing ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <DownloadIcon data-icon="inline-start" />
          )}
          {grabbing ? "Sending…" : "Download"}
        </Button>
      </div>
    </div>
  );
}

function defaultTier(groups: ReleaseGroup[]): number {
  const known = groups
    .map((group) => group.tier)
    .filter((tier) => tier >= 0 && tier <= 3)
    .sort((left, right) => right - left);
  return known[0] ?? groups[0]?.tier ?? 99;
}

function seasonName(seasonNumber: number): string {
  return seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "Unknown size";
  }
  if (bytes < 1024 ** 3) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatAgeHours(hours: number): string {
  if (hours < 1) {
    return "< 1h old";
  }
  if (hours < 24) {
    return `${Math.round(hours)}h old`;
  }
  return `${Math.round(hours / 24)}d old`;
}

function formatAge(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "just now";
  }
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

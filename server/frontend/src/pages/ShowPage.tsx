import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  DownloadIcon,
  Loader2Icon,
  PlayIcon,
  FilmIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { fetchSeasonReleases, fetchShow } from "@/api/client";
import type {
  ActivityStatus,
  CachedReleasesResponse,
  ShowDetailResponse,
  ShowDownload,
  ShowEpisode,
  ShowSeriesSummary,
} from "@/api/types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ReleaseChooser } from "@/features/releases/ReleaseChooser";
import { ReleasePickerDialog } from "@/features/show/ReleasePickerDialog";
import { CancelEpisodeDownloadDialog } from "@/features/show/CancelEpisodeDownloadDialog";
import type { ShowSource } from "@/hooks/use-hash-route";

export function ShowPage({ source, id }: { source: ShowSource; id: string }) {
  const showQuery = useQuery({
    queryKey: ["show", source, id],
    queryFn: () => fetchShow(source, id),
    // While Jellyfin is re-indexing an empty show, poll fast enough to pick up
    // the episodes as soon as the scan finishes.
    refetchInterval: (query) => (query.state.data?.scanning ? 2_000 : 10_000),
  });
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [releasesOpen, setReleasesOpen] = useState(false);
  const [releaseEpisode, setReleaseEpisode] = useState<ShowEpisode | null>(null);
  const [cancelEpisode, setCancelEpisode] = useState<ShowEpisode | null>(null);
  const autoOpenedReleaseKey = useRef<string | null>(null);

  useEffect(() => {
    const data = showQuery.data;
    if (!data || data.seasons.length === 0) {
      setSelectedSeason(null);
      return;
    }
    setSelectedSeason((current) => {
      if (
        current !== null &&
        data.seasons.some((season) => season.seasonNumber === current)
      ) {
        return current;
      }
      return data.defaultSeason ?? data.seasons[0]?.seasonNumber ?? null;
    });
  }, [showQuery.data]);

  const episodes = useMemo(() => {
    if (!showQuery.data || selectedSeason === null) {
      return [];
    }
    return showQuery.data.episodes.filter(
      (episode) => episode.seasonNumber === selectedSeason,
    );
  }, [selectedSeason, showQuery.data]);

  // Jellyfin-backed shows still expose their Sonarr series id, so release
  // searches and episode cancels work from the same page.
  const sonarrSeriesId = showQuery.data?.sonarrId;
  const seasonHasDownload = episodes.some(
    (episode) =>
      episode.download !== undefined &&
      !(episode.download.untracked && episode.download.status === "warning"),
  );
  const seasonHasFile = episodes.some(
    (episode) => episode.availability === "jellyfin" || episode.imported,
  );
  const showReleasePrompt =
    sonarrSeriesId !== undefined &&
    selectedSeason !== null &&
    episodes.some(
      (episode) => episode.availability === "missing" && !episode.imported,
    ) &&
    !seasonHasDownload &&
    !seasonHasFile;

  // Share the chooser's cache key so opening it does not trigger another fetch.
  const seasonReleasesQuery = useQuery<CachedReleasesResponse>({
    queryKey: ["season-releases", sonarrSeriesId, selectedSeason],
    queryFn: () =>
      fetchSeasonReleases(sonarrSeriesId as number, selectedSeason as number),
    enabled:
      sonarrSeriesId !== undefined &&
      selectedSeason !== null &&
      showReleasePrompt,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.state === "searching" || query.state.data?.refreshing
        ? 2_000
        : false,
  });

  useEffect(() => {
    autoOpenedReleaseKey.current = null;
  }, [sonarrSeriesId, selectedSeason]);

  useEffect(() => {
    const releases = seasonReleasesQuery.data;
    if (
      sonarrSeriesId === undefined ||
      selectedSeason === null ||
      !showReleasePrompt ||
      releasesOpen ||
      releases?.state !== "ready" ||
      releases.releaseCount === 0
    ) {
      return;
    }
    const key = `${sonarrSeriesId}:${selectedSeason}`;
    if (autoOpenedReleaseKey.current === key) {
      return;
    }
    autoOpenedReleaseKey.current = key;
    setReleasesOpen(true);
  }, [
    sonarrSeriesId,
    selectedSeason,
    showReleasePrompt,
    releasesOpen,
    seasonReleasesQuery.data,
  ]);

  const searchingSeasonReleases =
    showReleasePrompt &&
    (seasonReleasesQuery.isLoading || seasonReleasesQuery.data?.state === "searching");

  return (
    <div className="flex flex-col gap-6">
      <a
        href="#/library"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        Back to Library
      </a>

      {showQuery.isLoading ? <ShowPageSkeleton /> : null}

      {showQuery.error && !showQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load this show</AlertTitle>
          <AlertDescription>{showQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {showQuery.data && showQuery.data.state !== "ok" ? (
        <ShowStateNotice show={showQuery.data} />
      ) : null}

      {showQuery.data?.state === "ok" ? (
        <>
          <ShowHeader series={showQuery.data.series} source={source} />

          {showQuery.data.warnings?.map((warning) => (
            <Alert key={warning}>
              <TriangleAlertIcon />
              <AlertTitle>Download status is limited</AlertTitle>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}

          {showQuery.data.seasons.length > 0 ? (
            <section className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h2 className="font-heading text-xl font-semibold tracking-tight">Episodes</h2>
                  <p className="text-sm text-muted-foreground">
                    {showQuery.data.episodes.length} episodes across{" "}
                    {showQuery.data.seasons.length}{" "}
                    {showQuery.data.seasons.length === 1 ? "season" : "seasons"}
                  </p>
                </div>
                <Select
                  value={selectedSeason === null ? undefined : String(selectedSeason)}
                  onValueChange={(value) => setSelectedSeason(Number(value))}
                >
                  <SelectTrigger className="w-56" aria-label="Choose season">
                    <SelectValue placeholder="Choose season" />
                  </SelectTrigger>
                  <SelectContent>
                    {showQuery.data.seasons.map((season) => (
                      <SelectItem
                        key={season.seasonNumber}
                        value={String(season.seasonNumber)}
                      >
                        {season.name} · {season.episodeCount} episodes
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sonarrSeriesId !== undefined && selectedSeason !== null ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setReleasesOpen((open) => !open)}
                  >
                    <DownloadIcon data-icon="inline-start" />
                    {releasesOpen ? "Hide releases" : "Choose release"}
                  </Button>
                ) : null}
              </div>

              {sonarrSeriesId !== undefined &&
              releasesOpen &&
              selectedSeason !== null ? (
                <ReleaseChooser
                  kind="series"
                  seriesId={sonarrSeriesId}
                  seasonNumber={selectedSeason}
                  title={showQuery.data.series.title}
                  onGrabbed={() => setReleasesOpen(false)}
                />
              ) : null}

              <ReleasePickerDialog
                open={releaseEpisode !== null}
                onOpenChange={(open) => {
                  if (!open) {
                    setReleaseEpisode(null);
                  }
                }}
                seriesId={sonarrSeriesId}
                seasonNumber={releaseEpisode?.seasonNumber}
                episodeNumber={releaseEpisode?.episodeNumber}
                showTitle={showQuery.data.series.title}
              />

              <CancelEpisodeDownloadDialog
                open={cancelEpisode !== null}
                onOpenChange={(open) => {
                  if (!open) {
                    setCancelEpisode(null);
                  }
                }}
                seriesId={sonarrSeriesId ?? 0}
                seasonNumber={cancelEpisode?.seasonNumber ?? 0}
                episodeNumber={cancelEpisode?.episodeNumber ?? 0}
                episodeTitle={
                  cancelEpisode
                    ? `${episodeCode(cancelEpisode)} · ${cancelEpisode.title}`
                    : "This episode"
                }
                seasonPack={cancelEpisode?.download?.seasonPack === true}
              />

              {searchingSeasonReleases && !releasesOpen ? (
                <Alert>
                  <Loader2Icon className="animate-spin" />
                  <AlertTitle>
                    Searching for {selectedSeason === null ? "season" : seasonName(selectedSeason)} releases
                  </AlertTitle>
                  <AlertDescription>
                    This runs in the background. The release options will open automatically
                    when they are ready.
                  </AlertDescription>
                </Alert>
              ) : null}

              {showReleasePrompt && !searchingSeasonReleases && !releasesOpen ? (
                <Alert>
                  <TriangleAlertIcon />
                  <AlertTitle>Choose a release for this season</AlertTitle>
                  <AlertDescription>
                    Browse the cached quality options, compare seeders and size, then pick the
                    torrent you want. Multi-season packs are listed under every season they cover.
                  </AlertDescription>
                  <AlertAction>
                    <Button variant="outline" size="sm" onClick={() => setReleasesOpen(true)}>
                      Choose release
                    </Button>
                  </AlertAction>
                </Alert>
              ) : null}

              {episodes.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {episodes.map((episode) => (
                    <EpisodeRow
                      key={episode.key}
                      episode={episode}
                      playHref={
                        episode.jellyfinId && episode.availability === "jellyfin"
                          ? `#/play/${encodeURIComponent(episode.jellyfinId)}`
                          : undefined
                      }
                      onChooseRelease={
                        sonarrSeriesId !== undefined &&
                        episode.download === undefined &&
                        episode.availability === "missing" &&
                        !episode.imported
                          ? () => setReleaseEpisode(episode)
                          : undefined
                      }
                      onCancelDownload={
                        sonarrSeriesId !== undefined &&
                        episode.download !== undefined
                          ? () => setCancelEpisode(episode)
                          : undefined
                      }
                    />
                  ))}
                </div>
              ) : (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FilmIcon />
                    </EmptyMedia>
                    <EmptyTitle>No episodes in this season</EmptyTitle>
                    <EmptyDescription>
                      Try another season or check Sonarr for this show.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </section>
          ) : showQuery.data.source === "jellyfin" ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FilmIcon />
                </EmptyMedia>
                <EmptyTitle>Jellyfin is still indexing this show</EmptyTitle>
                <EmptyDescription>
                  {showQuery.data.scanning
                    ? "Jellyfin knows about this show but has not added its episodes yet. A library scan was requested; this page checks again automatically."
                    : "Jellyfin knows about this show but has not added its episodes yet. Refresh the Jellyfin library and try again."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FilmIcon />
                </EmptyMedia>
                <EmptyTitle>No episodes found</EmptyTitle>
                <EmptyDescription>
                  This show has no episodes in Jellyfin or Sonarr yet.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </>
      ) : null}
    </div>
  );
}

function ShowHeader({ series, source }: { series: ShowSeriesSummary; source: ShowSource }) {
  return (
    <section className="flex flex-col gap-5 sm:flex-row">
      <div className="aspect-[2/3] w-32 shrink-0 overflow-hidden rounded-xl bg-muted">
        {series.imageUrl ? (
          <img
            src={series.imageUrl}
            alt={`${series.title} poster`}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <FilmIcon className="size-8 text-muted-foreground" />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{source === "jellyfin" ? "Jellyfin" : "Sonarr"}</Badge>
          {series.year ? <span className="text-sm text-muted-foreground">{series.year}</span> : null}
          {series.network ? (
            <span className="text-sm text-muted-foreground">{series.network}</span>
          ) : null}
          {series.rating !== undefined ? (
            <span className="text-sm text-muted-foreground">{series.rating.toFixed(1)} / 10</span>
          ) : null}
        </div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{series.title}</h1>
        {series.overview ? (
          <p className="max-w-3xl text-sm text-muted-foreground">{series.overview}</p>
        ) : null}
      </div>
    </section>
  );
}

function EpisodeRow({
  episode,
  playHref,
  onChooseRelease,
  onCancelDownload,
}: {
  episode: ShowEpisode;
  playHref?: string;
  onChooseRelease?: () => void;
  onCancelDownload?: () => void;
}) {
  const download = episode.download;
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row">
        <div className="flex shrink-0 flex-col gap-1 sm:w-28">
          <span className="font-mono text-xs font-medium text-muted-foreground">
            {episodeCode(episode)}
          </span>
          {episode.imageUrl ? (
            <img
              src={episode.imageUrl}
              alt=""
              loading="lazy"
              className="hidden aspect-video w-28 rounded-md object-cover sm:block"
            />
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{episode.title}</h3>
            {episode.imported && episode.availability === "missing" ? (
              <Badge variant="outline">Waiting for Jellyfin</Badge>
            ) : episode.availability !== "missing" || !download ? (
              <AvailabilityBadge availability={episode.availability} />
            ) : null}
            {download ? <DownloadBadge download={download} /> : null}
            {playHref || onChooseRelease || onCancelDownload ? (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {playHref ? (
                  <Button asChild variant="secondary" size="sm">
                    <a href={playHref}>
                      <PlayIcon data-icon="inline-start" />
                      Play
                    </a>
                  </Button>
                ) : null}
                {onChooseRelease ? (
                  <Button variant="outline" size="sm" onClick={onChooseRelease}>
                    <DownloadIcon data-icon="inline-start" />
                    Choose release
                  </Button>
                ) : null}
                {onCancelDownload ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={onCancelDownload}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    Cancel download
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {episode.airDate ? <span>{formatAirDate(episode.airDate)}</span> : null}
            {episode.runtimeMinutes !== undefined ? (
              <span>{formatRuntime(episode.runtimeMinutes)}</span>
            ) : null}
            {download?.quality ? <span>{download.quality}</span> : null}
            {download ? <span>{downloadClientLabel(download)}</span> : null}
          </div>

          {episode.overview ? (
            <p className="line-clamp-2 text-sm text-muted-foreground">{episode.overview}</p>
          ) : null}

          {download ? (
            <div className="flex flex-col gap-1.5">
              <Progress value={download.progress} label={`${episode.title} download progress`} />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {download.seasonPack ? "Season pack · " : ""}
                  {download.progress}% complete
                </span>
                <span>{downloadEta(download)}</span>
              </div>
              {download.statusMessages?.length ? (
                <p className="text-xs text-destructive">{download.statusMessages.join(" · ")}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function AvailabilityBadge({ availability }: { availability: ShowEpisode["availability"] }) {
  switch (availability) {
    case "jellyfin":
      return <Badge variant="secondary">Available</Badge>;
    case "upcoming":
      return <Badge variant="outline">Upcoming</Badge>;
    default:
      return <Badge variant="outline">Missing</Badge>;
  }
}

function DownloadBadge({ download }: { download: ShowDownload }) {
  return (
    <Badge variant={downloadBadgeVariant(download.status)}>
      {downloadBadgeLabel(download)}
    </Badge>
  );
}

function downloadBadgeLabel(download: ShowDownload): string {
  switch (download.status) {
    case "downloading":
      return `Downloading ${download.progress}%`;
    case "importing":
      return "Importing";
    case "warning":
      return "Needs attention";
    default:
      return "Queued";
  }
}

function downloadBadgeVariant(status: ActivityStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "downloading":
      return "default";
    case "importing":
      return "secondary";
    case "warning":
      return "destructive";
    default:
      return "outline";
  }
}

function ShowStateNotice({ show }: { show: ShowDetailResponse }) {
  const name = show.source === "jellyfin" ? "Jellyfin" : "Sonarr";
  return (
    <Alert variant={show.state === "unconfigured" || show.state === "unauthorized" ? "default" : "destructive"}>
      <CircleAlertIcon />
      <AlertTitle>{name} is not ready</AlertTitle>
      <AlertDescription>
        {show.detail ?? `Check that ${name} is running and its API key is configured.`}
      </AlertDescription>
      <AlertAction>
        <Button asChild variant="outline" size="sm">
          <a
            href={`/api/services/${show.source === "jellyfin" ? "jellyfin" : "sonarr"}/open`}
            target="_blank"
            rel="noreferrer"
          >
            Open {name}
          </a>
        </Button>
      </AlertAction>
    </Alert>
  );
}

function ShowPageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-5 sm:flex-row">
        <Skeleton className="aspect-[2/3] w-32 shrink-0 rounded-xl" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-full max-w-2xl" />
          <Skeleton className="h-4 w-3/4 max-w-xl" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function seasonName(seasonNumber: number): string {
  return seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
}

function episodeCode(episode: ShowEpisode): string {
  return `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;
}

function downloadClientLabel(download: ShowDownload): string {
  const protocol = download.protocol === "usenet" ? "Usenet" : download.protocol === "torrent" ? "Torrent" : undefined;
  if (download.downloadClient && protocol) {
    return `${download.downloadClient} · ${protocol}`;
  }
  return download.downloadClient ?? protocol ?? "Downloading";
}

function downloadEta(download: ShowDownload): string {
  if (download.timeLeft) {
    return `ETA ${download.timeLeft}`;
  }
  if (download.estimatedCompletionTime) {
    return `ETA ${formatEta(download.estimatedCompletionTime)}`;
  }
  if (download.sizeBytes !== undefined) {
    return formatBytes(download.sizeBytes);
  }
  return "";
}

function formatEta(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatAirDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatRuntime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

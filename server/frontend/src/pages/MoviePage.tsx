import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  DownloadIcon,
  FilmIcon,
  Loader2Icon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";

import { fetchMovie } from "@/api/client";
import type { ActivityItem, MovieDetailResponse } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { CancelMovieDownloadDialog } from "@/features/movie/CancelMovieDownloadDialog";
import { ReleaseChooser } from "@/features/releases/ReleaseChooser";

export function MoviePage({
  source,
  id,
}: {
  source: "jellyfin" | "radarr";
  id: string;
}) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [awaitingDownload, setAwaitingDownload] = useState(false);
  // Briefly disable Cancel after a grab. The release chooser is replaced by
  // the download card under the cursor, so a second click (double-click) could
  // otherwise land on Cancel and open its confirmation dialog by accident.
  const [cancelReady, setCancelReady] = useState(true);
  const movieQuery = useQuery({
    queryKey: ["movie", source, id],
    queryFn: () => fetchMovie(source, id),
    // A grab can take a moment to appear in qBittorrent; poll quickly while
    // waiting so the release chooser is replaced by live progress.
    refetchInterval: awaitingDownload ? 1_000 : 10_000,
  });
  const download = movieQuery.data?.download;

  useEffect(() => {
    if (download) {
      setAwaitingDownload(false);
    }
  }, [download]);

  useEffect(() => {
    if (!awaitingDownload) {
      return;
    }
    const timer = setTimeout(() => setAwaitingDownload(false), 30_000);
    return () => clearTimeout(timer);
  }, [awaitingDownload]);

  useEffect(() => {
    if (cancelReady) {
      return;
    }
    const timer = setTimeout(() => setCancelReady(true), 1_000);
    return () => clearTimeout(timer);
  }, [cancelReady]);

  return (
    <div className="flex flex-col gap-6">
      <a
        href="#/library"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        Back to Library
      </a>

      {movieQuery.isLoading ? <MoviePageSkeleton /> : null}

      {movieQuery.error && !movieQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load this movie</AlertTitle>
          <AlertDescription>{movieQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {movieQuery.data && movieQuery.data.state !== "ok" ? (
        <Alert variant={movieQuery.data.state === "unconfigured" ? "default" : "destructive"}>
          <CircleAlertIcon />
          <AlertTitle>Movie details are unavailable</AlertTitle>
          <AlertDescription>
            {movieQuery.data.detail ?? "Check that the media services are running."}
          </AlertDescription>
        </Alert>
      ) : null}

      {movieQuery.data ? (
        <>
          <MovieHeader movie={movieQuery.data} />
          {movieQuery.data.detail && movieQuery.data.state === "ok" ? (
            <Alert>
              <CircleAlertIcon />
              <AlertTitle>Release search is limited</AlertTitle>
              <AlertDescription>{movieQuery.data.detail}</AlertDescription>
            </Alert>
          ) : null}
          {download ? (
            <MovieDownloadCard
              download={download}
              cancelDisabled={!cancelReady}
              onCancel={() => setCancelOpen(true)}
            />
          ) : awaitingDownload ? (
            <Alert>
              <Loader2Icon className="animate-spin" />
              <AlertTitle>Starting download</AlertTitle>
              <AlertDescription>
                Waiting for qBittorrent to report the new torrent.
              </AlertDescription>
            </Alert>
          ) : movieQuery.data.radarrId !== undefined ? (
            <ReleaseChooser
              kind="movie"
              movieId={movieQuery.data.radarrId}
              title={movieQuery.data.movie.title}
              onGrabbed={() => {
                setCancelReady(false);
                setAwaitingDownload(true);
                void movieQuery.refetch();
              }}
            />
          ) : (
            <Alert>
              <CircleAlertIcon />
              <AlertTitle>No release options available</AlertTitle>
              <AlertDescription>
                This movie is not matched to a Radarr entry, so there is nothing to search for.
                Add it to Radarr first, or play the existing file.
              </AlertDescription>
            </Alert>
          )}
          {download ? (
            <CancelMovieDownloadDialog
              open={cancelOpen}
              onOpenChange={setCancelOpen}
              source={source}
              id={id}
              title={movieQuery.data.movie.title}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function MovieHeader({ movie }: { movie: MovieDetailResponse }) {
  const details = movie.movie;
  return (
    <section className="flex flex-col gap-5 sm:flex-row">
      <div className="aspect-[2/3] w-32 shrink-0 overflow-hidden rounded-xl bg-muted">
        {details.imageUrl ? (
          <img
            src={details.imageUrl}
            alt={`${details.title} poster`}
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
          <Badge variant="outline">{movie.source === "jellyfin" ? "Jellyfin" : "Radarr"}</Badge>
          {details.year ? <span className="text-sm text-muted-foreground">{details.year}</span> : null}
          {details.network ? (
            <span className="text-sm text-muted-foreground">{details.network}</span>
          ) : null}
          {details.rating !== undefined ? (
            <span className="text-sm text-muted-foreground">{details.rating.toFixed(1)} / 10</span>
          ) : null}
          {details.runtimeMinutes !== undefined ? (
            <span className="text-sm text-muted-foreground">
              {formatRuntime(details.runtimeMinutes)}
            </span>
          ) : null}
        </div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{details.title}</h1>
        {details.overview ? (
          <p className="max-w-3xl text-sm text-muted-foreground">{details.overview}</p>
        ) : null}
        {movie.jellyfinId ? (
          <Button asChild variant="outline" size="sm" className="mt-2 w-fit">
            <a href={`#/play/${encodeURIComponent(movie.jellyfinId)}`}>
              <PlayIcon data-icon="inline-start" />
              Play
            </a>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function MovieDownloadCard({
  download,
  cancelDisabled,
  onCancel,
}: {
  download: ActivityItem;
  cancelDisabled: boolean;
  onCancel: () => void;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <DownloadIcon className="size-4 text-muted-foreground" />
          <h2 className="font-heading text-base font-semibold">Downloading now</h2>
          <Badge variant={download.status === "warning" ? "destructive" : "default"}>
            {downloadLabel(download)}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {download.downloadClients[0] ?? "qBittorrent"}
            {download.protocols[0] === "torrent" ? " · Torrent" : ""}
            {download.quality ? ` · ${download.quality}` : ""}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            disabled={cancelDisabled}
            onClick={onCancel}
          >
            <Trash2Icon data-icon="inline-start" />
            Cancel download
          </Button>
        </div>
        <Progress value={download.progress} label="Movie download progress" />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{download.progress}% complete</span>
          <span>{downloadEta(download)}</span>
        </div>
        {download.statusMessages?.length ? (
          <p className="text-xs text-destructive">{download.statusMessages.join(" · ")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function downloadLabel(download: ActivityItem): string {
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

function downloadEta(download: ActivityItem): string {
  if (download.timeLeft) {
    return `ETA ${download.timeLeft}`;
  }
  if (download.estimatedCompletionTime) {
    return `ETA ${formatEta(download.estimatedCompletionTime)}`;
  }
  if (download.sizeLeftBytes !== undefined) {
    return `${formatBytes(download.sizeLeftBytes)} left`;
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

function MoviePageSkeleton() {
  return (
    <div className="flex flex-col gap-5 sm:flex-row">
      <Skeleton className="aspect-[2/3] w-32 shrink-0 rounded-xl" />
      <div className="flex flex-1 flex-col gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    </div>
  );
}

function formatRuntime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

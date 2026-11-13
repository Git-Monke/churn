import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlertIcon } from "lucide-react";

import { fetchMovie, fetchMovieDownload } from "@/api/client";
import type { ActivityItem } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { CancelRequestDialog } from "@/features/library/CancelRequestDialog";
import { CancelMovieDownloadDialog } from "@/features/movie/CancelMovieDownloadDialog";
import { VersionPicker } from "@/features/releases/VersionPicker";
import { useTitleAttribution } from "@/features/title/use-title-attribution";
import {
  resumeDetail,
  useTitlePlayback,
  type TitlePlayback,
} from "@/features/title/use-title-playback";
import { DeleteTitleDialog } from "@/features/title/DeleteTitleDialog";
import { TitleHeader } from "@/features/title/TitleHeader";
import { TitleMenu, type TitleMenuItem } from "@/features/title/TitleMenu";
import { TitlePrimaryAction, type TitleAction } from "@/features/title/TitlePrimaryAction";
import { playHash } from "@/hooks/use-hash-route";
import {
  formatCompletionAbout,
  formatRuntime,
  formatTimeLeftAbout,
} from "@/lib/format";

export function MoviePage({
  source,
  id,
}: {
  source: "jellyfin" | "radarr";
  id: string;
}) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelRequestOpen, setCancelRequestOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** The picker is open on demand for a title that is already playable. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [awaitingDownload, setAwaitingDownload] = useState(false);
  // Briefly disable Cancel after a grab. The release picker is replaced by the
  // downloading header under the cursor, so a second click (double-click) could
  // otherwise land on Cancel and open its confirmation dialog by accident.
  const [cancelReady, setCancelReady] = useState(true);
  const movieQuery = useQuery({
    queryKey: ["movie", source, id],
    queryFn: () => fetchMovie(source, id),
    refetchInterval: 10_000,
  });
  // The lean download endpoint only reads qBittorrent; the full detail route
  // stays on its slower cadence. Poll twice per second while something is
  // downloading or a grab is waiting to appear.
  const downloadQuery = useQuery({
    queryKey: ["movie", source, id, "download"],
    queryFn: () => fetchMovieDownload(source, id),
    refetchInterval: (query) => {
      const live = query.state.data;
      const downloading = live?.ready === true && live.download !== undefined;
      return awaitingDownload || downloading ? 500 : 2_000;
    },
  });
  const liveDownload = downloadQuery.data;
  const download = liveDownload?.ready
    ? liveDownload.download
    : movieQuery.data?.download;

  const movie = movieQuery.data?.movie;
  const jellyfinId = movieQuery.data?.jellyfinId;
  const radarrId = movieQuery.data?.radarrId;
  // Radarr imported the file but Jellyfin does not list it yet: neither pick
  // another version (the file is already chosen) nor claim it is missing.
  const imported = movieQuery.data?.imported === true;
  const playable = jellyfinId !== undefined && download === undefined;
  const downloading = download !== undefined || awaitingDownload;

  const playback = useTitlePlayback(jellyfinId);
  const addedBy = useTitleAttribution(
    {
      kind: "movie",
      ...(movie?.tmdbId === undefined ? {} : { tmdbId: movie.tmdbId }),
      title: movie?.title ?? "",
      ...(movie?.year === undefined ? {} : { year: movie.year }),
    },
    jellyfinId !== undefined,
  );

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

  const action = movieAction({
    movieId: jellyfinId,
    playback,
    downloading,
    download,
    awaitingDownload,
    imported,
  });

  const menuItems: TitleMenuItem[] = [];
  if (downloading) {
    if (download) {
      menuItems.push({
        label: "Cancel download",
        destructive: true,
        onSelect: () => setCancelOpen(true),
      });
    }
    if (radarrId !== undefined) {
      menuItems.push({
        label: "Cancel request",
        destructive: true,
        onSelect: () => setCancelRequestOpen(true),
      });
    }
  } else if (playable) {
    menuItems.push(
      {
        label: pickerOpen ? "Hide more versions" : "Download a different version",
        onSelect: () => setPickerOpen((open) => !open),
      },
      {
        label: "Delete from library",
        destructive: true,
        onSelect: () => setDeleteOpen(true),
      },
    );
  } else if (radarrId !== undefined) {
    menuItems.push({
      label: "Cancel request",
      destructive: true,
      onSelect: () => setCancelRequestOpen(true),
    });
  }

  // Where the picker belongs: always for a request with nothing playable, on
  // demand for a title that already plays. Never while the downloaded file
  // waits for Jellyfin to index it — a version was already chosen.
  const showPicker =
    !downloading &&
    !imported &&
    radarrId !== undefined &&
    ((playable && pickerOpen) || (!playable && jellyfinId === undefined));

  return (
    <div className="flex flex-col gap-6">
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

      {movie && movieQuery.data?.state === "ok" ? (
        <>
          <div className="flex flex-col gap-10">
            <TitleHeader
              poster={{ imageUrl: movie.imageUrl, alt: `${movie.title} poster` }}
              title={movie.title}
              metadata={[
                movie.year === undefined ? undefined : String(movie.year),
                movie.network,
                movie.runtimeMinutes === undefined
                  ? undefined
                  : formatRuntime(movie.runtimeMinutes),
                movie.rating === undefined
                  ? undefined
                  : `${movie.rating.toFixed(1)} / 10`,
              ]}
              synopsis={movie.overview}
              dimmed={!playable}
              action={<TitlePrimaryAction action={action} />}
              menu={<TitleMenu items={menuItems} />}
              attribution={
                addedBy
                  ? `${playable ? "Added" : "Requested"} by ${addedBy.name}`
                  : undefined
              }
            />

            {showPicker && radarrId !== undefined ? (
              <VersionPicker
                scope="movie"
                movieId={radarrId}
                onClose={playable ? () => setPickerOpen(false) : undefined}
                onGrabbed={() => {
                  setPickerOpen(false);
                  setCancelReady(false);
                  setAwaitingDownload(true);
                  void movieQuery.refetch();
                }}
              />
            ) : null}
          </div>

          {!downloading && !playable && radarrId === undefined ? (
            <Alert>
              <CircleAlertIcon />
              <AlertTitle>No release options available</AlertTitle>
              <AlertDescription>
                This movie is not matched to a Radarr entry, so there is nothing to search for.
                Add it to Radarr first.
              </AlertDescription>
            </Alert>
          ) : null}

          {download ? (
            <CancelMovieDownloadDialog
              open={cancelOpen}
              onOpenChange={setCancelOpen}
              source={source}
              id={id}
              title={movie.title}
            />
          ) : null}

          {radarrId !== undefined ? (
            <CancelRequestDialog
              open={cancelRequestOpen}
              onOpenChange={setCancelRequestOpen}
              target={{ service: "radarr", id: radarrId }}
              title={movie.title}
              onCancelled={() => setPickerOpen(false)}
            />
          ) : null}

          <DeleteTitleDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={movie.title}
            jellyfinId={jellyfinId}
            arrService="radarr"
            arrId={radarrId}
            onDeleted={() => {
              window.location.hash = "#/library";
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function movieAction({
  movieId,
  playback,
  downloading,
  download,
  awaitingDownload,
  imported,
}: {
  movieId: string | undefined;
  playback: TitlePlayback;
  downloading: boolean;
  download: ActivityItem | undefined;
  awaitingDownload: boolean;
  imported: boolean;
}): TitleAction {
  if (downloading) {
    const eta =
      formatTimeLeftAbout(download?.timeLeft) ??
      formatCompletionAbout(download?.estimatedCompletionTime);
    return {
      kind: "downloading",
      ...(download?.status === "importing" ? { label: "Importing" } : {}),
      ...(eta === undefined ? {} : { eta }),
      progress: download?.progress ?? 0,
      ...(download === undefined ? {} : { download }),
    };
  }
  if (movieId === undefined) {
    // Radarr has the file; Jellyfin just has not indexed it yet.
    return imported ? { kind: "importing" } : { kind: "not-downloaded" };
  }
  const href = playHash(movieId);
  if (!playback.resumable) {
    return { kind: "play", href, label: "Play" };
  }
  const detail = resumeDetail(playback.remainingMinutes);
  return {
    kind: "play",
    href,
    label: "Resume",
    ...(detail === undefined ? {} : { detail }),
  };
}

function MoviePageSkeleton() {
  return (
    <div className="flex flex-wrap items-end gap-x-10 gap-y-6">
      <Skeleton className="aspect-[2/3] w-35 shrink-0 rounded-lg sm:w-55" />
      <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-4.5">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-10 w-2/3 max-w-md" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-4 w-4/5 max-w-lg" />
        <Skeleton className="h-12 w-32" />
      </div>
    </div>
  );
}

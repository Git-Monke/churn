import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, CircleAlertIcon, FilmIcon, PlayIcon } from "lucide-react";

import { fetchMovie } from "@/api/client";
import type { MovieDetailResponse } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ReleaseChooser } from "@/features/releases/ReleaseChooser";

export function MoviePage({
  source,
  id,
}: {
  source: "jellyfin" | "radarr";
  id: string;
}) {
  const movieQuery = useQuery({
    queryKey: ["movie", source, id],
    queryFn: () => fetchMovie(source, id),
    refetchInterval: 10_000,
  });

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
          {movieQuery.data.radarrId !== undefined ? (
            <ReleaseChooser
              kind="movie"
              movieId={movieQuery.data.radarrId}
              title={movieQuery.data.movie.title}
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

import { CheckIcon, FilmIcon, Loader2Icon, PlusIcon, TvIcon } from "lucide-react";

import type { RequestMonitor, SearchResult } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { seasonMonitorLabel } from "@/features/search/search-labels";

interface SearchResultCardProps {
  result: SearchResult;
  onRequest: (result: SearchResult) => void;
  requesting: boolean;
  requestDisabled: boolean;
  seriesMonitor?: RequestMonitor;
}

export function SearchResultCard({
  result,
  onRequest,
  requesting,
  requestDisabled,
  seriesMonitor,
}: SearchResultCardProps) {
  const requested = result.inLibrary === true;

  return (
    <Card className="gap-0 py-0">
      <div className="aspect-[2/3] bg-muted">
        {result.imageUrl ? (
          <img
            src={result.imageUrl}
            alt={`${result.title} poster`}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            {result.kind === "movie" ? (
              <FilmIcon className="size-8 text-muted-foreground" />
            ) : (
              <TvIcon className="size-8 text-muted-foreground" />
            )}
          </div>
        )}
      </div>

      <CardHeader className="gap-1.5 pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">
            {result.kind === "movie" ? "Movie" : "Series"}
          </Badge>
          {result.year ? (
            <span className="text-xs text-muted-foreground">{result.year}</span>
          ) : null}
          {result.inLibrary === null ? (
            <Badge variant="outline">Status unknown</Badge>
          ) : null}
        </div>
        <CardTitle className="truncate text-base" title={result.title}>
          {result.title}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {result.rating !== undefined ? <span>{result.rating.toFixed(1)} / 10</span> : null}
          {result.certification ? <span>{result.certification}</span> : null}
          {result.runtimeMinutes !== undefined ? (
            <span>{formatRuntime(result.runtimeMinutes)}</span>
          ) : null}
          {result.network ? <span className="truncate">{result.network}</span> : null}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-2 py-2">
        {result.overview ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{result.overview}</p>
        ) : null}
        {result.kind === "series" && result.seasons?.length ? (
          <p className="text-xs text-muted-foreground">
            {result.seasons.length} {result.seasons.length === 1 ? "season" : "seasons"} ·{" "}
            {seasonMonitorLabel(seriesMonitor)}
          </p>
        ) : null}
      </CardContent>

      <CardFooter className="mt-auto py-2">
        {requested ? (
          <Button variant="secondary" size="sm" disabled className="w-full">
            <CheckIcon data-icon="inline-start" />
            Requested
          </Button>
        ) : (
          <Button
            size="sm"
            className="w-full"
            disabled={requestDisabled || requesting}
            onClick={() => onRequest(result)}
          >
            {requesting ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            {requesting ? "Requesting…" : "Request"}
          </Button>
        )}
      </CardFooter>
    </Card>
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

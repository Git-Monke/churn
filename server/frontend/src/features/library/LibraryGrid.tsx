import { useState } from "react";
import { ChevronRightIcon, FilmIcon, PlayIcon, Trash2Icon, TvIcon } from "lucide-react";

import type { ActivityItem, LibraryItem, RequestedLibraryItem } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CancelDownloadDialog,
  type CancelTarget,
} from "@/features/library/CancelDownloadDialog";
import type { LibraryEntry } from "@/features/library/library-entries";
import { entryTitle } from "@/features/library/library-entries";

export function LibraryGrid({ entries }: { entries: LibraryEntry[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {entries.map((entry) => (
        <LibraryCard key={entry.key} entry={entry} />
      ))}
    </div>
  );
}

export function LibraryGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="aspect-[2/3] w-full rounded-xl" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      ))}
    </div>
  );
}

function LibraryCard({ entry }: { entry: LibraryEntry }) {
  const { library, requested, activity, type } = entry;
  const title = entryTitle(entry) || "Untitled";
  const year = library?.year ?? requested?.year ?? activity?.year;
  const imageUrl = library?.imageUrl ?? requested?.imageUrl ?? activity?.imageUrl;
  const href = type === "Series" ? showHref(entry) : playHref(entry);

  const card = (
    <Card
      className={`h-full gap-0 overflow-hidden py-0 ${
        href ? "transition-transform group-hover:-translate-y-0.5" : ""
      }`}
    >
      <div className="relative aspect-[2/3] bg-muted">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={`${title} poster`}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            {type === "Movie" ? (
              <FilmIcon className="size-8 text-muted-foreground" />
            ) : (
              <TvIcon className="size-8 text-muted-foreground" />
            )}
          </div>
        )}
        {href && type === "Movie" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-transparent transition-colors group-hover:bg-black/30">
            <span className="flex size-12 items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
              <PlayIcon className="size-5" />
            </span>
          </div>
        ) : null}
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          {library || requested?.available ? (
            <Badge variant="outline" className="bg-background/85 backdrop-blur">
              Available
            </Badge>
          ) : requested ? (
            <Badge variant="secondary" className="bg-secondary/90 text-secondary-foreground backdrop-blur">
              Requested
            </Badge>
          ) : null}
          {activity ? <ActivityBadge activity={activity} /> : null}
        </div>
      </div>

      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-start justify-between gap-1">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{type === "Movie" ? "Movie" : "Series"}</Badge>
              {year ? <span className="text-xs text-muted-foreground">{year}</span> : null}
            </div>
            <h3 className="truncate font-medium" title={title}>
              {title}
            </h3>
          </div>
          {href ? (
            type === "Movie" ? (
              <PlayIcon className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
            ) : (
              <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
            )
          ) : null}
        </div>

        <MetadataLine library={library} requested={requested} activity={activity} />

        {activity ? (
          <div className="flex flex-col gap-1.5">
            <Progress value={activity.progress} label={`${title} download progress`} />
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span>{downloadSource(activity)}</span>
              <span>{downloadEta(activity)}</span>
            </div>
            {activity.seasons?.length ? (
              <span className="text-[11px] text-muted-foreground">
                {seasonHint(activity.seasons)}
              </span>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );

  const target = cancelTarget(entry);

  return (
    <div className="group relative h-full">
      {href ? (
        <a
          href={href}
          className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {card}
        </a>
      ) : (
        card
      )}
      {target ? <CancelButton target={target} title={title} /> : null}
    </div>
  );
}

function cancelTarget(entry: LibraryEntry): CancelTarget | undefined {
  if (entry.requested) {
    return { service: entry.requested.service, id: entry.requested.arrId };
  }
  const activity = entry.activity;
  if (activity?.kind === "movie" && activity.movieId !== undefined) {
    return { service: "radarr", id: activity.movieId };
  }
  if (activity?.kind === "series" && activity.seriesId !== undefined) {
    return { service: "sonarr", id: activity.seriesId };
  }
  return undefined;
}

function CancelButton({ target, title }: { target: CancelTarget; title: string }) {
  const [open, setOpen] = useState(false);
  const serviceName = target.service === "sonarr" ? "Sonarr" : "Radarr";

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Cancel ${title}`}
        title={`Cancel ${title} and remove it from ${serviceName}`}
        className="absolute right-2 top-2 z-10 bg-background/85 text-muted-foreground shadow-sm backdrop-blur hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2Icon />
      </Button>
      <CancelDownloadDialog
        open={open}
        onOpenChange={setOpen}
        target={target}
        title={title}
      />
    </>
  );
}

function playHref(entry: LibraryEntry): string | undefined {
  if (entry.library?.type === "Movie") {
    return `#/play/${encodeURIComponent(entry.library.id)}`;
  }
  return undefined;
}

function showHref(entry: LibraryEntry): string | undefined {
  if (entry.library) {
    return `#/library/show/jellyfin/${encodeURIComponent(entry.library.id)}`;
  }
  if (entry.requested?.kind === "series") {
    return `#/library/show/sonarr/${entry.requested.arrId}`;
  }
  if (entry.activity?.seriesId !== undefined) {
    return `#/library/show/sonarr/${entry.activity.seriesId}`;
  }
  return undefined;
}

function ActivityBadge({ activity }: { activity: ActivityItem }) {
  const variant =
    activity.status === "warning"
      ? "destructive"
      : activity.status === "downloading"
        ? "default"
        : activity.status === "importing"
          ? "secondary"
          : "outline";
  const className =
    activity.status === "downloading"
      ? "bg-primary/90 text-primary-foreground backdrop-blur"
      : activity.status === "importing"
        ? "bg-secondary/90 text-secondary-foreground backdrop-blur"
        : "bg-background/85 text-foreground backdrop-blur";
  return (
    <Badge variant={variant} className={className}>
      {activityLabel(activity)}
    </Badge>
  );
}

function activityLabel(activity: ActivityItem): string {
  switch (activity.status) {
    case "downloading":
      return `Downloading ${activity.progress}%`;
    case "importing":
      return "Importing";
    case "warning":
      return "Needs attention";
    default:
      return "Queued";
  }
}

function MetadataLine({
  library,
  requested,
  activity,
}: {
  library?: LibraryItem;
  requested?: RequestedLibraryItem;
  activity?: ActivityItem;
}) {
  const rating = library?.rating ?? requested?.rating ?? activity?.rating;
  const officialRating = library?.officialRating;
  const runtime =
    library?.runtimeMinutes ?? requested?.runtimeMinutes ?? activity?.runtimeMinutes;
  const network = requested?.network ?? activity?.network;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {rating !== undefined ? <span>{rating.toFixed(1)} / 10</span> : null}
      {officialRating ? <span>{officialRating}</span> : null}
      {runtime !== undefined ? <span>{formatRuntime(runtime)}</span> : null}
      {network ? <span className="truncate">{network}</span> : null}
    </div>
  );
}

function downloadSource(activity: ActivityItem): string {
  const client = activity.downloadClients[0];
  const protocol =
    activity.protocols[0] === "usenet"
      ? "Usenet"
      : activity.protocols[0] === "torrent"
        ? "Torrent"
        : undefined;
  const parts = [client, protocol];
  if (activity.status === "downloading" && activity.downloadSpeedBytes) {
    parts.push(formatSpeed(activity.downloadSpeedBytes));
  }
  return parts.filter((part): part is string => Boolean(part)).join(" · ") || "Downloading";
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024 ** 2) {
    return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
  }
  return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`;
}

function downloadEta(activity: ActivityItem): string {
  if (activity.timeLeft) {
    return `ETA ${activity.timeLeft}`;
  }
  if (activity.estimatedCompletionTime) {
    return `ETA ${formatEta(activity.estimatedCompletionTime)}`;
  }
  if (activity.sizeLeftBytes !== undefined && activity.sizeLeftBytes > 0) {
    return `${formatBytes(activity.sizeLeftBytes)} left`;
  }
  if (activity.sizeBytes !== undefined && activity.sizeBytes > 0) {
    return formatBytes(activity.sizeBytes);
  }
  return "";
}

function seasonHint(seasons: number[]): string {
  const sorted = [...new Set(seasons)].sort((left, right) => left - right);
  if (sorted.length === 1) {
    const season = sorted[0];
    return season === 0 ? "Specials" : `Season ${season}`;
  }
  const contiguous = sorted.every((season, index) => {
    const previous = sorted[index - 1];
    return index === 0 || (previous !== undefined && season === previous + 1);
  });
  return contiguous
    ? `Seasons ${sorted[0]}–${sorted[sorted.length - 1]}`
    : `Seasons ${sorted.join(", ")}`;
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

function formatRuntime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

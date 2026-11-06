import { useState } from "react";
import { ArrowRightIcon, FilmIcon, TvIcon, XIcon } from "lucide-react";

import type { ActivityItem } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  CancelRequestDialog,
  type CancelRequestTarget,
} from "@/features/library/CancelRequestDialog";
import type { LibraryEntry } from "@/features/library/library-entries";
import { entryHref, entryTitle } from "@/features/library/library-entries";
import { formatDownloaded, formatSpeed } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Titles that are not playable yet: arr requests still queued and qBittorrent
 * downloads in flight.
 *
 * Movies that are requested but have no download at all need someone to pick a
 * release, so they sort first and link to the movie page's release chooser.
 * Those cards also carry the cancel action, since that is where a request that
 * nobody wants any more is going to be noticed.
 *
 * Every card is a link to its detail page (the whole card is clickable, and
 * lifts on hover like the library grid). Interactive bits inside the card stay
 * clickable on top of that overlay.
 */
export function OnTheWay({ entries }: { entries: LibraryEntry[] }) {
  if (entries.length === 0) {
    return null;
  }

  const ordered = [...entries].sort(
    (left, right) => Number(needsPick(right)) - Number(needsPick(left)),
  );

  return (
    <section aria-labelledby="on-the-way-heading" className="flex flex-col gap-4">
      <h2
        id="on-the-way-heading"
        className="font-heading text-xl font-semibold tracking-tight"
      >
        On the way
      </h2>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
        {ordered.map((entry) => (
          <li key={entry.key}>
            <OnTheWayCard entry={entry} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OnTheWayCard({ entry }: { entry: LibraryEntry }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const title = entryTitle(entry) || "Untitled";
  const imageUrl = entry.requested?.imageUrl ?? entry.activity?.imageUrl;
  const activity = entry.activity;
  const isSeries = entry.type === "Series";
  const href = entryHref(entry);
  const pickHref = needsPick(entry) ? href : undefined;
  // Only requests with nothing playable yet can be cancelled from here; once
  // Jellyfin has the title it lives in the grid and cancellation belongs on the
  // detail page.
  const cancelTarget: CancelRequestTarget | undefined =
    entry.requested && !entry.library
      ? { service: entry.requested.service, id: entry.requested.arrId }
      : undefined;

  return (
    <Card
      className={cn(
        "relative gap-0 p-3.5",
        pickHref && "ring-primary/40",
        href &&
          "transition-transform hover:-translate-y-0.5 focus-within:ring-2 focus-within:ring-ring/50",
      )}
    >
      {href ? (
        <a href={href} aria-label={title} className="absolute inset-0 rounded-xl" />
      ) : null}
      <div className="pointer-events-none relative flex gap-3">
        <div className="flex h-21 w-14 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted">
          {imageUrl ? (
            <img src={imageUrl} alt="" loading="lazy" className="size-full object-cover" />
          ) : isSeries ? (
            <TvIcon className="text-muted-foreground" />
          ) : (
            <FilmIcon className="text-muted-foreground" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <h3 className="min-w-0 truncate font-medium" title={title}>
              {onTheWayTitle(entry)}
            </h3>
            <span
              className={cn(
                "shrink-0 text-sm whitespace-nowrap",
                pickHref ? "text-primary" : "text-muted-foreground",
              )}
            >
              {statusLabel(entry)}
            </span>
          </div>
          {activity ? (
            <div className="flex flex-col gap-1">
              <Progress
                value={activity.progress}
                aria-label={`${title} download progress`}
              />
              {downloadDetail(activity) ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {downloadDetail(activity)}
                </span>
              ) : null}
            </div>
          ) : null}
          {pickHref ? (
            <Button asChild size="sm" className="pointer-events-auto w-fit">
              <a href={pickHref}>
                Pick a version
                <ArrowRightIcon data-icon="inline-end" />
              </a>
            </Button>
          ) : null}
          {entry.addedBy ? (
            <span className="truncate pr-8 text-xs text-muted-foreground">
              Requested by {entry.addedBy.name}
            </span>
          ) : null}
        </div>
      </div>
      {cancelTarget ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Cancel the request for ${title}`}
          title="Cancel request"
          className="absolute right-2 bottom-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setCancelOpen(true)}
        >
          <XIcon />
        </Button>
      ) : null}
      {cancelTarget ? (
        <CancelRequestDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          target={cancelTarget}
          title={title}
        />
      ) : null}
    </Card>
  );
}

/** A requested movie with nothing downloading is waiting on a release pick. */
function needsPick(entry: LibraryEntry): boolean {
  return (
    entry.type === "Movie" &&
    !entry.library &&
    !entry.activity &&
    entry.status === "requested"
  );
}

/** `Show · Season 4` for season packs, plain title otherwise. */
function onTheWayTitle(entry: LibraryEntry): string {
  const title = entryTitle(entry);
  const seasons = entry.activity?.seasons;
  if (!seasons?.length) {
    return title;
  }
  return `${title} · ${seasonHint(seasons)}`;
}

function statusLabel(entry: LibraryEntry): string {
  if (needsPick(entry)) {
    return "Needs a pick";
  }
  if (entry.status === "scanning" || entry.status === "scan_failed") {
    return "Indexing";
  }
  const status = entry.activity?.status;
  if (status === "downloading") {
    return "Downloading";
  }
  if (status === "importing") {
    return "Importing";
  }
  return "Queued";
}

/**
 * `12.4 MB/s · 3.4 GB / 8.1 GB`. Speeds and sizes are the part that moves, so
 * they sit under the progress bar instead of the right-hand state label.
 */
function downloadDetail(activity: ActivityItem): string | undefined {
  const speed = activity.downloadSpeedBytes;
  const parts = [
    speed ? formatSpeed(speed) : undefined,
    formatDownloaded(activity.sizeBytes, activity.sizeLeftBytes),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
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


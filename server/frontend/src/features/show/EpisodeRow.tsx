import type { ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";

import type { ShowDownload, ShowEpisode } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { formatAirDate, formatRuntime, formatTimeLeftAbout } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Rows are separated by rules, so the list itself has no vertical gap. */
export function EpisodeList({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col">{children}</ul>;
}

export function EpisodeRow({
  episode,
  playHref,
  compact = false,
  onChooseRelease,
  onCancelDownload,
}: {
  episode: ShowEpisode;
  /** Present when Jellyfin can play the episode; the whole row links to it. */
  playHref?: string;
  /** The whole season is missing: tighter row, air date only. */
  compact?: boolean;
  /** Only offered while picking episodes one at a time. */
  onChooseRelease?: () => void;
  onCancelDownload?: () => void;
}) {
  return (
    <li className="border-b border-border">
      {playHref ? (
        <PlayableEpisodeRow episode={episode} playHref={playHref} />
      ) : (
        <MissingEpisodeRow
          episode={episode}
          compact={compact}
          onChooseRelease={onChooseRelease}
          onCancelDownload={onCancelDownload}
        />
      )}
    </li>
  );
}

function PlayableEpisodeRow({
  episode,
  playHref,
}: {
  episode: ShowEpisode;
  playHref: string;
}) {
  return (
    <a
      href={playHref}
      aria-label={`Play episode ${episode.episodeNumber}: ${episode.title}`}
      className={cn(
        "-mx-3 flex flex-wrap items-center gap-5 px-3 py-4 transition-colors",
        "hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
      )}
    >
      <Thumbnail episode={episode} />

      <div className="flex min-w-0 flex-[999_1_320px] flex-col gap-1.5">
        <EpisodeText episode={episode} />
        <Metadata episode={episode} />
        {episode.overview ? (
          <p className="hidden max-w-[80ch] pl-[30px] text-sm leading-relaxed text-muted-foreground/90 sm:line-clamp-2">
            {episode.overview}
          </p>
        ) : null}
      </div>

      {/* Watching progress is not tracked yet, so this column stays empty. */}
      <div className="flex w-full shrink-0 items-center justify-start gap-1.5 pl-37 text-[13px] text-muted-foreground sm:w-auto sm:min-w-27.5 sm:justify-end sm:pl-0" />
    </a>
  );
}

function MissingEpisodeRow({
  episode,
  compact,
  onChooseRelease,
  onCancelDownload,
}: {
  episode: ShowEpisode;
  compact: boolean;
  onChooseRelease?: () => void;
  onCancelDownload?: () => void;
}) {
  const download = episode.download;
  const downloading = download !== undefined && download.status !== "warning";
  const actions = [
    ...(onChooseRelease
      ? [{ label: "Choose release", onSelect: onChooseRelease, destructive: false }]
      : []),
    ...(onCancelDownload
      ? [{ label: "Cancel download", onSelect: onCancelDownload, destructive: true }]
      : []),
  ];

  return (
    <div
      className={cn(
        "-mx-3 flex flex-wrap items-center gap-5 px-3",
        compact ? "py-3.5" : "py-4",
      )}
    >
      <div
        className={cn(
          "aspect-video shrink-0 rounded-lg border border-dashed border-border",
          compact ? "w-31.5 rounded-md" : "w-32 sm:w-48",
        )}
      />

      <div className={cn("flex min-w-0 flex-[999_1_320px] flex-col", compact ? "gap-1" : "gap-1.5")}>
        <EpisodeText episode={episode} muted />
        {compact ? (
          episode.airDate ? (
            <p className="pl-[30px] text-[13px] text-muted-foreground">
              {formatAirDate(episode.airDate)}
            </p>
          ) : null
        ) : (
          <Metadata episode={episode} />
        )}
      </div>

      <div
        className={cn(
          "flex w-full shrink-0 flex-col items-start gap-2 text-[13px] text-muted-foreground",
          compact ? "sm:w-auto sm:min-w-27.5 sm:items-end" : "sm:w-auto sm:min-w-45 sm:items-end",
        )}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={cn(compact && "sm:text-right", "text-nowrap")}
            title={episodeStatusLabel(episode)}
          >
            {episodeStatusLabel(episode)}
          </span>
          {actions.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label={`Actions for episode ${episode.episodeNumber}`}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {actions.map((action) => (
                  <DropdownMenuItem
                    key={action.label}
                    variant={action.destructive ? "destructive" : "default"}
                    className="min-h-9 px-2.5"
                    onSelect={() => action.onSelect()}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {downloading && !compact ? (
          <Progress
            value={download.progress}
            className="h-1.5 w-40"
            aria-label={`Download progress for episode ${episode.episodeNumber}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function Thumbnail({ episode }: { episode: ShowEpisode }) {
  return (
    <div className="aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-muted sm:w-48">
      {episode.imageUrl ? (
        <img
          src={episode.imageUrl}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      ) : null}
    </div>
  );
}

function EpisodeText({ episode, muted = false }: { episode: ShowEpisode; muted?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="min-w-[18px] text-right text-sm text-muted-foreground tabular-nums">
        {episode.episodeNumber}
      </span>
      <h3
        className={cn(
          "min-w-0 truncate text-base font-medium",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {episode.title}
      </h3>
    </div>
  );
}

function Metadata({ episode }: { episode: ShowEpisode }) {
  const parts = [
    episode.runtimeMinutes === undefined ? undefined : formatRuntime(episode.runtimeMinutes),
    episode.airDate === undefined ? undefined : formatAirDate(episode.airDate),
  ].filter((part): part is string => Boolean(part));

  if (parts.length === 0) {
    return null;
  }
  return (
    <p className="pl-[30px] text-[13px] text-muted-foreground">{parts.join(" · ")}</p>
  );
}

/**
 * The right-hand state of a non-playable row. Watching progress is not tracked
 * yet, so a download is described by its ETA and everything else says whether
 * the episode is there at all.
 */
function episodeStatusLabel(episode: ShowEpisode): string {
  const download: ShowDownload | undefined = episode.download;
  if (download) {
    switch (download.status) {
      case "downloading": {
        const eta = formatTimeLeftAbout(download.timeLeft);
        return eta ? `Downloading · ${eta}` : `Downloading ${download.progress}%`;
      }
      case "importing":
        return "Importing";
      case "warning":
        return "Needs attention";
      default:
        return "Queued";
    }
  }
  if (episode.imported) {
    return "Waiting for Jellyfin";
  }
  return episode.availability === "upcoming" ? "Upcoming" : "Not downloaded";
}

import { FilmIcon } from "lucide-react";

import type { PlaybackNextEpisode } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

export interface UpNextCardProps {
  episode: PlaybackNextEpisode;
  /** Jellyfin still for the next episode; the proxy 404s into the placeholder. */
  thumbnailUrl?: string;
  /** Remaining seconds of the countdown; absent when autoplay is off. */
  remainingSeconds?: number;
  countdownSeconds: number;
  onPlayNow: () => void;
  onCancel: () => void;
}

/**
 * The in-frame "Up next" panel. Shows a live countdown while autoplay is on and
 * a static prompt when it is off; the page owns advancing and dismissing.
 */
export function UpNextCard({
  episode,
  thumbnailUrl,
  remainingSeconds,
  countdownSeconds,
  onPlayNow,
  onCancel,
}: UpNextCardProps) {
  const counting = remainingSeconds !== undefined;
  const elapsedPercent = counting
    ? Math.min(
        100,
        Math.max(
          0,
          ((countdownSeconds - remainingSeconds) / Math.max(1, countdownSeconds)) * 100,
        ),
      )
    : 0;

  return (
    <div
      role="region"
      aria-label="Up next"
      className="absolute right-5 bottom-19 flex w-[360px] max-w-[calc(100%-40px)] flex-col gap-3.5 rounded-xl bg-background/90 p-4 shadow-lg max-sm:inset-x-3 max-sm:right-3 max-sm:bottom-19 max-sm:left-3 max-sm:w-auto max-sm:max-w-none"
    >
      <div className="flex items-center gap-3">
        <div className="aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-muted">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              className="size-full object-cover"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <div className="flex size-full items-center justify-center">
              <FilmIcon className="size-5 text-muted-foreground" aria-hidden />
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">
            {counting ? `Up next · in ${Math.max(1, remainingSeconds)}s` : "Up next"}
          </span>
          <span className="truncate text-sm font-medium">
            {episode.episodeNumber} · {episode.name}
          </span>
        </div>
      </div>

      {counting ? (
        <Progress
          value={elapsedPercent}
          aria-label="Time until the next episode"
          className="h-1 bg-muted"
        />
      ) : null}

      <div className="flex items-center gap-2.5">
        <Button type="button" className="h-11 flex-1" onClick={onPlayNow}>
          Play now
        </Button>
        <Button type="button" variant="outline" className="h-11 flex-1" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

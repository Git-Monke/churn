import type { ReactNode } from "react";
import { SkipForwardIcon } from "lucide-react";

import type { PlaybackItem } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Synopsis } from "@/features/title/Synopsis";
import { episodeCode, playbackMinutes } from "@/features/player/playback-meta";
import { showHash, type ShowReturnContext } from "@/hooks/use-hash-route";
import { formatCalendarDate, formatRuntime } from "@/lib/format";

export interface PlaybackTitleRowProps {
  item: PlaybackItem;
  /** Where playback was started, so the show link returns there. */
  from?: ShowReturnContext;
  /** Episodes with a downloaded next episode get the Next button. */
  onNext?: () => void;
  /** The playback settings menu. */
  settings: ReactNode;
}

/**
 * Title, metadata line and synopsis on the left; Next and the settings menu on
 * the right. Layout only — the page owns navigation and settings state.
 */
export function PlaybackTitleRow({ item, from, onNext, settings }: PlaybackTitleRowProps) {
  const isEpisode = item.type === "Episode";
  const minutes = playbackMinutes(item.runtimeTicks);
  const tokens: ReactNode[] = [];

  if (isEpisode) {
    const showHref = from
      ? showHash(from.source, from.id, from.season)
      : item.seriesId
        ? `#/library/show/jellyfin/${encodeURIComponent(item.seriesId)}`
        : undefined;
    if (item.seriesName && showHref) {
      tokens.push(
        <a
          key="series"
          href={showHref}
          className="text-foreground underline underline-offset-4 hover:text-primary"
        >
          {item.seriesName}
        </a>,
      );
    } else if (item.seriesName) {
      tokens.push(<span key="series">{item.seriesName}</span>);
    }
    const code = episodeCode(item.seasonNumber, item.episodeNumber);
    if (code) {
      tokens.push(<span key="code">{code}</span>);
    }
  } else {
    tokens.push(
      <a
        key="movie"
        href={`#/library/movie/jellyfin/${encodeURIComponent(item.id)}`}
        className="text-foreground underline underline-offset-4 hover:text-primary"
      >
        {item.name}
      </a>,
    );
    if (item.year) {
      tokens.push(<span key="year">{item.year}</span>);
    }
  }

  if (minutes !== undefined) {
    tokens.push(<span key="runtime">{formatRuntime(minutes)}</span>);
  }
  if (isEpisode) {
    if (item.premiereDate) {
      tokens.push(<span key="airdate">Aired {formatCalendarDate(item.premiereDate)}</span>);
    }
  } else if (item.officialRating) {
    tokens.push(<span key="rating">{item.officialRating}</span>);
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-6">
      <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-2.5">
        <h1 className="font-heading text-3xl font-semibold tracking-tight max-sm:text-2xl">
          {item.name}
        </h1>
        {tokens.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            {tokens.map((token, index) => (
              <span key={index} className="flex items-center gap-x-1.5">
                {index > 0 ? <span aria-hidden>·</span> : null}
                {token}
              </span>
            ))}
          </p>
        ) : null}
        {item.overview ? (
          <Synopsis text={item.overview} lines={3} className="max-w-[72ch]" />
        ) : null}
      </div>

      <div className="flex flex-none items-center gap-2.5 max-sm:w-full">
        {onNext ? (
          <Button
            type="button"
            variant="outline"
            className="h-12 max-w-70 gap-2 px-4"
            onClick={onNext}
          >
            <span className="text-muted-foreground">Next</span>
            <span className="min-w-0 truncate font-medium">{item.nextEpisode?.name}</span>
            <SkipForwardIcon className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        ) : null}
        {settings}
      </div>
    </div>
  );
}

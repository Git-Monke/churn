import type { ContinueWatchingItem } from "@/api/types";
import { resumeDetail } from "@/features/title/use-title-playback";
import { playHash } from "@/hooks/use-hash-route";

/** One card in the Continue watching row. */
export interface ContinueWatchingCard {
  id: string;
  /** Show name for episodes, movie title for films. */
  title: string;
  /** `S3 · E5 · 14 min left` for episodes, `48 min left` for movies. */
  resumeLabel: string;
  /** Played percentage, 0–100. */
  progress: number;
  /** The episode after the last completed one: nothing watched yet. */
  upNext: boolean;
  /** Optional still; the card falls back to a token-coloured placeholder. */
  imageUrl?: string;
  /** Player link; episodes keep their season in the back-link. */
  href: string;
}

/** Jellyfin ticks are 100 ns each; a minute is 600,000,000 of them. */
const TICKS_PER_MINUTE = 600_000_000;

export function toContinueWatchingCards(
  items: ContinueWatchingItem[],
): ContinueWatchingCard[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title || item.episodeTitle || "Untitled",
    resumeLabel: resumeLabel(item),
    progress: item.playedPercentage,
    upNext: item.upNext === true,
    imageUrl: item.imageUrl,
    href: cardHref(item),
  }));
}

/**
 * `S1 · E6 · 24 min left` for episodes, `24 min left` for movies, and
 * `S1 · E5 · Up next` for the episode after the last completed one — a card
 * nobody has started has no minutes left to report.
 */
export function resumeLabel(item: ContinueWatchingItem): string {
  const parts: string[] = [];
  if (
    item.kind === "episode" &&
    item.seasonNumber !== undefined &&
    item.episodeNumber !== undefined
  ) {
    parts.push(`S${item.seasonNumber} · E${item.episodeNumber}`);
  }
  const detail = item.upNext ? "Up next" : resumeDetail(remainingMinutes(item));
  if (detail) {
    parts.push(detail);
  }
  return parts.join(" · ") || "In progress";
}

/**
 * Whole minutes left from the saved position. Unknown runtimes (Jellyfin has not
 * probed the file) leave the label without a time.
 */
export function remainingMinutes(item: ContinueWatchingItem): number | undefined {
  const runtimeTicks = item.runtimeTicks;
  if (!runtimeTicks || runtimeTicks <= item.positionTicks) {
    return undefined;
  }
  return Math.max(1, Math.ceil((runtimeTicks - item.positionTicks) / TICKS_PER_MINUTE));
}

/**
 * Episodes resume with their season as the return context, so the player's back
 * link lands on the right season instead of the library.
 */
export function cardHref(item: ContinueWatchingItem): string {
  if (item.kind === "episode" && item.seriesId) {
    return playHash(item.id, {
      source: "jellyfin",
      id: item.seriesId,
      ...(item.seasonNumber === undefined ? {} : { season: item.seasonNumber }),
    });
  }
  return playHash(item.id);
}

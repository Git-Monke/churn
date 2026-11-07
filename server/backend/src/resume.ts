import type { ContinueWatchingItem, ContinueWatchingResponse, LibraryState } from "./types.js";
import type { JellyfinItem } from "./upstream/jellyfin.js";

/** How many cards the row asks Jellyfin for; the row itself shows fewer. */
export const RESUME_FETCH_LIMIT = 20;
/** Next Up is one episode per series, so it needs the same window. */
export const NEXT_UP_FETCH_LIMIT = RESUME_FETCH_LIMIT;
/**
 * Completed episodes fetched for the next-up gate. Only their series ids and
 * dates are used, and the row shows 12 cards, so a window of recent
 * completions is enough to fill it.
 */
export const PLAYED_FETCH_LIMIT = 80;
/** Cards the dashboard row renders. */
export const RESUME_ITEM_LIMIT = 12;
/** Backdrops are 3840×2160 upstream; 340 px cards at 2× DPR need no more. */
const CARD_IMAGE_MAX_WIDTH = 680;

/**
 * Turn Jellyfin's resume list into Continue watching cards.
 *
 * Jellyfin already drops finished items and orders the list newest-first, but
 * two things need doing here: a partly watched show can appear once per
 * episode, and movie posters are 2:3 while the cards are 16:9 stills. So
 * episodes collapse to their most recently played episode per series, and the
 * image preference is backdrop/still first (see `imageUrlFor`).
 */
export function mapResumeItems(
  items: JellyfinItem[],
  limit: number = RESUME_ITEM_LIMIT,
): ContinueWatchingItem[] {
  const cards: ContinueWatchingItem[] = [];
  const seenSeries = new Set<string>();

  for (const item of items) {
    if (cards.length >= limit) {
      break;
    }
    const card = mapResumeItem(item);
    if (!card) {
      continue;
    }
    if (card.kind === "episode") {
      // The list is newest-first, so the first episode kept for a series is the
      // one the user should be offered.
      const seriesKey = card.seriesId;
      if (seriesKey) {
        if (seenSeries.has(seriesKey)) {
          continue;
        }
        seenSeries.add(seriesKey);
      }
    }
    cards.push(card);
  }

  return cards;
}

/** Map one Jellyfin item, or null when it is not worth a card. */
export function mapResumeItem(item: JellyfinItem): ContinueWatchingItem | null {
  if (!item.Id || !item.Name || (item.Type !== "Movie" && item.Type !== "Episode")) {
    return null;
  }
  const positionTicks = item.UserData?.PlaybackPositionTicks ?? 0;
  if (item.UserData?.Played === true || positionTicks <= 0) {
    return null;
  }
  if (item.Type === "Episode" && (!item.SeriesId || !item.SeriesName)) {
    return null;
  }

  const kind: ContinueWatchingItem["kind"] = item.Type === "Movie" ? "movie" : "episode";
  const card: ContinueWatchingItem = {
    id: item.Id,
    kind,
    title: (kind === "episode" ? item.SeriesName : item.Name) as string,
    positionTicks,
    playedPercentage: playedPercentage(item.UserData?.PlayedPercentage, positionTicks, item.RunTimeTicks),
  };

  assignIfDefined(card, "episodeTitle", kind === "episode" ? item.Name : undefined);
  assignIfDefined(card, "seriesId", kind === "episode" ? item.SeriesId : undefined);
  assignIfDefined(card, "seasonNumber", kind === "episode" ? item.ParentIndexNumber : undefined);
  assignIfDefined(card, "episodeNumber", kind === "episode" ? item.IndexNumber : undefined);
  assignIfDefined(card, "runtimeTicks", item.RunTimeTicks);
  assignIfDefined(card, "lastPlayedDate", item.UserData?.LastPlayedDate);
  assignIfDefined(card, "imageUrl", imageUrlFor(item, kind));
  return card;
}

/**
 * Map one Next Up item: the episode after the last completed one, so nothing in
 * it has been watched yet. Mirror image of `mapResumeItem` — zero position, no
 * percentage, `upNext` set instead.
 */
export function mapNextUpItem(item: JellyfinItem): ContinueWatchingItem | null {
  if (!item.Id || !item.Name || item.Type !== "Episode") {
    return null;
  }
  if (!item.SeriesId || !item.SeriesName) {
    return null;
  }
  if (item.UserData?.Played === true) {
    return null;
  }
  // A saved position means the episode belongs to the resume list, which wins
  // for its series; offering it again as "up next" would duplicate the card.
  if ((item.UserData?.PlaybackPositionTicks ?? 0) > 0) {
    return null;
  }

  const card: ContinueWatchingItem = {
    id: item.Id,
    kind: "episode",
    title: item.SeriesName,
    positionTicks: 0,
    playedPercentage: 0,
    upNext: true,
  };
  assignIfDefined(card, "episodeTitle", item.Name);
  assignIfDefined(card, "seriesId", item.SeriesId);
  assignIfDefined(card, "seasonNumber", item.ParentIndexNumber);
  assignIfDefined(card, "episodeNumber", item.IndexNumber);
  assignIfDefined(card, "runtimeTicks", item.RunTimeTicks);
  assignIfDefined(card, "lastPlayedDate", item.UserData?.LastPlayedDate);
  assignIfDefined(card, "imageUrl", imageUrlFor(item, "episode"));
  return card;
}

export interface ContinueWatchingSources {
  /** Jellyfin's `/UserItems/Resume` list: partly watched items, newest first. */
  resume: JellyfinItem[];
  /** Jellyfin's `/Shows/NextUp` list: one episode per series with history. */
  nextUp: JellyfinItem[];
  /**
   * Finished episodes (`Filters=IsPlayed`). Their series are the only ones that
   * may contribute a next-up card, and their dates order it.
   */
  played: JellyfinItem[];
}

/**
 * Merge Jellyfin's two lists into the Continue watching row.
 *
 * A resume card wins for its series: when an episode is partly watched, that is
 * what the user should be offered, not the episode after the last completed
 * one. Next-up cards are gated on a completed episode as well, because Jellyfin
 * returns a series' first episode when nothing in it is marked played. The
 * result is ordered by the most recent activity and capped like the row.
 */
export function buildContinueWatching(
  sources: ContinueWatchingSources,
  limit: number = RESUME_ITEM_LIMIT,
): ContinueWatchingItem[] {
  const resumeCards = mapResumeItems(sources.resume, limit);
  const resumeSeries = new Set(
    resumeCards
      .map((card) => card.seriesId)
      .filter((seriesId): seriesId is string => seriesId !== undefined),
  );

  // `played` is ordered newest-first, so the first date seen for a series is
  // its most recent completion.
  const lastCompleted = new Map<string, string | undefined>();
  for (const episode of sources.played) {
    if (!episode.SeriesId || lastCompleted.has(episode.SeriesId)) {
      continue;
    }
    lastCompleted.set(episode.SeriesId, episode.UserData?.LastPlayedDate);
  }

  const nextUpCards: ContinueWatchingItem[] = [];
  const seenSeries = new Set(resumeSeries);
  for (const item of sources.nextUp) {
    const card = mapNextUpItem(item);
    if (!card?.seriesId || !lastCompleted.has(card.seriesId) || seenSeries.has(card.seriesId)) {
      continue;
    }
    seenSeries.add(card.seriesId);
    nextUpCards.push(card);
  }

  return [...resumeCards, ...nextUpCards]
    .map((card, index) => ({ card, index, at: lastActivity(card, lastCompleted) }))
    .sort((left, right) =>
      left.at === right.at ? left.index - right.index : left.at < right.at ? 1 : -1,
    )
    .slice(0, limit)
    .map(({ card }) => card);
}

/** Milliseconds of the card's last activity; unknown dates sort last. */
function lastActivity(
  card: ContinueWatchingItem,
  completed: ReadonlyMap<string, string | undefined>,
): number {
  const stamp = card.lastPlayedDate ?? (card.seriesId ? completed.get(card.seriesId) : undefined);
  const millis = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return Number.isNaN(millis) ? Number.NEGATIVE_INFINITY : millis;
}

/**
 * 16:9 still for the card. Episodes have their own screenshot; movies only have
 * a 2:3 poster as `Primary`, so a backdrop is preferred and the poster is the
 * fallback (cropped by the card's `object-cover`).
 */
function imageUrlFor(item: JellyfinItem, kind: ContinueWatchingItem["kind"]): string | undefined {
  const params = new URLSearchParams();
  if (kind === "movie") {
    const backdrop = item.BackdropImageTags?.[0];
    if (backdrop) {
      params.set("type", "Backdrop");
      params.set("tag", backdrop);
      params.set("maxWidth", String(CARD_IMAGE_MAX_WIDTH));
      return imagePath(item.Id as string, params);
    }
  } else {
    const still = item.ImageTags?.Primary;
    if (still) {
      params.set("tag", still);
      params.set("maxWidth", String(CARD_IMAGE_MAX_WIDTH));
      return imagePath(item.Id as string, params);
    }
    const seriesPoster = item.SeriesPrimaryImageTag;
    if (seriesPoster && item.SeriesId) {
      params.set("tag", seriesPoster);
      params.set("maxWidth", String(CARD_IMAGE_MAX_WIDTH));
      return imagePath(item.SeriesId, params);
    }
    return undefined;
  }

  const poster = item.ImageTags?.Primary;
  if (poster) {
    params.set("tag", poster);
    params.set("maxWidth", String(CARD_IMAGE_MAX_WIDTH));
    return imagePath(item.Id as string, params);
  }
  return undefined;
}

function imagePath(itemId: string, params: URLSearchParams): string {
  return `/api/library/images/${encodeURIComponent(itemId)}?${params.toString()}`;
}

function playedPercentage(
  reported: number | undefined,
  positionTicks: number,
  runtimeTicks: number | undefined,
): number {
  if (reported !== undefined && Number.isFinite(reported)) {
    return clampPercent(reported);
  }
  if (!runtimeTicks || runtimeTicks <= 0) {
    return 0;
  }
  return clampPercent((positionTicks / runtimeTicks) * 100);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

export function continueWatchingResponse(
  state: LibraryState,
  items: ContinueWatchingItem[] = [],
  detail?: string,
): ContinueWatchingResponse {
  return detail === undefined
    ? { source: "jellyfin", state, items }
    : { source: "jellyfin", state, items, detail };
}

function assignIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

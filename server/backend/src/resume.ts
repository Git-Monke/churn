import type { ContinueWatchingItem, ContinueWatchingResponse, LibraryState } from "./types.js";
import type { JellyfinItem } from "./upstream/jellyfin.js";

/** How many cards the row asks Jellyfin for; the row itself shows fewer. */
export const RESUME_FETCH_LIMIT = 20;
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

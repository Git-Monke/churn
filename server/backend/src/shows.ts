import type {
  ShowAvailability,
  ShowDetailResponse,
  ShowDownload,
  ShowEpisode,
  ShowSeason,
  ShowSeriesSummary,
  ShowSource,
} from "./types.js";
import { mapShowTorrentDownloads } from "./qbittorrent-show.js";
import type { JellyfinItem } from "./upstream/jellyfin.js";
import type { QbittorrentTorrent } from "./upstream/qbittorrent.js";
import type {
  ServarrEpisode,
  ServarrSeriesResource,
} from "./upstream/servarr.js";

export interface BuildShowDetailInput {
  source: ShowSource;
  series: ShowSeriesSummary;
  jellyfinSeasons?: JellyfinItem[];
  jellyfinEpisodes?: JellyfinItem[];
  sonarrEpisodes?: ServarrEpisode[];
  /** Download status comes only from qBittorrent. */
  qbittorrentTorrents?: QbittorrentTorrent[];
}

interface EpisodeCandidate {
  key: string;
  seasonNumber: number;
  episodeNumber: number;
  jellyfin?: JellyfinItem;
  sonarr?: ServarrEpisode;
}

export function buildShowDetail(input: BuildShowDetailInput): {
  defaultSeason?: number;
  seasons: ShowSeason[];
  episodes: ShowEpisode[];
} {
  const candidates = new Map<string, EpisodeCandidate>();
  const jellyfinSeasonNames = new Map<number, string>();
  const jellyfinSeasonNumbers = new Set<number>();

  for (const season of input.jellyfinSeasons ?? []) {
    const number = season.IndexNumber;
    if (!Number.isInteger(number)) {
      continue;
    }
    jellyfinSeasonNumbers.add(number as number);
    if (season.Name) {
      jellyfinSeasonNames.set(number as number, season.Name);
    }
  }

  for (const episode of input.jellyfinEpisodes ?? []) {
    const seasonNumber = episode.ParentIndexNumber;
    const episodeNumber = episode.IndexNumber;
    if (!Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) {
      continue;
    }
    const key = episodeKey(seasonNumber as number, episodeNumber as number);
    candidates.set(key, {
      key,
      seasonNumber: seasonNumber as number,
      episodeNumber: episodeNumber as number,
      jellyfin: episode,
    });
  }

  for (const episode of input.sonarrEpisodes ?? []) {
    if (!Number.isInteger(episode.seasonNumber) || !Number.isInteger(episode.episodeNumber)) {
      continue;
    }
    const key = episodeKey(episode.seasonNumber as number, episode.episodeNumber as number);
    const existing = candidates.get(key);
    if (existing) {
      existing.sonarr = episode;
    } else {
      candidates.set(key, {
        key,
        seasonNumber: episode.seasonNumber as number,
        episodeNumber: episode.episodeNumber as number,
        sonarr: episode,
      });
    }
  }

  // Match active qBittorrent downloads against every episode candidate, not
  // just missing ones, so an upgrade/replacement stays visible beside a playable
  // Jellyfin episode. Sonarr/Radarr queue state is deliberately not consulted.
  const downloads = mapShowTorrentDownloads(
    input.qbittorrentTorrents ?? [],
    input.series.title,
    [...candidates.values()],
  );
  const fallbackImage = input.series.imageUrl;
  const episodes = [...candidates.values()]
    .sort((left, right) =>
      left.seasonNumber === right.seasonNumber
        ? left.episodeNumber - right.episodeNumber
        : left.seasonNumber - right.seasonNumber,
    )
    .map((candidate) =>
      mapEpisode(candidate, downloads.get(candidate.key), fallbackImage),
    );

  const seasonNumbers = new Set<number>(jellyfinSeasonNumbers);
  for (const episode of episodes) {
    seasonNumbers.add(episode.seasonNumber);
  }

  const seasons = [...seasonNumbers]
    .sort((left, right) => left - right)
    .map((seasonNumber) => summarizeSeason(seasonNumber, seasonsName(seasonNumber, jellyfinSeasonNames), episodes));

  return {
    defaultSeason: pickDefaultSeason(seasons, episodes),
    seasons,
    episodes,
  };
}

function mapEpisode(
  candidate: EpisodeCandidate,
  download: ShowDownload | undefined,
  fallbackImage: string | undefined,
): ShowEpisode {
  const { jellyfin, sonarr } = candidate;
  const episode: ShowEpisode = {
    key: candidate.key,
    seasonNumber: candidate.seasonNumber,
    episodeNumber: candidate.episodeNumber,
    title:
      jellyfin?.Name?.trim() ||
      sonarr?.title?.trim() ||
      `Episode ${candidate.episodeNumber}`,
    availability: availabilityFor(candidate),
  };

  assignIfDefined(episode, "overview", jellyfin?.Overview ?? sonarr?.overview);
  assignIfDefined(episode, "airDate", jellyfin?.PremiereDate ?? sonarr?.airDateUtc);
  assignIfDefined(episode, "runtimeMinutes", runtimeMinutes(jellyfin?.RunTimeTicks));
  assignIfDefined(episode, "imageUrl", jellyfinImageUrl(jellyfin) ?? fallbackImage);
  assignIfDefined(episode, "monitored", sonarr?.monitored);
  assignIfDefined(episode, "jellyfinId", jellyfin?.Id);
  if (!jellyfin && sonarr?.hasFile) {
    episode.imported = true;
  }
  if (download) {
    // A finished torrent can stay in qBittorrent while it seeds, but once
    // Jellyfin exposes the episode the "waiting for indexing" overlay is stale
    // and contradicts the play button. Keep active downloads/upgrades visible.
    const staleImport =
      (episode.availability === "jellyfin" || episode.imported === true) &&
      download.status === "importing";
    if (!staleImport) {
      episode.download = download;
    }
  }
  return episode;
}

/**
 * Jellyfin alone determines playability. A Sonarr file that Jellyfin has not
 * indexed is exposed through `imported`, not through an availability value that
 * would make the episode look playable.
 */
function availabilityFor(candidate: EpisodeCandidate): ShowAvailability {
  if (candidate.jellyfin) {
    return "jellyfin";
  }
  if (
    candidate.sonarr?.airDateUtc &&
    Date.parse(candidate.sonarr.airDateUtc) > Date.now()
  ) {
    return "upcoming";
  }
  return "missing";
}

function summarizeSeason(seasonNumber: number, name: string, episodes: ShowEpisode[]): ShowSeason {
  const inSeason = episodes.filter((episode) => episode.seasonNumber === seasonNumber);
  return {
    seasonNumber,
    name,
    episodeCount: inSeason.length,
    availableCount: inSeason.filter((episode) => episode.availability === "jellyfin").length,
    downloadingCount: inSeason.filter((episode) => episode.download !== undefined).length,
  };
}

function pickDefaultSeason(seasons: ShowSeason[], episodes: ShowEpisode[]): number | undefined {
  const available = seasons.find((season) => season.availableCount > 0);
  if (available) {
    return available.seasonNumber;
  }
  const downloading = seasons.find((season) => season.downloadingCount > 0);
  if (downloading) {
    return downloading.seasonNumber;
  }
  const nonSpecial = seasons.find((season) => season.seasonNumber > 0);
  if (nonSpecial) {
    return nonSpecial.seasonNumber;
  }
  return seasons[0]?.seasonNumber ?? episodes[0]?.seasonNumber;
}

function seasonsName(seasonNumber: number, jellyfinNames: Map<number, string>): string {
  if (seasonNumber === 0) {
    return jellyfinNames.get(0) ?? "Specials";
  }
  return jellyfinNames.get(seasonNumber) ?? `Season ${seasonNumber}`;
}

function episodeKey(seasonNumber: number, episodeNumber: number): string {
  return `s${String(seasonNumber).padStart(2, "0")}e${String(episodeNumber).padStart(2, "0")}`;
}

function jellyfinImageUrl(item: JellyfinItem | undefined): string | undefined {
  const tag = item?.ImageTags?.Primary;
  if (!item?.Id || !tag) {
    return undefined;
  }
  return `/api/library/images/${encodeURIComponent(item.Id)}?tag=${encodeURIComponent(tag)}`;
}

function runtimeMinutes(ticks: number | undefined): number | undefined {
  return ticks === undefined ? undefined : Math.round(ticks / 600_000_000);
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

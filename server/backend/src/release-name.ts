import type { AppConfig } from "./config.js";
import { seasonRangeFromTitle } from "./activity.js";
import {
  createArrClient,
  type ServarrParseResponse,
  type ServarrParsedEpisodeInfo,
  type ServarrParsedMovieInfo,
} from "./upstream/servarr.js";

export interface ParsedReleaseName {
  /** Primary title reported by the arr parser. */
  title: string;
  titleTokens: string[];
  /** All titles the arr considered, e.g. Radarr's alternate movie titles. */
  titleAliases: string[];
  years: number[];
  seasonNumbers: number[];
  episodeNumbers: number[];
  /** A release without an episode marker, e.g. S01 or S01-03. */
  seasonPack: boolean;
  /** 0 = 480p/SD, 1 = 720p, 2 = 1080p, 3 = 2160p. */
  tier?: number;
  quality?: string;
}

export interface ReleaseTitleParser {
  parse(kind: "movie" | "series", title: string): Promise<ParsedReleaseName | undefined>;
}

export interface ReleaseTitleParserOptions {
  maxEntries?: number;
}

const DEFAULT_CACHE_ENTRIES = 500;

/**
 * Create a release-title parser backed by Sonarr/Radarr's own
 * `GET /api/v3/parse?title=...` endpoint. Successful parses are cached for the
 * lifetime of this process; in-flight requests are shared by duplicate titles.
 */
export function createReleaseParser(
  config: AppConfig,
  options: ReleaseTitleParserOptions = {},
): ReleaseTitleParser {
  const maxEntries = options.maxEntries ?? DEFAULT_CACHE_ENTRIES;
  const cache = new Map<string, ParsedReleaseName>();
  const inFlight = new Map<string, Promise<ParsedReleaseName | undefined>>();
  const clients = new Map<"movie" | "series", ReturnType<typeof createArrClient>>();

  function arrClient(kind: "movie" | "series") {
    const existing = clients.get(kind);
    if (existing) {
      return existing;
    }
    const serviceId = kind === "movie" ? "radarr" : "sonarr";
    const client = createArrClient(serviceId, config.services[serviceId], config.requestTimeoutMs);
    clients.set(kind, client);
    return client;
  }

  function remember(key: string, parsed: ParsedReleaseName): void {
    cache.set(key, parsed);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }

  async function parse(kind: "movie" | "series", title: string): Promise<ParsedReleaseName | undefined> {
    const key = `${kind}:${title}`;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }

    const run = (async () => {
      const response = await arrClient(kind).parseTitle(title);
      const parsed = mapArrParseResponse(kind, title, response);
      if (parsed) {
        remember(key, parsed);
      }
      return parsed;
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, run);
    return run;
  }

  return { parse };
}

/** Convert Sonarr/Radarr `/parse` output into the shape release search uses. */
export function mapArrParseResponse(
  kind: "movie" | "series",
  rawTitle: string,
  response: ServarrParseResponse,
): ParsedReleaseName | undefined {
  return kind === "movie"
    ? mapMovieParse(response.parsedMovieInfo)
    : mapSeriesParse(rawTitle, response.parsedEpisodeInfo);
}

function mapMovieParse(info: ServarrParsedMovieInfo | undefined): ParsedReleaseName | undefined {
  if (!info) {
    return undefined;
  }
  const aliases = uniqueStrings([
    ...(info.movieTitles ?? []),
    info.movieTitle,
    info.primaryMovieTitle,
  ]);
  const title =
    cleanTitle(info.primaryMovieTitle) ??
    cleanTitle(info.movieTitle) ??
    aliases[0];
  if (!title) {
    return undefined;
  }
  const quality = qualityFromResolution(info.quality?.quality?.resolution);
  return {
    title,
    titleTokens: tokenize(title),
    titleAliases: aliases,
    years: validYear(info.year) ? [info.year as number] : [],
    seasonNumbers: [],
    episodeNumbers: [],
    seasonPack: false,
    ...(quality ? { tier: quality.tier, quality: quality.label } : {}),
  };
}

function mapSeriesParse(
  rawTitle: string,
  info: ServarrParsedEpisodeInfo | undefined,
): ParsedReleaseName | undefined {
  if (!info) {
    return undefined;
  }
  const title =
    cleanTitle(info.seriesTitleInfo?.titleWithoutYear) ??
    cleanTitle(info.seriesTitleInfo?.title) ??
    cleanTitle(info.seriesTitle);
  if (!title) {
    return undefined;
  }

  const range = info.isMultiSeason ? seasonRangeFromTitle(rawTitle) : [];
  const seasonNumbers =
    range.length > 0
      ? range
      : Number.isInteger(info.seasonNumber)
        ? [info.seasonNumber as number]
        : [];
  const episodeNumbers = uniqueNumbers(info.episodeNumbers ?? []);
  const seasonPack =
    info.fullSeason === true ||
    info.releaseType === "seasonPack" ||
    (seasonNumbers.length > 0 && episodeNumbers.length === 0);
  const year = info.seriesTitleInfo?.year;
  const quality = qualityFromResolution(info.quality?.quality?.resolution);

  return {
    title,
    titleTokens: tokenize(title),
    titleAliases: [],
    years: validYear(year) ? [year] : [],
    seasonNumbers,
    episodeNumbers,
    seasonPack,
    ...(quality ? { tier: quality.tier, quality: quality.label } : {}),
  };
}

/** True when a parsed arr release points at this exact movie. */
export function releaseMatchesMovie(
  parsed: ParsedReleaseName,
  movie: { title: string; year?: number },
): boolean {
  const requestedTokens = tokenize(movie.title);
  const titles = [parsed.title, ...(parsed.titleAliases ?? [])];
  if (!titles.some((title) => sameTitle(tokenize(title), requestedTokens))) {
    return false;
  }
  // If the release carries a year, it must agree with the requested movie.
  // Some indexers omit the year, so a missing year is not a rejection by itself.
  return movie.year === undefined || parsed.years.length === 0 || parsed.years.includes(movie.year);
}

/** True when a parsed arr release belongs to the requested series season/episode. */
export function releaseMatchesSeries(
  parsed: ParsedReleaseName,
  series: { title: string; year?: number },
  seasonNumber: number,
  episodeNumber?: number,
): boolean {
  if (!seriesTitleMatches(parsed.titleTokens, tokenize(series.title))) {
    return false;
  }
  if (parsed.seasonNumbers.length === 0) {
    return false;
  }
  if (!parsed.seasonNumbers.includes(seasonNumber)) {
    return false;
  }
  if (episodeNumber === undefined) {
    return true;
  }
  if (parsed.episodeNumbers.length === 0) {
    // A season pack or multi-season pack covers the requested episode.
    return parsed.seasonPack;
  }
  return parsed.episodeNumbers.includes(episodeNumber);
}

/** Label such as "S01E02" or "S01E02–E04", if the filename contains episodes. */
export function releaseEpisodeLabel(parsed: ParsedReleaseName): string | undefined {
  if (parsed.episodeNumbers.length === 0 || parsed.seasonNumbers.length === 0) {
    return undefined;
  }
  const season = parsed.seasonNumbers[0];
  const prefix = `S${String(season).padStart(2, "0")}`;
  const episodes = parsed.episodeNumbers;
  if (episodes.length === 1) {
    return `${prefix}E${String(episodes[0]).padStart(2, "0")}`;
  }
  const contiguous = episodes.every(
    (episode, index) => index === 0 || episode === (episodes[index - 1] as number) + 1,
  );
  if (contiguous) {
    return `${prefix}E${String(episodes[0]).padStart(2, "0")}\u2013E${String(
      episodes[episodes.length - 1],
    ).padStart(2, "0")}`;
  }
  return episodes.map((episode) => `${prefix}E${String(episode).padStart(2, "0")}`).join(", ");
}

/** Label such as "Season 2" or "Seasons 1–3". */
export function releaseSeasonLabel(parsed: ParsedReleaseName): string {
  const seasons = parsed.seasonNumbers;
  if (seasons.length === 0) {
    return "Season unknown";
  }
  if (seasons.length === 1) {
    return `Season ${seasons[0]}`;
  }
  const contiguous = seasons.every(
    (season, index) => index === 0 || season === (seasons[index - 1] as number) + 1,
  );
  if (contiguous) {
    return `Seasons ${seasons[0]}\u2013${seasons[seasons.length - 1]}`;
  }
  return `Seasons ${seasons.join(", ")}`;
}

/** Search phrase for one indexer. */
export function releaseSearchQuery(
  media: { kind: "movie" | "series"; title: string; year?: number },
  seasonNumber?: number,
): string {
  if (media.kind === "movie") {
    return media.year !== undefined ? `${media.title} ${media.year}` : media.title;
  }
  return seasonNumber !== undefined && seasonNumber > 0
    ? `${media.title} S${String(seasonNumber).padStart(2, "0")}`
    : media.title;
}

/** Prowlarr category for the requested media kind. */
export function releaseSearchCategory(kind: "movie" | "series"): string {
  return kind === "movie" ? "2000" : "5000";
}

export function tokenize(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function cleanTitle(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanTitle(value);
    if (!cleaned) {
      continue;
    }
    const key = tokenize(cleaned).join(" ");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function validYear(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 0))].sort(
    (left, right) => left - right,
  );
}

function seriesTitleMatches(releaseTokens: string[], titleTokens: string[]): boolean {
  if (titleTokens.length === 0 || releaseTokens.length < titleTokens.length) {
    return false;
  }
  if (!titleTokens.every((token, index) => releaseTokens[index] === token)) {
    return false;
  }
  return releaseTokens
    .slice(titleTokens.length)
    .every((token) => /^(?:19|20)\d{2}$/.test(token) || /^(?:us|uk|au|ca|nz|ie)$/.test(token));
}

function sameTitle(releaseTokens: string[], titleTokens: string[]): boolean {
  return (
    releaseTokens.length === titleTokens.length &&
    releaseTokens.every((token, index) => token === titleTokens[index])
  );
}

function qualityFromResolution(
  resolution: number | undefined,
): { tier: number; label: string } | undefined {
  if (resolution === undefined || !Number.isInteger(resolution) || resolution <= 0) {
    return undefined;
  }
  if (resolution >= 2160) {
    return { tier: 3, label: "2160p" };
  }
  if (resolution >= 1080) {
    return { tier: 2, label: "1080p" };
  }
  if (resolution >= 720) {
    return { tier: 1, label: "720p" };
  }
  return { tier: 0, label: "480p" };
}

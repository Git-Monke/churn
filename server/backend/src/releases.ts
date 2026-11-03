import { createHash } from "node:crypto";

import {
  DEFAULT_MIN_SEEDERS,
  pickRelease,
  releaseTier as resolutionTier,
  showReleaseCandidate,
  type ReleaseCandidate,
} from "./release-pick.js";
import type { ReleaseGroup, ShowRelease } from "./types.js";
import type { ServarrRelease, ServarrSeriesResource } from "./upstream/servarr.js";

/** Stable, opaque id for a Sonarr release. */
export function releaseId(release: Pick<ServarrRelease, "indexerId" | "guid">): string | null {
  if (!Number.isInteger(release.indexerId) || !release.guid) {
    return null;
  }

  return createHash("sha256")
    .update(`${release.indexerId}\u0000${release.guid}`)
    .digest("hex")
    .slice(0, 24);
}

export function findRelease(
  releases: ServarrRelease[],
  id: string,
): ServarrRelease | undefined {
  return releases.find((release) => releaseId(release) === id);
}

/** Episode ids a release can be mapped to, used when overriding a rejection. */
export function mappedEpisodeIds(release: ServarrRelease): number[] {
  return (release.mappedEpisodeInfo ?? [])
    .map((episode) => episode.id)
    .filter((id): id is number => Number.isInteger(id));
}

/** True when the arr will only download this release after an override. */
export function releaseNeedsOverride(release: ServarrRelease): boolean {
  return release.rejected === true || release.downloadAllowed === false;
}

/** Build the `POST /api/v3/release` body for a Sonarr or Radarr grab. */
export function buildReleaseGrabPayload(
  release: ServarrRelease,
  target: { seriesId?: number; movieId?: number },
  options: { override?: boolean; episodeIds?: number[] } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    guid: release.guid,
    indexerId: release.indexerId,
  };
  if (target.seriesId !== undefined) {
    payload.seriesId = target.seriesId;
  }
  if (target.movieId !== undefined) {
    payload.movieId = target.movieId;
  }
  if (options.override) {
    payload.shouldOverride = true;
    if (options.episodeIds && options.episodeIds.length > 0) {
      payload.episodeIds = options.episodeIds;
    }
    payload.quality = release.quality;
    payload.languages = release.languages ?? [{ id: 0, name: "Unknown" }];
  }
  return payload;
}

/** Keep releases that can plausibly satisfy the requested season. */
export function releaseMatchesSeason(release: ServarrRelease, seasonNumber: number): boolean {
  if (release.seasonNumber === seasonNumber) {
    return true;
  }
  if ((release.seasonNumbers ?? []).includes(seasonNumber)) {
    return true;
  }
  if ((release.mappedEpisodeInfo ?? []).some((episode) => episode.seasonNumber === seasonNumber)) {
    return true;
  }

  const seasons = releaseSeasonNumbers(release);
  return seasons.length === 0 || seasons.includes(seasonNumber);
}

/** Keep releases that explicitly map to the requested episode. */
export function releaseMatchesEpisode(
  release: ServarrRelease,
  seasonNumber: number,
  episodeNumber: number,
): boolean {
  if (
    (release.mappedEpisodeInfo ?? []).some(
      (episode) =>
        episode.seasonNumber === seasonNumber && episode.episodeNumber === episodeNumber,
    )
  ) {
    return true;
  }
  const seasons = releaseSeasonNumbers(release);
  if (seasons.length > 0 && !seasons.includes(seasonNumber)) {
    return false;
  }
  return releaseEpisodeNumbers(release).includes(episodeNumber);
}

/**
 * Map Sonarr releases into the smaller shape the browser needs and mark the
 * release that should be downloaded first. Unlike Sonarr's own picker, the
 * recommendation weighs seeders: a well-seeded 1080p release beats a 720p
 * release with one seeder when the callers allow a tier upgrade.
 */
export function toShowReleases(
  releases: ServarrRelease[],
  options: { minSeeders?: number } = {},
): ShowRelease[] {
  const mapped: Array<{ release: ShowRelease; candidate: ReleaseCandidate<ServarrRelease> }> = [];
  for (const release of releases) {
    const item = mapRelease(release, "series");
    if (!item) {
      continue;
    }
    mapped.push({
      release: item,
      candidate: showReleaseCandidate(release, item.mappedEpisodeCount),
    });
  }

  const approved = mapped.filter((entry) => entry.release.approved);
  const override = mapped
    .filter((entry) => !entry.release.approved && entry.release.canGrab)
    .sort((left, right) => left.release.sizeBytes - right.release.sizeBytes);
  const blocked = mapped.filter(
    (entry) => !entry.release.approved && !entry.release.canGrab,
  );
  const ordered = [...approved, ...override, ...blocked].map((entry) => entry.release);

  const pick = pickRelease(
    mapped.map((entry) => entry.candidate),
    { minSeeders: options.minSeeders ?? DEFAULT_MIN_SEEDERS },
  );
  if (pick) {
    const recommended = ordered.find((release) => release.id === releaseId(pick.release));
    if (recommended) {
      recommended.recommended = true;
      recommended.recommendation = pick.reason;
    }
  }

  return ordered;
}

function mapRelease(
  release: ServarrRelease,
  kind: "movie" | "series" = "series",
): ShowRelease | null {
  const id = releaseId(release);
  if (!id) {
    return null;
  }

  const seasonNumbers = releaseSeasonNumbers(release);
  const episodeNumbers = releaseEpisodeNumbers(release);
  const rejections = release.rejections ?? [];
  const approved = release.approved === true;
  const mappedEpisodeCount = (release.mappedEpisodeInfo ?? []).filter(
    (episode) => Number.isInteger(episode.id),
  ).length;
  const downloadSource =
    release.magnetUrl?.trim() ||
    release.downloadUrl?.trim() ||
    (release.guid?.toLowerCase().startsWith("magnet:") ? release.guid : undefined);
  const canGrab =
    kind === "movie" ? movieReleaseCanGrab(release) : Boolean(downloadSource);
  const protocol =
    release.protocol === "torrent" || release.protocol === "usenet"
      ? release.protocol
      : undefined;

  const tier = resolutionTier(release);
  return {
    id,
    title: release.title?.trim() || "Unknown release",
    indexer: release.indexer,
    sizeBytes: release.size ?? 0,
    quality: release.quality?.quality?.name,
    ...(tier !== undefined ? { tier, tierLabel: releaseTierLabel(tier) } : {}),
    seasonLabel: seasonLabel(seasonNumbers),
    episodeLabel: releaseEpisodeLabel(release, seasonNumbers, episodeNumbers),
    multiSeason:
      seasonNumbers.length > 1 ||
      rejections.some((reason) => /multi[- ]season/i.test(reason)),
    approved,
    canGrab,
    recommended: false,
    rejections,
    mappedEpisodeCount,
    protocol,
    seeders: release.seeders,
    leechers: release.leechers,
    ageHours: release.ageHours,
    publishDate: release.publishDate,
  };
}

function releaseEpisodeNumbers(release: ServarrRelease): number[] {
  const explicit = (release.episodeNumbers ?? []).filter(
    (episode): episode is number => Number.isInteger(episode) && episode >= 0,
  );
  if (explicit.length > 0) {
    return [...new Set(explicit)].sort((left, right) => left - right);
  }

  const mapped = (release.mappedEpisodeInfo ?? [])
    .map((episode) => episode.episodeNumber)
    .filter(
      (episode): episode is number =>
        episode !== undefined && Number.isInteger(episode) && episode >= 0,
    );
  if (mapped.length > 0) {
    return [...new Set(mapped)].sort((left, right) => left - right);
  }

  const range = release.title?.match(
    /\bS\d{1,3}E(\d{1,3})(?:\s*[-\u2013]\s*E?(\d{1,3}))?\b/i,
  );
  if (!range) {
    return [];
  }
  const start = Number.parseInt(range[1] ?? "", 10);
  const end = Number.parseInt(range[2] ?? range[1] ?? "", 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 50) {
    return [];
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function releaseSeasonNumbers(release: ServarrRelease): number[] {
  const explicit = (release.seasonNumbers ?? []).filter(
    (season): season is number => Number.isInteger(season) && season >= 0,
  );
  if (explicit.length > 1) {
    return [...new Set(explicit)].sort((left, right) => left - right);
  }

  // Sonarr's parser exposes a single `seasonNumber` (and sometimes a single
  // `seasonNumbers` entry) even for releases such as "Show.S01-03". Recover the
  // intended range from the title.
  const range = release.title?.match(/\bS(\d{1,2})\s*[-\u2013]\s*S?(\d{1,2})\b/i);
  if (range) {
    const start = Number.parseInt(range[1] ?? "", 10);
    const end = Number.parseInt(range[2] ?? "", 10);
    if (Number.isInteger(start) && Number.isInteger(end) && start <= end && end - start <= 50) {
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
  }

  if (explicit.length === 1) {
    return explicit;
  }

  if (Number.isInteger(release.seasonNumber) && (release.seasonNumber ?? -1) >= 0) {
    return [release.seasonNumber as number];
  }

  return [];
}

/**
 * Seasons a full-season release covers. Sonarr exposes `S01-03` as a single
 * `seasonNumber` without `seasonNumbers`, so recover the range from the title.
 * Returns undefined for episode releases and packs for a different season.
 */
export function seasonPackSeasons(
  release: ServarrRelease,
  seasonNumber: number,
): number[] | undefined {
  if (release.fullSeason !== true) {
    return undefined;
  }
  const seasons = releaseSeasonNumbers(release);
  if (seasons.length === 0) {
    return release.seasonNumber === undefined || release.seasonNumber === seasonNumber
      ? [seasonNumber]
      : undefined;
  }
  return seasons.includes(seasonNumber) ? seasons : undefined;
}

export interface SeasonMonitoringClient {
  getSeries(id: number): Promise<ServarrSeriesResource>;
  updateSeries(id: number, payload: Record<string, unknown>): Promise<ServarrSeriesResource>;
}

/** Monitor every season a multi-season pack covers before grabbing it. */
export async function monitorSeriesSeasons(
  client: SeasonMonitoringClient,
  seriesId: number,
  seasonNumbers: number[],
): Promise<void> {
  const desired = new Set(
    seasonNumbers.filter((season) => Number.isInteger(season) && season >= 0),
  );
  if (desired.size === 0) {
    return;
  }

  const series = await client.getSeries(seriesId);
  const seasons = series.seasons ?? [];
  let changed = false;
  const updated = seasons.map((season) => {
    if (!desired.has(season.seasonNumber) || season.monitored) {
      return season;
    }
    changed = true;
    return { ...season, monitored: true };
  });
  if (!changed) {
    return;
  }
  await client.updateSeries(seriesId, { ...series, seasons: updated });
}

function releaseEpisodeLabel(
  release: ServarrRelease,
  seasons: number[],
  episodes: number[],
): string | undefined {
  if (
    release.fullSeason === true ||
    seasons.length > 1 ||
    !/\bS\d{1,3}E\d{1,3}\b/i.test(release.title ?? "")
  ) {
    return undefined;
  }
  return episodeLabel(seasons, episodes);
}

function episodeLabel(seasons: number[], episodes: number[]): string | undefined {
  if (episodes.length === 0) {
    return undefined;
  }
  const season = seasons[0];
  const prefix = season !== undefined ? `S${String(season).padStart(2, "0")}` : "";
  if (episodes.length === 1) {
    return `${prefix}E${String(episodes[0]).padStart(2, "0")}`;
  }
  const contiguous = episodes.every(
    (episode, index) => index === 0 || episode === (episodes[index - 1] as number) + 1,
  );
  if (contiguous) {
    return `${prefix}E${String(episodes[0]).padStart(2, "0")}\u2013E${String(episodes[episodes.length - 1]).padStart(2, "0")}`;
  }
  return episodes.map((episode) => `${prefix}E${String(episode).padStart(2, "0")}`).join(", ");
}

function seasonLabel(seasons: number[]): string {
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


/** Label for a resolution tier used by the cached release chooser. */
export function releaseTierLabel(tier: number): string {
  switch (tier) {
    case 0:
      return "480p";
    case 1:
      return "720p";
    case 2:
      return "1080p";
    case 3:
      return "2160p";
    default:
      return "Other";
  }
}

/**
 * Radarr can grab a rejected release with an override when the rejection is
 * about quality, language, custom formats, etc. Releases it cannot match to the
 * movie at all are not usable from the chooser.
 */
function movieReleaseCanGrab(release: ServarrRelease): boolean {
  if (release.approved === true) {
    return true;
  }
  const rejections = (release.rejections ?? []).join(" ");
  return !/unknown movie|unable to match|could not be matched|not a movie|no matching movie|movie not found/i.test(
    rejections,
  );
}

/** Seeders descending, then size ascending, then oldest first. */
export function compareReleaseOptions(left: ShowRelease, right: ShowRelease): number {
  const seeders = (right.seeders ?? -1) - (left.seeders ?? -1);
  if (seeders !== 0) {
    return seeders;
  }
  const size = left.sizeBytes - right.sizeBytes;
  if (size !== 0) {
    return size;
  }
  return (left.ageHours ?? Number.POSITIVE_INFINITY) - (right.ageHours ?? Number.POSITIVE_INFINITY);
}

/**
 * Group releases into the quality tiers the browser shows. Empty tiers are
 * omitted, and groups are ordered from 480p to 2160p with unknown qualities
 * last.
 */
export function toReleaseGroups(
  releases: ServarrRelease[],
  kind: "movie" | "series" = "series",
): ReleaseGroup[] {
  const mapped = releases
    .map((release) => mapRelease(release, kind))
    .filter((release): release is ShowRelease => release !== null);
  return groupShowReleases(mapped);
}

export function groupShowReleases(
  releases: ShowRelease[],
  options: { includeUnavailable?: boolean } = {},
): ReleaseGroup[] {
  const groups = new Map<number, ShowRelease[]>();
  for (const release of releases) {
    // Legacy callers hide releases the arr cannot grab. The Prowlarr chooser
    // keeps them visible but disables Download so every indexer is represented.
    if (!release.canGrab && options.includeUnavailable !== true) {
      continue;
    }
    const tier = release.tier ?? 99;
    const group = groups.get(tier);
    if (group) {
      group.push(release);
    } else {
      groups.set(tier, [release]);
    }
  }

  return [...groups.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([tier, entries]) => {
      const sorted = [...entries].sort(compareReleaseOptions);
      const seeders = sorted
        .map((release) => release.seeders)
        .filter((value): value is number => value !== undefined);
      const maxSeeders = seeders.length > 0 ? Math.max(...seeders) : undefined;
      return {
        tier,
        label: releaseTierLabel(tier),
        ...(maxSeeders !== undefined ? { maxSeeders } : {}),
        lowSeeders: maxSeeders !== undefined && maxSeeders < 50,
        releases: sorted,
      };
    });
}

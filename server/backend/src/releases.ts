import { createHash } from "node:crypto";

import type { ShowRelease } from "./types.js";
import type { ServarrRelease } from "./upstream/servarr.js";

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

/** Map Sonarr releases into the smaller shape the browser needs. */
export function toShowReleases(releases: ServarrRelease[]): ShowRelease[] {
  const mapped = releases
    .map(mapRelease)
    .filter((release): release is ShowRelease => release !== null);

  const approved = mapped.filter((release) => release.approved);
  const override = mapped
    .filter((release) => !release.approved && release.canGrab)
    .sort((left, right) => left.sizeBytes - right.sizeBytes);
  const blocked = mapped.filter((release) => !release.approved && !release.canGrab);
  const ordered = [...approved, ...override, ...blocked];

  const recommended = ordered.find((release) => release.approved) ?? ordered.find((release) => release.canGrab);
  if (recommended) {
    recommended.recommended = true;
  }

  return ordered;
}

function mapRelease(release: ServarrRelease): ShowRelease | null {
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
  const canGrab = approved || mappedEpisodeCount > 0;
  const protocol =
    release.protocol === "torrent" || release.protocol === "usenet"
      ? release.protocol
      : undefined;

  return {
    id,
    title: release.title?.trim() || "Unknown release",
    indexer: release.indexer,
    sizeBytes: release.size ?? 0,
    quality: release.quality?.quality?.name,
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

function releaseSeasonNumbers(release: ServarrRelease): number[] {
  const explicit = (release.seasonNumbers ?? []).filter(
    (season): season is number => Number.isInteger(season) && season >= 0,
  );
  if (explicit.length > 0) {
    return [...new Set(explicit)].sort((left, right) => left - right);
  }

  // Sonarr's parser exposes a single `seasonNumber` even for releases such as
  // "Show.S01-03". Recover the intended range from the title for display.
  const range = release.title?.match(/\bS(\d{1,2})\s*[-\u2013]\s*S?(\d{1,2})\b/i);
  if (range) {
    const start = Number.parseInt(range[1] ?? "", 10);
    const end = Number.parseInt(range[2] ?? "", 10);
    if (Number.isInteger(start) && Number.isInteger(end) && start <= end && end - start <= 50) {
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
  }

  if (Number.isInteger(release.seasonNumber) && (release.seasonNumber ?? -1) >= 0) {
    return [release.seasonNumber as number];
  }

  return [];
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

import type { ShowEpisode } from "@/api/types";

/**
 * Watch state for a show page row. Everything here comes from Jellyfin's own
 * per-user data (`played`, `progressPercent`, `lastPlayedDate`): Churn does not
 * invent a threshold or store progress itself.
 */
function isPlayable(episode: ShowEpisode): boolean {
  return (
    episode.availability === "jellyfin" &&
    episode.jellyfinId !== undefined &&
    // Specials are not what anyone means by "next episode".
    episode.seasonNumber !== 0
  );
}

function isInProgress(episode: ShowEpisode): boolean {
  return episode.played !== true && episode.progressPercent !== undefined;
}

function compareEpisodes(left: ShowEpisode, right: ShowEpisode): number {
  return left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber;
}

function lastPlayedMs(episode: ShowEpisode): number {
  const parsed = Date.parse(episode.lastPlayedDate ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The episode the show header should play: whatever this user is part-way
 * through (most recently played first), otherwise the first unwatched episode,
 * otherwise the first playable one, so a finished show still has a Play button.
 */
export function resumeTarget(episodes: ShowEpisode[]): ShowEpisode | undefined {
  const playable = episodes.filter(isPlayable);

  const inProgress = playable
    .filter(isInProgress)
    .sort(
      (left, right) =>
        lastPlayedMs(right) - lastPlayedMs(left) || compareEpisodes(left, right),
    )[0];
  if (inProgress) {
    return inProgress;
  }

  const ordered = [...playable].sort(compareEpisodes);
  return ordered.find((episode) => episode.played !== true) ?? ordered[0];
}

/**
 * Accessible name for a playable row, so watch state reaches screen readers too
 * (`Play episode 6: Rock Show, 13% watched`).
 */
export function playLabel(episode: ShowEpisode): string {
  const label = `Play episode ${episode.episodeNumber}: ${episode.title}`;
  if (episode.played === true) {
    return `${label}, watched`;
  }
  if (episode.progressPercent !== undefined) {
    return `${label}, ${Math.round(episode.progressPercent)}% watched`;
  }
  return label;
}

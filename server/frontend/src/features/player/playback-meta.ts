import type { PlaybackSegment } from "@/api/types";

export const TICKS_PER_SECOND = 10_000_000;

/** Offer the next episode this long before the file ends, absent a marker. */
export const UP_NEXT_LEAD_SECONDS = 20;
export const UP_NEXT_COUNTDOWN_SECONDS = 3;

/** A saved position this close to the end is not worth resuming. */
export const RESUME_END_MARGIN_SECONDS = 30;

/**
 * Where playback should start, in seconds. `0` means the beginning. Autoplay
 * advances with `restart`, and a finished item or a position sitting in the end
 * credits both start over rather than resuming.
 */
export function resumeStartSeconds(
  {
    positionTicks,
    played,
  }: { positionTicks?: number; played?: boolean },
  { restart, durationSec }: { restart?: boolean; durationSec?: number },
): number {
  if (restart || played) {
    return 0;
  }
  const seconds = (positionTicks ?? 0) / TICKS_PER_SECOND;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  const nearEnd =
    durationSec !== undefined &&
    Number.isFinite(durationSec) &&
    seconds >= durationSec - RESUME_END_MARGIN_SECONDS;
  return nearEnd ? 0 : seconds;
}

export function upNextTriggerSeconds({
  durationSec,
  outro,
}: {
  durationSec?: number;
  outro?: PlaybackSegment;
}): number | undefined {
  const hasDuration =
    durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0;
  const tail = hasDuration ? Math.max(0, durationSec - UP_NEXT_LEAD_SECONDS) : undefined;
  const marker =
    outro !== undefined && Number.isFinite(outro.startSec)
      ? Math.max(0, outro.startSec)
      : undefined;
  if (tail === undefined) {
    return marker;
  }
  if (marker === undefined) {
    return tail;
  }
  return Math.min(marker, tail);
}

/**
 * `7:12` or `1:02:03` — plain wall-clock formatting for anything that shows a
 * position inside a file.
 */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }
  const total = Math.floor(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

/** Whole minutes for the metadata line, rounded up the way Jellyfin reports. */
export function playbackMinutes(runtimeTicks: number | undefined): number | undefined {
  if (runtimeTicks === undefined || !Number.isFinite(runtimeTicks) || runtimeTicks <= 0) {
    return undefined;
  }
  return Math.max(1, Math.round(runtimeTicks / (60 * TICKS_PER_SECOND)));
}

/** `S1 · E2`, split so the metadata line can keep its own separators. */
export function episodeCode(
  seasonNumber: number | undefined,
  episodeNumber: number | undefined,
): string | undefined {
  if (seasonNumber === undefined || episodeNumber === undefined) {
    return undefined;
  }
  return `S${seasonNumber} · E${episodeNumber}`;
}

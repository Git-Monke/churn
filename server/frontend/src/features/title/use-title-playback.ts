import { useQuery } from "@tanstack/react-query";

import { fetchPlayback } from "@/api/client";
import { readPlaybackQuality } from "@/lib/playback-preferences";

const TICKS_PER_SECOND = 10_000_000;
/** Matches the player: anything this close to the end starts from the top. */
const RESUME_END_MARGIN_SECONDS = 30;

export interface TitlePlayback {
  /** A saved position the player will resume from. */
  resumable: boolean;
  /** Whole minutes left from the resume position. */
  remainingMinutes: number | undefined;
}

/**
 * The title's own playback state, read from the same endpoint and query key the
 * player uses — so opening a movie page also warms the player's cache.
 */
export function useTitlePlayback(itemId: string | undefined): TitlePlayback {
  const quality = readPlaybackQuality();
  const query = useQuery({
    queryKey: ["playback", itemId, quality],
    queryFn: () => fetchPlayback(itemId as string, quality),
    enabled: itemId !== undefined,
    retry: false,
    staleTime: 30_000,
  });

  const item = query.data?.item;
  if (!item || item.played === true) {
    return { resumable: false, remainingMinutes: undefined };
  }
  const positionSeconds = (item.positionTicks ?? 0) / TICKS_PER_SECOND;
  const runtimeSeconds = (item.runtimeTicks ?? 0) / TICKS_PER_SECOND;
  const resumable =
    positionSeconds > 0 &&
    (runtimeSeconds === 0 || positionSeconds < runtimeSeconds - RESUME_END_MARGIN_SECONDS);
  if (!resumable) {
    return { resumable: false, remainingMinutes: undefined };
  }
  const remainingSeconds =
    runtimeSeconds > 0 ? runtimeSeconds - positionSeconds : undefined;
  return {
    resumable: true,
    remainingMinutes:
      remainingSeconds === undefined ? undefined : Math.max(1, Math.ceil(remainingSeconds / 60)),
  };
}

/** `9 min left` / `less than a minute left`. */
export function resumeDetail(minutes: number | undefined): string | undefined {
  if (minutes === undefined) {
    return undefined;
  }
  return `${minutes} min left`;
}

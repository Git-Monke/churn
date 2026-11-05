import type { PlaybackSegment } from "@/api/types";

/** True while `timeSec` is inside the half-open segment range. */
export function isInsideSegment(
  segment: PlaybackSegment | undefined,
  timeSec: number,
): boolean {
  return (
    segment !== undefined &&
    Number.isFinite(timeSec) &&
    timeSec >= segment.startSec &&
    timeSec < segment.endSec
  );
}

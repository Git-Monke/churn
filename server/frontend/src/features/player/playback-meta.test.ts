import { describe, expect, it } from "vitest";

import {
  episodeCode,
  formatClock,
  playbackMinutes,
  resumeStartSeconds,
  TICKS_PER_SECOND,
  upNextTriggerSeconds,
} from "@/features/player/playback-meta";

const RUNTIME_TICKS = 22 * 60 * TICKS_PER_SECOND;

describe("up next trigger", () => {
  it("uses the credits marker when it comes before the last 20 seconds", () => {
    expect(
      upNextTriggerSeconds({ durationSec: 1200, outro: { startSec: 1150, endSec: 1200 } }),
    ).toBe(1150);
  });

  it("uses the last 20 seconds when there is no marker or the marker is later", () => {
    expect(upNextTriggerSeconds({ durationSec: 1200 })).toBe(1180);
    expect(
      upNextTriggerSeconds({ durationSec: 1200, outro: { startSec: 1195, endSec: 1200 } }),
    ).toBe(1180);
  });

  it("honours a marker on its own and clamps short files at zero", () => {
    expect(upNextTriggerSeconds({ outro: { startSec: 45, endSec: 60 } })).toBe(45);
    expect(upNextTriggerSeconds({ durationSec: 8 })).toBe(0);
    expect(upNextTriggerSeconds({})).toBeUndefined();
  });
});

describe("resume start position", () => {
  const item = { positionTicks: 120 * TICKS_PER_SECOND, played: false };

  it("resumes a part-watched item when nothing asks for a restart", () => {
    expect(resumeStartSeconds(item, { durationSec: 1200 })).toBe(120);
    expect(resumeStartSeconds(item, {})).toBe(120);
  });

  it("starts at the beginning when autoplay restarts the item", () => {
    expect(resumeStartSeconds(item, { restart: true, durationSec: 1200 })).toBe(0);
  });

  it("never resumes a played item or one without progress", () => {
    expect(resumeStartSeconds({ ...item, played: true }, {})).toBe(0);
    expect(resumeStartSeconds({ positionTicks: 0 }, {})).toBe(0);
    expect(resumeStartSeconds({}, {})).toBe(0);
  });

  it("ignores a position sitting in the end credits", () => {
    expect(
      resumeStartSeconds({ positionTicks: 1180 * TICKS_PER_SECOND }, { durationSec: 1200 }),
    ).toBe(0);
  });
});

describe("player formatting", () => {
  it("formats clock positions", () => {
    expect(formatClock(432)).toBe("7:12");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  it("rounds runtimes to whole minutes", () => {
    expect(playbackMinutes(22 * 60 * TICKS_PER_SECOND)).toBe(22);
    expect(playbackMinutes(Number(21.6 * 60) * TICKS_PER_SECOND)).toBe(22);
    expect(playbackMinutes(undefined)).toBeUndefined();
    expect(playbackMinutes(0)).toBeUndefined();
  });

  it("builds an episode code only when both indices exist", () => {
    expect(episodeCode(1, 2)).toBe("S1 · E2");
    expect(episodeCode(undefined, 2)).toBeUndefined();
    expect(episodeCode(1, undefined)).toBeUndefined();
  });
});

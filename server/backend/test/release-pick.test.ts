import { describe, expect, it } from "vitest";

import {
  DEFAULT_MIN_SEEDERS,
  isQualityOnlyRejection,
  pickRelease,
  qualityTierFromName,
  releasePickDetail,
  type ReleaseCandidate,
} from "../src/release-pick.js";

interface FakeRelease {
  title: string;
  protocol?: string;
  seeders?: number;
}

function candidate(
  title: string,
  overrides: Partial<ReleaseCandidate<FakeRelease>> = {},
): ReleaseCandidate<FakeRelease> {
  return {
    release: { title, protocol: "torrent", seeders: overrides.seeders ?? 20 },
    approved: true,
    grabAllowed: true,
    overrideAllowed: true,
    tier: title.includes("2160")
      ? 3
      : title.includes("1080")
        ? 2
        : title.includes("720")
          ? 1
          : undefined,
    seeders: 20,
    torrent: true,
    sizeBytes: 1_000_000_000,
    ...overrides,
  };
}

describe("release picking", () => {
  it("parses quality tiers from profile and release names", () => {
    expect(qualityTierFromName("HD - 720p/1080p")).toBe(1);
    expect(qualityTierFromName("HD-1080p")).toBe(2);
    expect(qualityTierFromName("Ultra-HD")).toBe(3);
    expect(qualityTierFromName("SD")).toBe(0);
    expect(qualityTierFromName("Any")).toBeUndefined();
  });

  it("keeps the preferred 720p tier when it has enough seeders", () => {
    const pick = pickRelease(
      [
        candidate("Movie.720p", { seeders: 30, sizeBytes: 800_000_000 }),
        candidate("Movie.1080p", { seeders: 400, sizeBytes: 3_000_000_000 }),
      ],
      { preferredTier: 1 },
    );

    expect(pick).toMatchObject({
      release: { title: "Movie.720p" },
      reason: "preferred",
      requiresOverride: false,
    });
  });

  it("upgrades to 1080p when the 720p release is dead", () => {
    const pick = pickRelease(
      [
        candidate("Movie.720p", { seeders: 1, sizeBytes: 800_000_000 }),
        candidate("Movie.1080p", { seeders: 84, sizeBytes: 3_000_000_000 }),
      ],
      { preferredTier: 1, minSeeders: 5 },
    );

    expect(pick).toMatchObject({
      release: { title: "Movie.1080p" },
      reason: "tier_upgrade",
      requiresOverride: false,
    });
  });

  it("overrides a 720p-only profile to grab a well-seeded 1080p release", () => {
    const pick = pickRelease(
      [
        candidate("Movie.720p", { seeders: 1, approved: true }),
        candidate("Movie.1080p", {
          seeders: 84,
          approved: false,
          overrideAllowed: true,
        }),
      ],
      { preferredTier: 1, minSeeders: DEFAULT_MIN_SEEDERS },
    );

    expect(pick).toMatchObject({
      release: { title: "Movie.1080p" },
      reason: "tier_upgrade",
      requiresOverride: true,
    });
  });

  it("never climbs more than one tier or beyond the gate", () => {
    const pick = pickRelease(
      [
        candidate("Movie.720p", { seeders: 1 }),
        candidate("Movie.2160p", { seeders: 500 }),
      ],
      { preferredTier: 1 },
    );

    expect(pick).toMatchObject({
      release: { title: "Movie.720p" },
      reason: "below_threshold",
    });
  });

  it("treats usenet releases as always usable", () => {
    const pick = pickRelease(
      [
        candidate("Movie.720p", { torrent: true, seeders: 0 }),
        candidate("Movie.720p.WEBDL", {
          release: { title: "Movie.720p.WEBDL", protocol: "usenet", seeders: undefined },
          torrent: false,
          seeders: undefined,
        }),
      ],
      { preferredTier: 1 },
    );

    expect(pick).toMatchObject({
      release: { title: "Movie.720p.WEBDL" },
      reason: "preferred",
    });
  });

  it("does not override rejections that are not about quality", () => {
    const pick = pickRelease(
      [
        candidate("Movie.720p", { seeders: 1 }),
        candidate("Movie.1080p", {
          seeders: 300,
          approved: false,
          overrideAllowed: false,
        }),
      ],
      { preferredTier: 1 },
    );

    expect(pick).toMatchObject({
      release: { title: "Movie.720p" },
      reason: "below_threshold",
      requiresOverride: false,
    });
  });

  it("only treats quality rejections as safe to override", () => {
    expect(
      isQualityOnlyRejection({
        rejections: ["Quality Bluray-1080p is not wanted in profile"],
      }),
    ).toBe(true);
    expect(
      isQualityOnlyRejection({
        rejections: ["Quality Bluray-1080p is not wanted in profile", "Language is not wanted in profile"],
      }),
    ).toBe(false);
    expect(isQualityOnlyRejection({ rejections: [] })).toBe(false);
  });

  it("explains picks for the UI", () => {
    const pick = pickRelease(
      [
        candidate("Movie.720p", { seeders: 1 }),
        candidate("Movie.1080p", { seeders: 84, approved: false, overrideAllowed: true }),
      ],
      { preferredTier: 1 },
    );

    expect(pick && releasePickDetail(pick)).toBe("quality tier upgraded for 84 seeders");
  });
});

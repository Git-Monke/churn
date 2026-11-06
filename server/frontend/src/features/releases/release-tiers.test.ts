import { describe, expect, it } from "vitest";

import { defaultTier, RELEASE_TIER_META, tierMeta } from "./release-tiers";

function groups(...tiers: number[]) {
  return tiers.map((tier) => ({ tier }));
}

describe("release tier metadata", () => {
  it("maps tiers to the labels the picker shows", () => {
    expect(tierMeta(0)).toEqual({ tier: 0, name: "Standard", hint: "480p · smallest" });
    expect(tierMeta(1)).toEqual({ tier: 1, name: "HD", hint: "720p" });
    expect(tierMeta(2)).toEqual({
      tier: 2,
      name: "Full HD",
      hint: "1080p · recommended",
    });
    expect(tierMeta(3)).toEqual({ tier: 3, name: "4K", hint: "2160p · largest" });
    expect(tierMeta(99)).toEqual({ tier: 99, name: "Other", hint: "Unknown quality" });
  });

  it("falls back to Other for unknown tiers", () => {
    expect(tierMeta(7).name).toBe("Other");
    expect(RELEASE_TIER_META).toHaveLength(5);
  });
});

describe("default tier selection", () => {
  it("prefers 1080p when it has results", () => {
    expect(defaultTier(groups(0, 1, 2, 3))).toBe(2);
  });

  it("walks the preference order when 1080p is missing", () => {
    expect(defaultTier(groups(0, 1, 3))).toBe(1);
    expect(defaultTier(groups(0, 3))).toBe(3);
    expect(defaultTier(groups(0, 99))).toBe(0);
    expect(defaultTier(groups(99))).toBe(99);
  });

  it("handles empty results", () => {
    expect(defaultTier([])).toBeNull();
  });

  it("keeps an unexpected tier usable", () => {
    expect(defaultTier(groups(7))).toBe(7);
  });

  it("ignores the order groups arrive in", () => {
    expect(defaultTier(groups(3, 0, 1))).toBe(1);
    expect(defaultTier(groups(99, 1))).toBe(1);
  });
});

import type { ReleaseGroup } from "@/api/types";

export interface ReleaseTierMeta {
  tier: number;
  /** Short name shown on the tier button. */
  name: string;
  /** `1080p · recommended` style hint under the name. */
  hint: string;
}

/**
 * Quality tiers the backend groups releases into: 0 = 480p, 1 = 720p,
 * 2 = 1080p, 3 = 2160p and 99 = unknown quality (`Other`).
 */
export const RELEASE_TIER_META: readonly ReleaseTierMeta[] = [
  { tier: 0, name: "Standard", hint: "480p · smallest" },
  { tier: 1, name: "HD", hint: "720p" },
  { tier: 2, name: "Full HD", hint: "1080p · recommended" },
  { tier: 3, name: "4K", hint: "2160p · largest" },
  { tier: 99, name: "Other", hint: "Unknown quality" },
];

const OTHER_TIER = 99;

/**
 * Tiers we auto-select, best first: 1080p, then 720p, then 4K, then 480p, and
 * `Other` only when nothing better exists.
 */
export const DEFAULT_TIER_ORDER: readonly number[] = [2, 1, 3, 0, OTHER_TIER];

export function tierMeta(tier: number): ReleaseTierMeta {
  return (
    RELEASE_TIER_META.find((meta) => meta.tier === tier) ?? {
      tier,
      name: "Other",
      hint: "Unknown quality",
    }
  );
}

/**
 * The tier to select when nobody has picked one yet. Empty tiers are already
 * absent from `groups`, so this only picks among tiers with results.
 */
export function defaultTier(groups: ReadonlyArray<Pick<ReleaseGroup, "tier">>): number | null {
  if (groups.length === 0) {
    return null;
  }
  const available = new Set(groups.map((group) => group.tier));
  for (const tier of DEFAULT_TIER_ORDER) {
    if (available.has(tier)) {
      return tier;
    }
  }
  // A tier the backend added later: keep it usable rather than guessing.
  return groups[0]?.tier ?? null;
}

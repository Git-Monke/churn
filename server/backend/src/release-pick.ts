import type { ServarrRelease } from "./upstream/servarr.js";

/**
 * A torrent with fewer seeders than this is treated as effectively dead. The
 * picker will skip a quality tier that only has dead releases and fall back to
 * the next tier up (for example a 1080p release with 80 seeders instead of a
 * 720p release with 1).
 */
export const DEFAULT_MIN_SEEDERS = 5;

export type ReleasePickReason =
  /** Preferred quality tier, seeders cleared the gate. */
  | "preferred"
  /** An acceptable quality tier above the preferred one, because the preferred tier was dead. */
  | "tier_upgrade"
  /** Nothing cleared the gate; this is the least-bad release in the preferred tier. */
  | "below_threshold"
  /** No tier matched the profile; fall back to the best grab-able release. */
  | "best_effort";

export interface ReleasePickPolicy {
  /** Resolution tier derived from the requested quality profile name. */
  preferredTier?: number;
  /** Seeders needed for a torrent to be usable. Defaults to `DEFAULT_MIN_SEEDERS`. */
  minSeeders?: number;
  /** Allow one tier above `preferredTier` when the preferred tier is dead. */
  allowHigherTier?: boolean;
  /** Highest tier the picker may consider. Defaults to `preferredTier + 1`. */
  maxTier?: number;
}

export interface ReleaseCandidate<T> {
  release: T;
  /** The arr considers the release acceptable for the quality profile. */
  approved: boolean;
  /** The arr can be told to download this release (approved, or mappable override). */
  grabAllowed: boolean;
  /** Overriding is safe because the only complaint was the quality tier. */
  overrideAllowed: boolean;
  /** 0 = SD, 1 = 720p, 2 = 1080p, 3 = 2160p/4K. */
  tier?: number;
  seeders?: number;
  torrent: boolean;
  sizeBytes: number;
  ageHours?: number;
}

export interface ReleasePick<T> {
  release: T;
  reason: ReleasePickReason;
  /** Grab with an explicit quality override because the profile rejected it. */
  requiresOverride: boolean;
}

/**
 * Resolve a resolution tier from a quality or release name.
 *
 * Names such as "HD - 720p/1080p" resolve to the smaller tier (720p), because
 * the picker should only climb to the larger tier when the smaller one is dead.
 */
export function qualityTierFromName(name: string | undefined): number | undefined {
  if (!name) {
    return undefined;
  }
  const normalized = name.toLowerCase();
  const tiers: number[] = [];
  if (/(?:^|\W)(?:2160p?|4k|uhd|ultra)(?:\W|$)/.test(normalized)) {
    tiers.push(3);
  }
  if (/(?:^|\W)1080p?(?:\W|$)/.test(normalized)) {
    tiers.push(2);
  }
  if (/(?:^|\W)720p?(?:\W|$)/.test(normalized)) {
    tiers.push(1);
  }
  if (/(?:^|\W)(?:576p?|480p?|sd)(?:\W|$)/.test(normalized)) {
    tiers.push(0);
  }
  // Combined names such as "HD - 720p/1080p" resolve to the smaller tier: the
  // picker only climbs when that tier has no healthy release.
  return tiers.length > 0 ? Math.min(...tiers) : undefined;
}

/** Resolution tier for a release, preferring its parsed quality over the title. */
export function releaseTier(release: Pick<
  ServarrRelease,
  "title" | "quality"
>): number | undefined {
  return (
    qualityTierFromName(release.quality?.quality?.name) ??
    qualityTierFromName(release.title)
  );
}

export function releaseIsTorrent(release: Pick<ServarrRelease, "protocol">): boolean {
  return release.protocol === "torrent";
}

/**
 * True when the release has enough seeders to be worth downloading. Usenet
 * releases have no seeders, so they always clear the gate.
 */
export function releaseClearsSeederGate(
  release: Pick<ServarrRelease, "protocol" | "seeders">,
  minSeeders = DEFAULT_MIN_SEEDERS,
): boolean {
  if (!releaseIsTorrent(release)) {
    return true;
  }
  return (release.seeders ?? 0) >= minSeeders;
}

const QUALITY_REJECTION = /(?:quality|resolution)\b/i;
const UNRELATED_REJECTION =
  /\b(?:language|sample|multi[- ]season|full season|season pack|series|episode|movie|mapped|database|download client|indexer|size|upgrade)\b/i;

/**
 * True when every rejection is about the quality tier. Those are the only
 * rejections the picker may override, so it never bypasses language, mapping or
 * indexer rules just to chase seeders.
 */
export function isQualityOnlyRejection(
  release: Pick<ServarrRelease, "rejections">,
): boolean {
  const rejections = (release.rejections ?? []).filter(
    (reason): reason is string => typeof reason === "string" && reason.trim().length > 0,
  );
  if (rejections.length === 0) {
    return false;
  }
  return rejections.every(
    (reason) => QUALITY_REJECTION.test(reason) && !UNRELATED_REJECTION.test(reason),
  );
}

/** Map a Sonarr release into a picker candidate. */
export function showReleaseCandidate(
  release: ServarrRelease,
  mappedEpisodeCount: number,
): ReleaseCandidate<ServarrRelease> {
  const approved = release.approved === true;
  return {
    release,
    approved,
    grabAllowed: approved || mappedEpisodeCount > 0,
    overrideAllowed:
      approved || (mappedEpisodeCount > 0 && isQualityOnlyRejection(release)),
    tier: releaseTier(release),
    seeders: release.seeders,
    torrent: releaseIsTorrent(release),
    sizeBytes: release.size ?? 0,
    ageHours: release.ageHours,
  };
}

/** Map a Radarr release into a picker candidate. Movies can always be overridden. */
export function movieReleaseCandidate(
  release: ServarrRelease,
): ReleaseCandidate<ServarrRelease> {
  const approved = release.approved === true;
  return {
    release,
    approved,
    grabAllowed: true,
    overrideAllowed: approved || isQualityOnlyRejection(release),
    tier: releaseTier(release),
    seeders: release.seeders,
    torrent: releaseIsTorrent(release),
    sizeBytes: release.size ?? 0,
    ageHours: release.ageHours,
  };
}

/**
 * Choose the release that should be downloaded first.
 *
 * Rules, in order:
 * 1. Approved releases that clear the seeder gate, preferring the requested
 *    quality tier, then one tier up if the requested tier is dead.
 * 2. Quality-only overrides at the requested tier or one tier up that clear the
 *    gate. This is what lets a 720p profile pick a well-seeded 1080p release.
 * 3. The best approved release in the requested tier even if it is below the
 *    gate, so a request still has a target.
 * 4. The best quality-only override even if it is below the gate.
 */
export function pickRelease<T>(
  candidates: ReleaseCandidate<T>[],
  policy: ReleasePickPolicy = {},
): ReleasePick<T> | undefined {
  const minSeeders = policy.minSeeders ?? DEFAULT_MIN_SEEDERS;
  const preferredTier = policy.preferredTier;
  const maxTier =
    policy.maxTier ??
    (preferredTier === undefined ? undefined : preferredTier + 1);
  const allowHigherTier = policy.allowHigherTier !== false;

  const usable = candidates.filter((candidate) => candidate.grabAllowed);
  if (usable.length === 0) {
    return undefined;
  }

  const clears = (candidate: ReleaseCandidate<T>): boolean => {
    if (!candidate.torrent) {
      return true;
    }
    return (candidate.seeders ?? 0) >= minSeeders;
  };
  const inRange = (candidate: ReleaseCandidate<T>): boolean =>
    maxTier === undefined ||
    candidate.tier === undefined ||
    candidate.tier <= maxTier;

  const approved = usable.filter((candidate) => candidate.approved);
  const overrides = usable.filter(
    (candidate) => !candidate.approved && candidate.overrideAllowed,
  );

  // 1. Approved releases that clear the gate.
  const eligibleApproved = approved.filter((candidate) => clears(candidate));
  if (eligibleApproved.length > 0) {
    if (preferredTier === undefined) {
      return {
        release: best(eligibleApproved).release,
        reason: "preferred",
        requiresOverride: false,
      };
    }
    const sameTier = eligibleApproved.filter(
      (candidate) => candidate.tier === preferredTier,
    );
    if (sameTier.length > 0) {
      return {
        release: best(sameTier).release,
        reason: "preferred",
        requiresOverride: false,
      };
    }
    const higher = eligibleApproved.filter(
      (candidate) =>
        candidate.tier !== undefined &&
        candidate.tier > preferredTier &&
        inRange(candidate),
    );
    if (allowHigherTier && higher.length > 0) {
      return {
        release: best(nearestTier(higher, preferredTier)).release,
        reason: "tier_upgrade",
        requiresOverride: false,
      };
    }
    // No eligible release at the preferred tier or the one above it. Fall
    // through so the preferred tier can still win as a best effort instead of
    // jumping two tiers (for example straight to 4K).
  }

  // 2. Quality-only overrides that clear the gate.
  if (allowHigherTier) {
    const eligibleOverrides = overrides.filter(
      (candidate) =>
        clears(candidate) &&
        inRange(candidate) &&
        (preferredTier === undefined ||
          (candidate.tier !== undefined && candidate.tier >= preferredTier)),
    );
    if (eligibleOverrides.length > 0) {
      const pool =
        preferredTier === undefined
          ? eligibleOverrides
          : nearestTier(eligibleOverrides, preferredTier);
      return {
        release: best(pool).release,
        reason: preferredTier === undefined ? "best_effort" : "tier_upgrade",
        requiresOverride: true,
      };
    }
  }

  // 3. Nothing clears the gate; keep the preferred tier as a best effort.
  if (approved.length > 0) {
    const sameTier =
      preferredTier === undefined
        ? approved
        : approved.filter((candidate) => candidate.tier === preferredTier);
    if (sameTier.length > 0) {
      return {
        release: best(sameTier).release,
        reason: "below_threshold",
        requiresOverride: false,
      };
    }
    return {
      release: preferredPool(approved, preferredTier)[0]!.release,
      reason: "best_effort",
      requiresOverride: false,
    };
  }

  // 4. Only overrides are available.
  if (overrides.length > 0) {
    return {
      release: preferredPool(overrides, preferredTier)[0]!.release,
      reason: "below_threshold",
      requiresOverride: true,
    };
  }

  return undefined;
}

/** Human-readable explanation for a pick, used in toasts and release lists. */
export function releasePickDetail(pick: ReleasePick<ServarrRelease>): string {
  const seeders = pick.release.seeders;
  const seederText =
    pick.release.protocol === "torrent" && seeders !== undefined
      ? `${seeders} seeder${seeders === 1 ? "" : "s"}`
      : undefined;
  switch (pick.reason) {
    case "preferred":
      return seederText ? `preferred quality · ${seederText}` : "preferred quality";
    case "tier_upgrade":
      return seederText
        ? `quality tier upgraded for ${seederText}`
        : "quality tier upgraded for availability";
    case "below_threshold":
      return seederText
        ? `only option · ${seederText}, below the seeder threshold`
        : "only option · no healthy release";
    case "best_effort":
      return seederText ? `best available · ${seederText}` : "best available";
  }
}

function best<T>(candidates: ReleaseCandidate<T>[]): ReleaseCandidate<T> {
  return [...candidates].sort(compareCandidates)[0] as ReleaseCandidate<T>;
}

/** Most seeders first, then smallest file, then newest. */
function compareCandidates<T>(
  left: ReleaseCandidate<T>,
  right: ReleaseCandidate<T>,
): number {
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

function nearestTier<T>(
  candidates: ReleaseCandidate<T>[],
  preferredTier: number,
): ReleaseCandidate<T>[] {
  const tiers = candidates
    .map((candidate) => candidate.tier)
    .filter((tier): tier is number => tier !== undefined && tier > preferredTier);
  if (tiers.length === 0) {
    return candidates;
  }
  const nearest = Math.min(...tiers);
  return candidates.filter((candidate) => candidate.tier === nearest);
}

/** Sort by closeness to the preferred tier, then leave the winner to `best`. */
function preferredPool<T>(
  candidates: ReleaseCandidate<T>[],
  preferredTier: number | undefined,
): ReleaseCandidate<T>[] {
  const sorted = [...candidates].sort((left, right) => {
    return tierDistance(left, preferredTier) - tierDistance(right, preferredTier);
  });
  const closest = sorted[0];
  if (!closest) {
    return sorted;
  }
  return sorted.filter(
    (candidate) => tierDistance(candidate, preferredTier) === tierDistance(closest, preferredTier),
  ).sort(compareCandidates);
}

function tierDistance<T>(
  candidate: ReleaseCandidate<T>,
  preferredTier: number | undefined,
): number {
  if (preferredTier === undefined) {
    return 0;
  }
  if (candidate.tier === undefined) {
    return 2;
  }
  return candidate.tier === preferredTier ? 0 : candidate.tier > preferredTier ? 1 : 3;
}

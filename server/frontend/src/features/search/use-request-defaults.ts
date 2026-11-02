import { useCallback, useEffect, useState } from "react";

import type {
  ArrQualityProfile,
  ArrRequestOptions,
  RequestMonitor,
  RequestOptionsResponse,
} from "@/api/types";

export interface ServiceRequestDefaults {
  qualityProfileId?: number;
  rootFolderPath?: string;
  monitor?: RequestMonitor;
  searchOnAdd: boolean;
  /** Prefer a 720p-only quality profile over larger ones when auto-picking. */
  preferSmaller: boolean;
}

export interface RequestDefaults {
  sonarr: ServiceRequestDefaults;
  radarr: ServiceRequestDefaults;
}

const STORAGE_KEY = "churn.requestDefaults.v3";
const DEFAULT_STATE: RequestDefaults = {
  sonarr: { monitor: "all", searchOnAdd: true, preferSmaller: true },
  radarr: { searchOnAdd: true, preferSmaller: true },
};

export function useRequestDefaults(options?: RequestOptionsResponse) {
  const [defaults, setDefaults] = useState<RequestDefaults>(() =>
    mergeStoredDefaults(DEFAULT_STATE, readStoredDefaults()),
  );

  useEffect(() => {
    if (!options) {
      return;
    }
    setDefaults((current) => resolveDefaults(current, options));
  }, [options]);

  const update = useCallback(
    (service: "sonarr" | "radarr", patch: Partial<ServiceRequestDefaults>) => {
      setDefaults((current) => {
        const next: RequestDefaults = {
          ...current,
          [service]: { ...current[service], ...patch },
        };
        writeStoredDefaults(next);
        return next;
      });
    },
    [],
  );

  return { defaults, update };
}

function resolveDefaults(
  current: RequestDefaults,
  options: RequestOptionsResponse,
): RequestDefaults {
  return {
    sonarr: resolveServiceDefaults(current.sonarr, options.services.sonarr),
    radarr: resolveServiceDefaults(current.radarr, options.services.radarr),
  };
}

function resolveServiceDefaults(
  current: ServiceRequestDefaults,
  options: ArrRequestOptions,
): ServiceRequestDefaults {
  const profileExists = options.qualityProfiles.some(
    (profile) => profile.id === current.qualityProfileId,
  );
  const folderExists = options.rootFolders.some(
    (folder) => folder.path === current.rootFolderPath && folder.accessible,
  );
  const preferSmaller = current.preferSmaller ?? true;
  const preferredProfileId = preferSmaller
    ? (pickSmallerQualityProfile(options.qualityProfiles)?.id ??
      options.defaults.qualityProfileId)
    : options.defaults.qualityProfileId;

  return {
    qualityProfileId: profileExists ? current.qualityProfileId : preferredProfileId,
    rootFolderPath: folderExists ? current.rootFolderPath : options.defaults.rootFolderPath,
    monitor:
      options.id === "sonarr"
        ? (current.monitor ?? options.defaults.monitor ?? "all")
        : undefined,
    searchOnAdd:
      typeof current.searchOnAdd === "boolean"
        ? current.searchOnAdd
        : options.defaults.searchOnAdd,
    preferSmaller,
  };
}

/**
 * Prefer the smallest profile that still targets 720p for faster downloads:
 * 720p-only first, then 720p/1080p, then 1080p-only, then other non-4K
 * profiles. Profiles that name 4K/2160p/UHD/Ultra only win when nothing else
 * is available.
 */
export function pickSmallerQualityProfile(
  profiles: ArrQualityProfile[],
): ArrQualityProfile | undefined {
  return profiles
    .map((profile, index) => ({
      profile,
      index,
      score: smallerQualityProfileScore(profile.name),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]
    ?.profile;
}

function smallerQualityProfileScore(name: string): number {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (/(?:^|\W)(?:2160p?|4k|uhd|ultra)(?:\W|$)/.test(normalized)) {
    return -1;
  }
  const has720 = /(?:^|\W)720p?(?:\W|$)/.test(normalized);
  const has1080 = /(?:^|\W)1080p?(?:\W|$)/.test(normalized);
  if (has720 && !has1080) {
    return 4;
  }
  if (has720 && has1080) {
    return 3;
  }
  if (has1080) {
    return 2;
  }
  return 1;
}

function readStoredDefaults(): Partial<RequestDefaults> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? (value as Partial<RequestDefaults>) : {};
  } catch {
    return {};
  }
}

function writeStoredDefaults(defaults: RequestDefaults): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
  } catch {
    // Private browsing or a full quota should not break requesting.
  }
}

function mergeStoredDefaults(
  base: RequestDefaults,
  stored: Partial<RequestDefaults>,
): RequestDefaults {
  return {
    sonarr: { ...base.sonarr, ...stored.sonarr },
    radarr: { ...base.radarr, ...stored.radarr },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { useCallback, useEffect, useState } from "react";

import type { ArrRequestOptions, RequestOptionsResponse } from "@/api/types";

export interface ServiceRequestDefaults {
  qualityProfileId?: number;
  rootFolderPath?: string;
}

export interface RequestDefaults {
  sonarr: ServiceRequestDefaults;
  radarr: ServiceRequestDefaults;
}

const STORAGE_KEY = "churn.requestDefaults.v4";
const DEFAULT_STATE: RequestDefaults = {
  sonarr: {},
  radarr: {},
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

  return {
    qualityProfileId: profileExists
      ? current.qualityProfileId
      : options.defaults.qualityProfileId,
    rootFolderPath: folderExists ? current.rootFolderPath : options.defaults.rootFolderPath,
  };
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

import type {
  ActivityItem,
  LibraryItem,
  MediaAddedBy,
  RequestedLibraryItem,
} from "@/api/types";

export type LibraryEntryStatus =
  | "available"
  | "scanning"
  | "scan_failed"
  | "requested"
  | "downloading"
  | "both";

export interface LibraryEntry {
  key: string;
  type: LibraryItem["type"];
  library?: LibraryItem;
  requested?: RequestedLibraryItem;
  activity?: ActivityItem;
  addedBy?: MediaAddedBy;
  status: LibraryEntryStatus;
}

export function mergeLibraryEntries(
  libraryItems: LibraryItem[],
  requestedItems: RequestedLibraryItem[],
  activityItems: ActivityItem[],
): LibraryEntry[] {
  const entries = new Map<string, LibraryEntry>();

  for (const item of libraryItems) {
    const key = libraryKey(item);
    entries.set(key, {
      key,
      type: item.type,
      library: item,
      addedBy: item.addedBy,
      status: "available",
    });
  }

  for (const requested of requestedItems) {
    const existing =
      entries.get(requested.key) ??
      matchingLibraryEntry(entries.values(), requested);
    const type = requested.kind === "movie" ? "Movie" : "Series";
    if (existing) {
      existing.requested = requested;
      if (!existing.addedBy && requested.addedBy) {
        existing.addedBy = requested.addedBy;
      }
      entryStatus(existing);
      continue;
    }
    const entry: LibraryEntry = {
      key: requested.key,
      type,
      requested,
      addedBy: requested.addedBy,
      status: "requested",
    };
    entryStatus(entry);
    entries.set(requested.key, entry);
  }

  for (const activity of activityItems) {
    const existing =
      entries.get(activity.key) ??
      matchingActivityEntry(entries.values(), activity);
    if (existing) {
      existing.activity = activity;
      entryStatus(existing);
      continue;
    }
    entries.set(activity.key, {
      key: activity.key,
      type: activity.kind === "movie" ? "Movie" : "Series",
      activity,
      status: "downloading",
    });
  }

  return [...entries.values()].sort((left, right) => {
    const leftRank = entryRank(left);
    const rightRank = entryRank(right);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return entryTitle(left).localeCompare(entryTitle(right));
  });
}

function matchingLibraryEntry(
  entries: Iterable<LibraryEntry>,
  requested: RequestedLibraryItem,
): LibraryEntry | undefined {
  const type = requested.kind === "movie" ? "Movie" : "Series";
  const candidates = [...entries].filter(
    (entry) => entry.library && !entry.requested && entry.type === type,
  );

  const providerMatches = candidates.filter((entry) =>
    requested.kind === "movie"
      ? requested.tmdbId !== undefined &&
        entry.library?.tmdbId === requested.tmdbId
      : requested.tvdbId !== undefined &&
        entry.library?.tvdbId === requested.tvdbId,
  );
  if (providerMatches.length === 1) {
    return providerMatches[0];
  }

  const titleMatches = candidates.filter((entry) => {
    if (normalizeTitle(entryTitle(entry)) !== normalizeTitle(requested.title)) {
      return false;
    }
    const libraryYear = entry.library?.year;
    if (libraryYear === undefined || requested.year === undefined) {
      return true;
    }
    return requested.kind === "series"
      ? Math.abs(libraryYear - requested.year) <= 1
      : libraryYear === requested.year;
  });
  return titleMatches.length === 1 ? titleMatches[0] : undefined;
}

function matchingActivityEntry(
  entries: Iterable<LibraryEntry>,
  activity: ActivityItem,
): LibraryEntry | undefined {
  const type = activity.kind === "movie" ? "Movie" : "Series";
  const candidates = [...entries].filter(
    (entry) =>
      !entry.activity && entry.type === type && Boolean(entry.library ?? entry.requested),
  );
  const matches = candidates.filter((entry) =>
    activityTitleMatches(entryTitle(entry), activity),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function activityTitleMatches(title: string, activity: ActivityItem): boolean {
  const titleTokens = tokenize(title);
  const nameTokens = tokenize(activity.title);
  if (
    titleTokens.length === 0 ||
    nameTokens.length < titleTokens.length ||
    !titleTokens.every((token, index) => nameTokens[index] === token)
  ) {
    return false;
  }

  const rest = nameTokens.slice(titleTokens.length);
  if (rest.length === 0) {
    return true;
  }
  if (activity.kind === "series") {
    let index = 0;
    while (
      index < rest.length &&
      (/^(?:19|20)\d{2}$/.test(rest[index] ?? "") ||
        /^(?:us|uk|au|ca)$/.test(rest[index] ?? ""))
    ) {
      index += 1;
    }
    return /^s\d{1,3}(?:e\d{1,3})?$/.test(rest[index] ?? "");
  }

  const next = rest[0] ?? "";
  return (
    /^(?:19|20)\d{2}$/.test(next) ||
    /^(?:2160p?|1080p?|720p?|480p?|bluray|blu-ray|brrip|br|webrip|web|web-dl|webdl|dl|hdtv|dvdrip|dvd|remux|x264|x265|h264|h265|hevc|av1|hdr|sdr|uhd|hd|proper|repack|extended|unrated|imax)$/.test(
      next,
    )
  );
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function entryTitle(entry: LibraryEntry): string {
  return entry.library?.name ?? entry.requested?.title ?? entry.activity?.title ?? "";
}

function entryRank(entry: LibraryEntry): number {
  if (entry.activity) {
    return 0;
  }
  if (entry.library) {
    return 1;
  }
  return 2;
}

function entryStatus(entry: LibraryEntry): void {
  const hasLibrary = Boolean(entry.library);

  // Jellyfin alone makes a title Available/playable. Arr activity/import state
  // is only allowed to explain an active download or a transitional scan.
  if (entry.activity) {
    entry.status = hasLibrary ? "both" : "downloading";
    return;
  }
  if (hasLibrary) {
    entry.status = "available";
    return;
  }
  if (entry.requested?.available) {
    entry.status = "scanning";
    return;
  }
  entry.status = "requested";
}

function libraryKey(item: LibraryItem): string {
  if (item.type === "Movie" && item.tmdbId !== undefined) {
    return `movie:${item.tmdbId}`;
  }
  if (item.type === "Series" && item.tvdbId !== undefined) {
    return `series:${item.tvdbId}`;
  }
  return `jellyfin:${item.id}`;
}

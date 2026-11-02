import type { ActivityItem, LibraryItem, RequestedLibraryItem } from "@/api/types";

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
      status: "available",
    });
  }

  for (const requested of requestedItems) {
    const existing = entries.get(requested.key);
    const type = requested.kind === "movie" ? "Movie" : "Series";
    if (existing) {
      existing.requested = requested;
      entryStatus(existing);
      continue;
    }
    const entry: LibraryEntry = {
      key: requested.key,
      type,
      requested,
      status: "requested",
    };
    entryStatus(entry);
    entries.set(requested.key, entry);
  }

  for (const activity of activityItems) {
    const existing = entries.get(activity.key);
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
  const requestedAvailable = Boolean(entry.requested?.available);

  if (!hasLibrary && requestedAvailable) {
    entry.status = "scanning";
    return;
  }

  const available = hasLibrary || requestedAvailable;
  if (entry.activity) {
    entry.status = available || entry.requested ? "both" : "downloading";
  } else if (available) {
    entry.status = "available";
  } else {
    entry.status = "requested";
  }
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

import type { ActivityItem, LibraryItem } from "@/api/types";

export type LibraryEntryStatus = "available" | "downloading" | "both";

export interface LibraryEntry {
  key: string;
  type: LibraryItem["type"];
  library?: LibraryItem;
  activity?: ActivityItem;
  status: LibraryEntryStatus;
}

export function mergeLibraryEntries(
  libraryItems: LibraryItem[],
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

  for (const activity of activityItems) {
    const existing = entries.get(activity.key);
    if (existing) {
      existing.activity = activity;
      existing.status = "both";
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
    const leftActive = left.activity ? 0 : 1;
    const rightActive = right.activity ? 0 : 1;
    if (leftActive !== rightActive) {
      return leftActive - rightActive;
    }
    return entryTitle(left).localeCompare(entryTitle(right));
  });
}

export function entryTitle(entry: LibraryEntry): string {
  return entry.library?.name ?? entry.activity?.title ?? "";
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

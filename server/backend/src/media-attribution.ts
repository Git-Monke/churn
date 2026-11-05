import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MEDIA_ATTRIBUTION_VERSION = 1;
export const MEDIA_ATTRIBUTION_FILENAME = "media-attribution.json";

/** The Jellyfin user that requested a title through Churn. */
export interface MediaAddedBy {
  /** Jellyfin user id; stable across renames. */
  id: string;
  /** Display name captured when the title was added. */
  name: string;
}

export interface MediaIdentity {
  kind: "movie" | "series";
  tmdbId?: number;
  tvdbId?: number;
}

export interface MediaAttributionEntry {
  key: string;
  addedBy: MediaAddedBy;
  addedAt: string;
}

export interface MediaAttributionStore {
  get(identity: MediaIdentity): MediaAddedBy | undefined;
  record(identity: MediaIdentity, addedBy: MediaAddedBy): Promise<void>;
  remove(identity: MediaIdentity): Promise<void>;
}

export interface MediaAttributionOptions {
  stateDir: string;
  now?: () => Date;
  onWarning?: (message: string) => void;
}

/**
 * Attribution is keyed only by the media's provider identity. Sonarr/Radarr
 * are metadata and release-search sources, not downloaders, so no service or
 * arr id belongs in the tag.
 */
export function mediaAttributionKey(identity: MediaIdentity): string | undefined {
  if (identity.kind === "movie" && validProviderId(identity.tmdbId)) {
    return `movie:tmdb:${identity.tmdbId}`;
  }
  if (identity.kind === "series") {
    if (validProviderId(identity.tvdbId)) {
      return `series:tvdb:${identity.tvdbId}`;
    }
    if (validProviderId(identity.tmdbId)) {
      return `series:tmdb:${identity.tmdbId}`;
    }
  }
  return undefined;
}

export function createMediaAttributionStore(
  options: MediaAttributionOptions,
): MediaAttributionStore {
  const { stateDir } = options;
  const now = options.now ?? (() => new Date());
  const onWarning = options.onWarning ?? (() => {});
  const filePath = path.join(stateDir, MEDIA_ATTRIBUTION_FILENAME);
  const entries = loadEntries(filePath, onWarning);
  let writeChain: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    const snapshot = [...entries.values()];
    const write = writeChain
      .catch(() => {
        // A failed write must not block every later write.
      })
      .then(() =>
        writeJson(filePath, {
          version: MEDIA_ATTRIBUTION_VERSION,
          entries: snapshot,
        }),
      );
    writeChain = write;
    return write;
  }

  return {
    get(identity) {
      const key = mediaAttributionKey(identity);
      return key ? entries.get(key)?.addedBy : undefined;
    },
    async record(identity, addedBy) {
      const key = mediaAttributionKey(identity);
      if (!key) {
        return;
      }
      entries.set(key, {
        key,
        addedBy: { id: addedBy.id, name: addedBy.name },
        addedAt: now().toISOString(),
      });
      await persist().catch((error: unknown) => {
        onWarning(
          `Could not save media attribution: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    async remove(identity) {
      const key = mediaAttributionKey(identity);
      if (!key || !entries.delete(key)) {
        return;
      }
      await persist().catch((error: unknown) => {
        onWarning(
          `Could not save media attribution: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
  };
}

function loadEntries(
  filePath: string,
  onWarning: (message: string) => void,
): Map<string, MediaAttributionEntry> {
  const entries = new Map<string, MediaAttributionEntry>();
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    // The file is created on the first recorded attribution.
    return entries;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    onWarning(`Ignoring corrupt media attribution file at ${filePath}`);
    return entries;
  }

  if (!isRecord(parsed) || parsed.version !== MEDIA_ATTRIBUTION_VERSION) {
    onWarning(`Ignoring unsupported media attribution file at ${filePath}`);
    return entries;
  }
  if (!Array.isArray(parsed.entries)) {
    onWarning(`Ignoring malformed media attribution file at ${filePath}`);
    return entries;
  }

  for (const value of parsed.entries) {
    const entry = parseEntry(value);
    if (entry) {
      entries.set(entry.key, entry);
    }
  }
  return entries;
}

function parseEntry(value: unknown): MediaAttributionEntry | undefined {
  if (!isRecord(value) || typeof value.key !== "string") {
    return undefined;
  }
  if (!isRecord(value.addedBy)) {
    return undefined;
  }
  const { id, name } = value.addedBy;
  if (typeof id !== "string" || !id || typeof name !== "string" || !name) {
    return undefined;
  }
  if (typeof value.addedAt !== "string") {
    return undefined;
  }
  return {
    key: value.key,
    addedBy: { id, name },
    addedAt: value.addedAt,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

function validProviderId(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

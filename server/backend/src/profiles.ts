import type { ProfileRecord, SessionStore } from "./auth.js";
import type { ServiceConfig } from "./config.js";
import { createJellyfinClient } from "./upstream/jellyfin.js";

export interface ProfileSyncOptions {
  timeoutMs: number;
  onWarning?: (message: string) => void;
  onInfo?: (message: string) => void;
}

export interface ProfileSyncResult {
  imported: ProfileRecord[];
  skipped: number;
  /** Present when Jellyfin could not be read; startup retries while it is set. */
  error?: string;
}

/**
 * Copy Jellyfin users that churn does not know about into the profile store.
 *
 * Jellyfin owns the accounts; churn's store is a mirror. An account created
 * outside churn (`/Users/New` by hand, or a script) or one orphaned by a lost
 * `auth-state.json` becomes a churn profile again, so the login picker and the
 * People page agree with Jellyfin and a duplicate add is caught locally instead
 * of failing upstream with a masked 400.
 *
 * Imported profiles get `initialPin: null`, which the store reads as "password
 * set": the person signs in with the Jellyfin password they already have.
 *
 * Never throws. Failures are reported through `onWarning` / `error`.
 */
export async function syncProfiles(
  store: SessionStore,
  service: ServiceConfig,
  options: ProfileSyncOptions,
): Promise<ProfileSyncResult> {
  if (!service.apiKey) {
    options.onWarning?.("churn: JELLYFIN_API_KEY is not configured; skipping the profile sync");
    return { imported: [], skipped: 0 };
  }

  let users;
  try {
    users = await createJellyfinClient(service, options.timeoutMs).listUsers();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.onWarning?.(`churn: profile sync could not read Jellyfin users: ${reason}`);
    return { imported: [], skipped: 0, error: reason };
  }

  const existing = store.listProfiles();
  const knownIds = new Set(existing.map((profile) => profile.jellyfinUserId));
  const knownNames = new Set(existing.map((profile) => profile.name.trim().toLowerCase()));
  const imported: ProfileRecord[] = [];
  let skipped = 0;

  for (const user of users) {
    const jellyfinUserId = user.Id?.trim();
    const name = user.Name?.trim();
    if (!jellyfinUserId || !name) {
      skipped += 1;
      continue;
    }
    // `IsHidden` only hides an account from Jellyfin's own login screen, which
    // churn never shows, and Jellyfin 10.11 reports it set for ordinary users:
    // skipping those would make this sync a no-op.
    if (user.Policy?.IsAdministrator || user.Policy?.IsDisabled || user.HasPassword === false) {
      skipped += 1;
      continue;
    }
    if (knownIds.has(jellyfinUserId)) {
      skipped += 1;
      continue;
    }
    const normalized = name.trim().toLowerCase();
    if (knownNames.has(normalized)) {
      // Two Jellyfin accounts with one name cannot both be shown as people.
      options.onWarning?.(
        `churn: Jellyfin user "${name}" shares a name with an existing churn profile but has a different id; not importing it`,
      );
      skipped += 1;
      continue;
    }

    imported.push(store.createProfile({ name, jellyfinUserId, initialPin: null }));
    knownIds.add(jellyfinUserId);
    knownNames.add(normalized);
  }

  if (imported.length > 0) {
    options.onInfo?.(`churn: imported ${imported.length} Jellyfin user(s) into the profile store`);
  }
  return { imported, skipped };
}

/** Cold boots start Jellyfin and the dashboard together, so retry past that race. */
const STARTUP_SYNC_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];


/**
 * Sync once at startup, retrying while Jellyfin is still starting. Never
 * blocks the caller's startup path and never fails it: a stack that cannot
 * reach Jellyfin yet still serves, and the sync lands as soon as it answers.
 */
export async function syncProfilesAtStartup(
  store: SessionStore,
  service: ServiceConfig,
  options: ProfileSyncOptions & { retryDelaysMs?: number[] },
): Promise<ProfileSyncResult> {
  const delays = options.retryDelaysMs ?? STARTUP_SYNC_RETRY_DELAYS_MS;
  let result = await syncProfiles(store, service, options);
  for (const delay of delays) {
    if (result.error === undefined) {
      return result;
    }
    const retry = Promise.withResolvers<void>();
    setTimeout(retry.resolve, delay);
    await retry.promise;
    result = await syncProfiles(store, service, options);
  }
  if (result.error !== undefined) {
    options.onWarning?.(
      `churn: giving up on the profile sync for now; Jellyfin users stay unavailable until the next restart`,
    );
  }
  return result;
}

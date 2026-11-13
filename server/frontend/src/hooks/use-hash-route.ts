import { useEffect, useState } from "react";

export type ShowSource = "jellyfin" | "sonarr";
export type MovieSource = "jellyfin" | "radarr";

/** Where playback was started from, so the player can return there. */
export interface ShowReturnContext {
  source: ShowSource;
  id: string;
  season?: number;
}

export type AppRoute =
  | { page: "services" }
  | { page: "library" }
  | { page: "show"; source: ShowSource; id: string; season?: number }
  | { page: "movie"; source: MovieSource; id: string }
  | { page: "play"; id: string; from?: ShowReturnContext; restart?: boolean }
  | { page: "search" }
  | { page: "people" };

export function useHashRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

/** Replace the current hash without adding a history entry. */
export function replaceHash(hash: string): void {
  if (window.location.hash === hash) {
    return;
  }
  window.history.replaceState(null, "", hash);
  // `replaceState` does not emit `hashchange`; notify the router ourselves.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Hash for a show page, optionally pinned to one season. */
export function showHash(source: ShowSource, id: string, season?: number): string {
  const base = `#/library/show/${source}/${encodeURIComponent(id)}`;
  return season === undefined ? base : `${base}/season/${season}`;
}

/**
 * Hash for the player. `from` carries the show/season context so the player's
 * back link can return to the season the episode belongs to. `restart` asks the
 * player to start at 0:00 instead of the item's saved position, which is what
 * autoplay does when it advances to the next episode.
 */
export function playHash(
  itemId: string,
  from?: ShowReturnContext,
  restart?: boolean,
): string {
  const base = `#/play/${encodeURIComponent(itemId)}`;
  const params = new URLSearchParams();
  if (from) {
    params.set("source", from.source);
    params.set("show", from.id);
    if (from.season !== undefined) {
      params.set("season", String(from.season));
    }
  }
  if (restart) {
    params.set("restart", "1");
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * The same hash with the one-shot `restart` parameter removed, keeping every
 * other parameter. Autoplay asks the next episode to start at 0:00 once; if the
 * instruction stayed in the URL the browser would keep re-running it, so
 * returning to the player later restarted an episode the viewer had already
 * started watching.
 */
export function stripRestartParam(hash: string): string {
  const [path = "", search] = hash.split("?");
  if (search === undefined) {
    return hash;
  }
  const params = new URLSearchParams(search);
  if (!params.has("restart")) {
    return hash;
  }
  params.delete("restart");
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function parseHash(hash: string): AppRoute {
  const [path, search = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = (path ?? "").split("/").filter(Boolean);
  const query = new URLSearchParams(search);

  if (parts.length === 0) {
    return { page: "library" };
  }
  if (parts.length === 1 && parts[0] === "services") {
    return { page: "services" };
  }
  if (parts.length === 1 && parts[0] === "library") {
    return { page: "library" };
  }
  if (parts.length === 1 && parts[0] === "search") {
    return { page: "search" };
  }
  if (parts.length === 1 && parts[0] === "people") {
    return { page: "people" };
  }
  if (parts.length === 2 && parts[0] === "play" && parts[1]) {
    const from = parseReturnContext(query);
    const restart = query.get("restart") === "1";
    const id = decodeURIComponent(parts[1]);
    return {
      page: "play",
      id,
      ...(from ? { from } : {}),
      ...(restart ? { restart } : {}),
    };
  }
  if (
    (parts.length === 4 || parts.length === 6) &&
    parts[0] === "library" &&
    parts[1] === "show" &&
    (parts[2] === "jellyfin" || parts[2] === "sonarr") &&
    parts[3]
  ) {
    const season = parts.length === 6 && parts[4] === "season" ? parseSeason(parts[5]) : undefined;
    return {
      page: "show",
      source: parts[2],
      id: decodeURIComponent(parts[3]),
      ...(season === undefined ? {} : { season }),
    };
  }
  if (
    parts.length === 4 &&
    parts[0] === "library" &&
    parts[1] === "movie" &&
    (parts[2] === "jellyfin" || parts[2] === "radarr") &&
    parts[3]
  ) {
    return {
      page: "movie",
      source: parts[2],
      id: decodeURIComponent(parts[3]),
    };
  }
  return { page: "library" };
}

function parseReturnContext(query: URLSearchParams): ShowReturnContext | undefined {
  const source = query.get("source");
  const id = query.get("show");
  if ((source !== "jellyfin" && source !== "sonarr") || !id) {
    return undefined;
  }
  const season = parseSeason(query.get("season"));
  return {
    source,
    id,
    ...(season === undefined ? {} : { season }),
  };
}

function parseSeason(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const season = Number(value);
  return Number.isInteger(season) && season >= 0 ? season : undefined;
}

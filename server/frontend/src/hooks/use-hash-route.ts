import { useEffect, useState } from "react";

export type ShowSource = "jellyfin" | "sonarr";

export type AppRoute =
  | { page: "services" }
  | { page: "library" }
  | { page: "show"; source: ShowSource; id: string }
  | { page: "search" };

export function useHashRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

export function parseHash(hash: string): AppRoute {
  const path = hash.replace(/^#\/?/, "");
  const parts = path.split("/").filter(Boolean);

  if (parts.length === 0) {
    return { page: "services" };
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
  if (
    parts.length === 4 &&
    parts[0] === "library" &&
    parts[1] === "show" &&
    (parts[2] === "jellyfin" || parts[2] === "sonarr") &&
    parts[3]
  ) {
    return {
      page: "show",
      source: parts[2],
      id: decodeURIComponent(parts[3]),
    };
  }
  return { page: "services" };
}

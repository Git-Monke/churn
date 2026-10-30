export type ServiceId = "jellyfin" | "sonarr" | "radarr";
export type ServiceState = "ok" | "unconfigured" | "unauthorized" | "unreachable";

export interface ServiceStatus {
  id: ServiceId;
  name: string;
  url: string;
  state: ServiceState;
  version?: string;
  detail?: string;
  latencyMs?: number;
}

export interface StatusResponse {
  checkedAt: string;
  services: ServiceStatus[];
}

export type LibraryState =
  | "ok"
  | "setup_required"
  | "unconfigured"
  | "unauthorized"
  | "unreachable";

export interface LibraryItem {
  id: string;
  name: string;
  type: "Movie" | "Series";
  year?: number;
  overview?: string;
  rating?: number;
  officialRating?: string;
  runtimeMinutes?: number;
  imageUrl?: string;
}

export interface LibraryResponse {
  source: "jellyfin";
  state: LibraryState;
  items: LibraryItem[];
  total: number;
  detail?: string;
}

import type { ServiceId } from "./config.js";

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

export type LibraryState = "ok" | "setup_required" | "unconfigured" | "unauthorized" | "unreachable";

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
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}

export interface LibraryResponse {
  source: "jellyfin";
  state: LibraryState;
  items: LibraryItem[];
  total: number;
  detail?: string;
}

export type RequestKind = "movie" | "series";
export type RequestMonitor = "all" | "firstSeason" | "future" | "none";
export type ArrServiceState = "ok" | "unconfigured" | "unauthorized" | "unreachable";

export interface SearchResult {
  key: string;
  kind: RequestKind;
  service: "sonarr" | "radarr";
  title: string;
  year?: number;
  overview?: string;
  rating?: number;
  certification?: string;
  runtimeMinutes?: number;
  genres?: string[];
  network?: string;
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
  imageUrl?: string;
  inLibrary: boolean | null;
  seasons?: Array<{ seasonNumber: number; monitored: boolean }>;
}

export interface SearchServiceState {
  id: "sonarr" | "radarr";
  state: ArrServiceState;
  detail?: string;
  count: number;
}

export interface SearchResponse {
  query: string;
  searchedAt: string;
  results: SearchResult[];
  services: SearchServiceState[];
}

export type ActivityStatus = "queued" | "downloading" | "importing" | "warning";

export interface ActivityItem {
  key: string;
  service: "sonarr" | "radarr";
  kind: RequestKind;
  title: string;
  year?: number;
  overview?: string;
  network?: string;
  rating?: number;
  runtimeMinutes?: number;
  imageUrl?: string;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  movieId?: number;
  seriesId?: number;
  seasons?: number[];
  queueCount: number;
  status: ActivityStatus;
  progress: number;
  sizeBytes?: number;
  sizeLeftBytes?: number;
  timeLeft?: string;
  estimatedCompletionTime?: string;
  downloadClients: string[];
  protocols: Array<"torrent" | "usenet">;
  quality?: string;
  statusMessages?: string[];
}

export interface ActivityServiceState {
  id: "sonarr" | "radarr";
  state: ArrServiceState;
  detail?: string;
  count: number;
}

export interface ActivityResponse {
  checkedAt: string;
  services: ActivityServiceState[];
  items: ActivityItem[];
  total: number;
  detail?: string;
}

export interface ArrQualityProfile {
  id: number;
  name: string;
}

export interface ArrRootFolder {
  path: string;
  accessible: boolean;
  freeSpace?: number;
}

export interface ArrRequestDefaults {
  qualityProfileId?: number;
  rootFolderPath?: string;
  monitor?: RequestMonitor;
  searchOnAdd: boolean;
}

export interface ArrRequestOptions {
  id: "sonarr" | "radarr";
  state: ArrServiceState;
  detail?: string;
  qualityProfiles: ArrQualityProfile[];
  rootFolders: ArrRootFolder[];
  defaults: ArrRequestDefaults;
}

export interface RequestOptionsResponse {
  checkedAt: string;
  services: {
    sonarr: ArrRequestOptions;
    radarr: ArrRequestOptions;
  };
}

export interface RequestOptionsInput {
  qualityProfileId?: number;
  rootFolderPath?: string;
  monitor?: RequestMonitor;
  searchOnAdd?: boolean;
}

export interface CreateRequestInput {
  kind: RequestKind;
  tmdbId?: number;
  tvdbId?: number;
  options?: RequestOptionsInput;
}

export interface CreateRequestResponse {
  status: "added" | "already_exists";
  service: "sonarr" | "radarr";
  title: string;
  year?: number;
  id?: number;
}

export type ShowSource = "jellyfin" | "sonarr";
export type ShowAvailability = "jellyfin" | "sonarr" | "missing" | "upcoming";

export interface ShowDownload {
  status: ActivityStatus;
  progress: number;
  timeLeft?: string;
  estimatedCompletionTime?: string;
  sizeBytes?: number;
  downloadClient?: string;
  protocol?: "torrent" | "usenet";
  quality?: string;
  seasonPack?: boolean;
  statusMessages?: string[];
}

export interface ShowEpisode {
  key: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  overview?: string;
  airDate?: string;
  runtimeMinutes?: number;
  imageUrl?: string;
  monitored?: boolean;
  availability: ShowAvailability;
  download?: ShowDownload;
}

export interface ShowSeason {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  availableCount: number;
  downloadingCount: number;
}

export interface ShowSeriesSummary {
  title: string;
  year?: number;
  overview?: string;
  network?: string;
  rating?: number;
  imageUrl?: string;
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
}

export interface ShowDetailResponse {
  source: ShowSource;
  state: ArrServiceState;
  detail?: string;
  warnings?: string[];
  series: ShowSeriesSummary;
  defaultSeason?: number;
  seasons: ShowSeason[];
  episodes: ShowEpisode[];
}

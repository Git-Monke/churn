import type { ServiceId } from "./config.js";
import type { ReleasePickReason } from "./release-pick.js";
import type { ReleaseRepickEvent } from "./release-events.js";

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

export type VpnCheckId =
  | "mullvad_exit"
  | "kill_switch"
  | "dns"
  | "ipv6"
  | "firewall_exception";

export interface VpnCheck {
  id: VpnCheckId;
  label: string;
  passed: boolean;
  detail: string;
}

export interface VpnExit {
  ip?: string;
  country?: string;
  city?: string;
  hostname?: string;
  organization?: string;
  serverType?: string;
  mullvadExit: boolean;
}

export type VpnCoverageId = "qbittorrent" | "prowlarr" | "flaresolverr";

export interface VpnCoverageEntry {
  id: VpnCoverageId;
  name: string;
  reachable: boolean;
}

export interface VpnStatusResponse {
  checkedAt: string;
  durationMs: number;
  secure: boolean;
  exit: VpnExit;
  checks: VpnCheck[];
  coverage: VpnCoverageEntry[];
  dnsNameservers: string[];
  firewallException?: string;
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

/** A title tracked by Sonarr/Radarr, whether or not it has downloaded yet. */
export interface RequestedLibraryItem {
  key: string;
  service: "sonarr" | "radarr";
  kind: "movie" | "series";
  arrId: number;
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
  /** True when the arr has the movie file or every series episode. */
  available: boolean;
}

export interface RequestedLibraryServiceState {
  id: "sonarr" | "radarr";
  state: ArrServiceState;
  detail?: string;
  count: number;
}

export interface RequestedLibraryResponse {
  checkedAt: string;
  services: RequestedLibraryServiceState[];
  items: RequestedLibraryItem[];
  total: number;
}

export interface CancelLibraryItemResponse {
  status: "cancelled";
  service: "sonarr" | "radarr";
  kind: "movie" | "series";
  id: number;
  /** Number of Sonarr/Radarr queue records removed for this title. */
  queueRemoved: number;
}

export interface CancelEpisodeDownloadResponse {
  status: "cancelled";
  service: "sonarr";
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  /** Number of Sonarr queue records removed for this episode's download. */
  queueRemoved: number;
  /** True when the cancelled download was a season pack. */
  seasonPack: boolean;
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
  /** True when the arr has the movie file or every series episode. */
  available?: boolean;
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
  /** Sum of live qBittorrent download speeds over unique downloads. */
  downloadSpeedBytes?: number;
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
  /** Recent automatic release re-picks, newest first. */
  repicks?: ReleaseRepickEvent[];
}

export interface ShowRelease {
  /** Opaque id for grabbing this release without exposing its GUID/magnet URL. */
  id: string;
  title: string;
  indexer?: string;
  sizeBytes: number;
  quality?: string;
  seasonLabel: string;
  episodeLabel?: string;
  multiSeason: boolean;
  approved: boolean;
  canGrab: boolean;
  recommended: boolean;
  /** Why this release was recommended, when it was. */
  recommendation?: ReleasePickReason;
  rejections: string[];
  mappedEpisodeCount: number;
  protocol?: "torrent" | "usenet";
  seeders?: number;
  leechers?: number;
  ageHours?: number;
  publishDate?: string;
  /** Season search that produced this release, used to look it up again on grab. */
  searchSeasonNumber?: number;
}

export interface ShowReleasesResponse {
  seriesId: number;
  seasonNumber: number;
  episodeNumber?: number;
  checkedAt: string;
  releases: ShowRelease[];
}

export interface GrabShowReleaseInput {
  seasonNumber: number;
  episodeNumber?: number;
  searchSeasonNumber?: number;
  releaseId: string;
}

export interface GrabShowReleaseResponse {
  status: "grabbed";
  title: string;
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
  /** Churn picks the fastest well-seeded release instead of the arr. */
  smartPick?: boolean;
  /** Minimum seeders for a torrent to count as usable. */
  minSeeders?: number;
}

export interface RequestDownload {
  title: string;
  quality?: string;
  seeders?: number;
  sizeBytes?: number;
  seasonNumber?: number;
  reason: ReleasePickReason;
  /** True when the arr had to override the quality profile to grab it. */
  override: boolean;
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
  /** Let churn pick the fastest well-seeded release instead of the arr. */
  smartPick?: boolean;
  /** Minimum seeders for a torrent to count as usable. */
  minSeeders?: number;
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
  /** Releases churn grabbed itself, when seeders-aware picking was enabled. */
  downloads?: RequestDownload[];
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
  /** Jellyfin episode id, used to open the in-app player. */
  jellyfinId?: string;
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
  /** Sonarr series id when this show is tracked there, regardless of source. */
  sonarrId?: number;
  defaultSeason?: number;
  seasons: ShowSeason[];
  episodes: ShowEpisode[];
}

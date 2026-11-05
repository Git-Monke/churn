import type { ServiceId } from "./config.js";
import type { MediaAddedBy } from "./media-attribution.js";
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

export type StatsSource = "qbittorrent" | "disk";

export interface StatsSourceError {
  source: StatsSource;
  message: string;
}

export interface StatsQbittorrent {
  /** All-time downloaded bytes. */
  totalDownloadedBytes: number;
  /** All-time uploaded bytes. */
  totalUploadedBytes: number;
}

export interface StatsDiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  /** One decimal, 0–100. */
  usedPercent: number;
}

export interface StatsResponse {
  checkedAt: string;
  qbittorrent?: StatsQbittorrent;
  disk?: StatsDiskUsage;
  /** Sources that could not be read; the rest of the response is still valid. */
  errors: StatsSourceError[];
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
  addedBy?: MediaAddedBy;
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
  addedBy?: MediaAddedBy;
  /**
   * Arr import hint: the arr has a file, but only Jellyfin can say whether the
   * title is playable. Used for scan-state and release-prefetch decisions, never
   * for the Available badge or play links.
   */
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

export interface CancelJellyfinItemResponse {
  status: "cancelled";
  service: "jellyfin";
  kind: "movie" | "series";
  id: string;
}

export interface CancelEpisodeDownloadResponse {
  status: "cancelled";
  service: "sonarr";
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  /** Number of Sonarr queue records removed for this episode's download. */
  queueRemoved: number;
  /** Number of untracked qBittorrent torrents removed directly. */
  downloadClientRemoved?: number;
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
  /** Present only when the qBittorrent download matched a local arr title. */
  service?: "sonarr" | "radarr";
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
  /** Number of active qBittorrent torrents represented by this item. */
  queueCount: number;
  status: ActivityStatus;
  progress: number;
  sizeBytes?: number;
  sizeLeftBytes?: number;
  /** Sum of live qBittorrent download speeds over unique downloads. */
  downloadSpeedBytes?: number;
  /** Seeds currently connected to the torrents in this item. */
  connectedSeeders?: number;
  /** Seeds the trackers report for the swarm. */
  swarmSeeders?: number;
  timeLeft?: string;
  estimatedCompletionTime?: string;
  downloadClients: string[];
  protocols: Array<"torrent" | "usenet">;
  quality?: string;
  statusMessages?: string[];
}

export interface ActivityServiceState {
  id: "qbittorrent";
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
  /** 0 = 480p/SD, 1 = 720p, 2 = 1080p, 3 = 2160p; 99 = unknown. */
  tier?: number;
  tierLabel?: string;
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
  /** Why a result is visible but cannot be sent to qBittorrent. */
  downloadDetail?: string;
}

export interface ReleaseGroup {
  /** 0 = 480p/SD, 1 = 720p, 2 = 1080p, 3 = 2160p; 99 = unknown. */
  tier: number;
  label: string;
  maxSeeders?: number;
  /** True when the best release in this group has fewer than 50 seeders. */
  lowSeeders: boolean;
  /** Seeders descending, then size ascending, then oldest first. */
  releases: ShowRelease[];
}

export type ReleaseIndexerState = "pending" | "searching" | "finished" | "error";

export interface ReleaseIndexerProgress {
  id: number;
  name: string;
  state: ReleaseIndexerState;
  count: number;
  /** True when results from this indexer can be sent to qBittorrent. */
  canGrab: boolean;
  detail?: string;
}

export interface ReleaseSearchProgress {
  finished: number;
  total: number;
  indexers: ReleaseIndexerProgress[];
}

export interface CachedReleasesResponse {
  kind: "movie" | "series-season";
  service: "radarr" | "sonarr";
  targetId: number;
  seasonNumber?: number;
  /** Set when the season results were narrowed to one episode. */
  episodeNumber?: number;
  state: "ready" | "searching" | "error";
  refreshing: boolean;
  detail?: string;
  fetchedAt?: string;
  releaseCount: number;
  groups: ReleaseGroup[];
  /** Per-indexer progress. Omitted by the legacy cached-release routes. */
  progress?: ReleaseSearchProgress;
}

export interface MovieSeriesSummary {
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
}

export interface MovieDetailResponse {
  source: "jellyfin" | "radarr";
  state: ArrServiceState;
  detail?: string;
  movie: {
    title: string;
    year?: number;
    overview?: string;
    network?: string;
    rating?: number;
    runtimeMinutes?: number;
    imageUrl?: string;
    tmdbId?: number;
    imdbId?: string;
  };
  /** Jellyfin item id, when the movie is available to play. */
  jellyfinId?: string;
  /** Radarr movie id, when the movie is tracked in Radarr. */
  radarrId?: number;
  /** Active qBittorrent download for this movie, if any. */
  download?: ActivityItem;
}

export interface MovieDownloadResponse {
  checkedAt: string;
  /** False until the full movie detail route has populated the identity cache. */
  ready: boolean;
  download?: ActivityItem;
}

export interface CancelMovieDownloadResponse {
  status: "cancelled";
  service: "radarr";
  /** Number of Radarr queue records removed for this movie. */
  queueRemoved: number;
  /** Number of untracked qBittorrent torrents removed directly. */
  downloadClientRemoved?: number;
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
  /** True when churn started warming the release cache in the background. */
  searching?: boolean;
}

export type ShowSource = "jellyfin" | "sonarr";
export type ShowAvailability = "jellyfin" | "missing" | "upcoming";

export interface ShowDownload {
  status: ActivityStatus;
  progress: number;
  timeLeft?: string;
  estimatedCompletionTime?: string;
  sizeBytes?: number;
  sizeLeftBytes?: number;
  /** Current qBittorrent download speed in bytes/second. */
  downloadSpeedBytes?: number;
  /** Seeds currently connected to the torrent. */
  connectedSeeders?: number;
  /** Seeds the tracker reports for the swarm. */
  swarmSeeders?: number;
  downloadClient?: string;
  protocol?: "torrent" | "usenet";
  quality?: string;
  seasonPack?: boolean;
  /** Found directly in qBittorrent because Sonarr has no queue record for it. */
  untracked?: boolean;
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
  /** Sonarr has a file, but Jellyfin has not indexed it yet (not playable). */
  imported?: boolean;
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
  /** Jellyfin returned no episodes and a library scan is in flight. */
  scanning?: boolean;
  defaultSeason?: number;
  seasons: ShowSeason[];
  episodes: ShowEpisode[];
}

export interface ShowDownloadsResponse {
  checkedAt: string;
  /** False until the full show detail route has populated the identity cache. */
  ready: boolean;
  /** Keyed by ShowEpisode.key. */
  downloads: Record<string, ShowDownload>;
}

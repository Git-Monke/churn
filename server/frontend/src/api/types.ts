export interface AuthUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface AuthSessionResponse {
  authenticated: boolean;
  user?: AuthUser;
  expiresAt?: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface LoginResponse {
  authenticated: true;
  user: AuthUser;
  expiresAt: string;
}

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
  /**
   * Arr import hint; Jellyfin alone determines playability. Used only for the
   * transitional Scanning state and release prefetching.
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
  queueRemoved: number;
  downloadClientRemoved?: number;
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

export interface ReleaseRepickEvent {
  id: number;
  at: string;
  service: "sonarr" | "radarr";
  mediaTitle: string;
  seasonNumber?: number;
  fromTitle: string;
  toTitle: string;
  fromReportedSeeders?: number;
  connectedSeeds?: number;
  downloadSpeed?: number;
  toReportedSeeders?: number;
}

export interface ActivityResponse {
  checkedAt: string;
  services: ActivityServiceState[];
  items: ActivityItem[];
  total: number;
  detail?: string;
  repicks?: ReleaseRepickEvent[];
}

export type ShowSource = "jellyfin" | "sonarr";
export type ShowAvailability = "jellyfin" | "missing" | "upcoming";

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

export interface ShowRelease {
  /** Opaque backend id; upstream GUIDs and magnet URLs stay server-side. */
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
  recommendation?: ReleasePickReason;
  rejections: string[];
  mappedEpisodeCount: number;
  protocol?: "torrent" | "usenet";
  seeders?: number;
  leechers?: number;
  ageHours?: number;
  publishDate?: string;
  searchSeasonNumber?: number;
  downloadDetail?: string;
}

export interface ShowReleasesResponse {
  seriesId: number;
  seasonNumber: number;
  episodeNumber?: number;
  checkedAt: string;
  releases: ShowRelease[];
}

export interface ReleaseGroup {
  tier: number;
  label: string;
  maxSeeders?: number;
  /** True when the best release in this group has fewer than 50 seeders. */
  lowSeeders: boolean;
  /** Seeders descending, then size ascending. */
  releases: ShowRelease[];
}

export type ReleaseIndexerState = "pending" | "searching" | "finished" | "error";

export interface ReleaseIndexerProgress {
  id: number;
  name: string;
  state: ReleaseIndexerState;
  count: number;
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
  progress?: ReleaseSearchProgress;
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
  jellyfinId?: string;
  radarrId?: number;
  /** Active qBittorrent download for this movie, if any. */
  download?: ActivityItem;
}

export interface CancelMovieDownloadResponse {
  status: "cancelled";
  service: "radarr";
  queueRemoved: number;
  downloadClientRemoved?: number;
}

export interface GrabMovieReleaseInput {
  releaseId: string;
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

export type ReleasePickReason =
  | "preferred"
  | "tier_upgrade"
  | "below_threshold"
  | "best_effort";

export interface CreateRequestResponse {
  status: "added" | "already_exists";
  service: "sonarr" | "radarr";
  title: string;
  year?: number;
  id?: number;
  searching?: boolean;
}

export type PlaybackState = "ok" | "unauthorized" | "unreachable";

export interface PlaybackItem {
  id: string;
  type: "Movie" | "Episode";
  name: string;
  seriesName?: string;
  seriesId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  year?: number;
  overview?: string;
  runtimeTicks?: number;
  positionTicks?: number;
  played?: boolean;
  imageUrl?: string;
  /** Same-origin redirect endpoint; never contains the Jellyfin token. */
  streamUrl: string;
  playSessionId?: string;
  mediaSourceId?: string;
  directPlay: boolean;
  playbackMethod: "direct" | "hls";
}

export interface PlaybackItemResponse {
  state: PlaybackState;
  detail?: string;
  item?: PlaybackItem;
}

export interface PlaybackReport {
  positionTicks?: number;
  playSessionId?: string;
  mediaSourceId?: string;
  isPaused?: boolean;
}

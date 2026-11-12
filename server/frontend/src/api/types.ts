export interface AuthUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

export type AuthSessionKind = "admin" | "profile" | "direct";

export interface AuthSessionResponse {
  authenticated: boolean;
  user?: AuthUser;
  kind?: AuthSessionKind;
  profileId?: string;
  expiresAt?: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface LoginResponse {
  authenticated: true;
  user: AuthUser;
  kind: AuthSessionKind;
  profileId?: string;
  expiresAt: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  passwordSet: boolean;
}

export interface ManagedProfile extends ProfileSummary {
  initialPin: string | null;
  createdAt: number;
}

export interface ProfileLoginInput {
  profileId: string;
  password: string;
  newPassword?: string;
}

export interface ProfileLoginResponse {
  authenticated?: true;
  passwordSetupRequired?: true;
  user?: AuthUser;
  kind?: AuthSessionKind;
  profileId?: string;
  profile?: ProfileSummary;
  expiresAt?: string;
}

export interface CreateProfileResponse {
  profile: ManagedProfile;
  pin: string;
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

export type StatsSource = "qbittorrent" | "disk";

export interface StatsSourceError {
  source: StatsSource;
  message: string;
}

export interface StatsQbittorrent {
  totalDownloadedBytes: number;
  totalUploadedBytes: number;
}

export interface StatsDiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface StatsResponse {
  checkedAt: string;
  qbittorrent?: StatsQbittorrent;
  disk?: StatsDiskUsage;
  errors: StatsSourceError[];
}

export type VpnCheckId =
  | "tunnel_exit"
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
  organization?: string;
  /** Whether the observed exit equals the address Gluetun connected with. */
  matchesGluetun: boolean;
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
  /** Gluetun's provider id, e.g. "mullvad" or "private internet access". */
  provider: string;
  /** Gluetun's transport, e.g. "wireguard" or "openvpn". */
  protocol: string;
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

export interface MediaAddedBy {
  /** Jellyfin user id. */
  id: string;
  /** Display name captured when the title was added. */
  name: string;
}

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

/** One partly watched title from Jellyfin's per-user resume list. */
export interface ContinueWatchingItem {
  id: string;
  kind: "movie" | "episode";
  /** Series name for episodes, movie title for films. */
  title: string;
  /** Episode title; absent for movies. */
  episodeTitle?: string;
  seriesId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  runtimeTicks?: number;
  positionTicks: number;
  /** Played percentage, 0–100. */
  playedPercentage: number;
  /**
   * The episode after the last completed one, offered before it is started.
   * `positionTicks` and `playedPercentage` are 0 for these cards.
   */
  upNext?: boolean;
  imageUrl?: string;
  lastPlayedDate?: string;
}

export interface ContinueWatchingResponse {
  source: "jellyfin";
  state: LibraryState;
  items: ContinueWatchingItem[];
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
  /** IMDb/TVDB vote count behind the result ordering. */
  votes?: number;
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
  /** Jellyfin's own per-user watched flag; absent without user data. */
  played?: boolean;
  /**
   * How far the signed-in user got, 1–99. Only set for a started episode that
   * Jellyfin does not consider played.
   */
  progressPercent?: number;
  /** Last play time for this user; ranks resume targets. */
  lastPlayedDate?: string;
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

export interface MovieDownloadResponse {
  checkedAt: string;
  /** False until the full movie detail route has populated the identity cache. */
  ready: boolean;
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
  /** Content rating such as `TV-PG`; movies only in practice. */
  officialRating?: string;
  /** ISO air date for episodes (`2009-04-16T00:00:00.0000000Z`). */
  premiereDate?: string;
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
  quality: PlaybackQuality;
  /** Selectable presets for this source; always contains `max`. */
  qualities: PlaybackQualityOption[];
  /** The next episode in Jellyfin's list, when this item is an episode. */
  nextEpisode?: PlaybackNextEpisode;
  /**
   * Intro/recap/credits ranges warmed from IntroDB when the season or episode
   * was grabbed. Absent when there is no cached data for this episode.
   */
  segments?: PlaybackSegments;
}

export interface PlaybackNextEpisode {
  id: string;
  name: string;
  seasonNumber: number;
  episodeNumber: number;
}

export interface PlaybackSegment {
  startSec: number;
  endSec: number;
}

export interface PlaybackSegments {
  intro?: PlaybackSegment;
  recap?: PlaybackSegment;
  outro?: PlaybackSegment;
  postCredits?: PlaybackSegment;
}

export type PlaybackQuality = "max" | "high" | "medium" | "low";

export interface PlaybackQualityOption {
  id: PlaybackQuality;
  label: string;
  /** Pre-formatted caps, e.g. "720p · 5 Mbps". */
  detail: string;
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
  playbackMethod?: "direct" | "hls";
}

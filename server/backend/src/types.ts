import type { AuthSessionKind, AuthUser } from "./auth.js";
import type { ServiceId } from "./config.js";
import type { MediaAddedBy } from "./media-attribution.js";
import type { ReleasePickReason } from "./release-pick.js";
import type { ReleaseRepickEvent } from "./release-events.js";

/** Every error response: `{ error: { code, message } }`. */
export interface ErrorResponse {
  error: {
    /** Stable, machine-readable code such as `invalid_credentials`. */
    code: string;
    /** Safe to show to a person. */
    message: string;
  };
}

export interface HealthResponse {
  status: "ok";
}

/** `GET /api/meta`: what this server's API offers, for clients to check at start. */
export interface MetaResponse {
  api: {
    /** Every API version served, oldest first. Call `/api/v{n}/...`. */
    versions: number[];
    /** The newest version, which unversioned `/api/...` also serves. */
    current: number;
  };
  /** Optional parts of the API this server has. Names are only ever added. */
  features: string[];
}

/** `GET /api/auth/session`: who is signed in, if anyone. */
export interface AuthSessionResponse {
  authenticated: boolean;
  user?: AuthUser;
  kind?: AuthSessionKind;
  profileId?: string;
  /** ISO time the session expires. */
  expiresAt?: string;
}

/** A successful sign-in. */
export interface LoginResponse {
  authenticated: true;
  user: AuthUser;
  kind: AuthSessionKind;
  profileId?: string;
  expiresAt: string;
}

/** `GET /api/auth/passkeys/available`: where passkeys work, or `null` when they are off. */
export interface PasskeyAvailabilityResponse {
  origin: string | null;
}

/** A passkey a person saved, as listed for them to remove. */
export interface SavedPasskey {
  id: string;
  label: string;
  /** ISO times. */
  createdAt: string;
  lastUsedAt?: string;
}

/** A household member as shown on the sign-in screen. */
export interface ProfileSummary {
  id: string;
  name: string;
  passwordSet: boolean;
}

/** A household member as an administrator manages them. */
export interface ManagedProfile extends ProfileSummary {
  /** One-time PIN, until the person sets their own password. */
  initialPin: string | null;
  createdAt: number;
}

/** Profile sign-in: either signed in, or asked to set a password first. */
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

export type StatsSource = "qbittorrent" | "disk" | "library";

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

export interface StatsTopItem {
  name: string;
  bytes: number;
  /** Set when the torrent or library entry maps to a Sonarr/Radarr title. */
  kind?: "movie" | "series";
  /** Torrent release name when `name` is the mapped library title. */
  detail?: string;
}

export interface StatsResponse {
  checkedAt: string;
  qbittorrent?: StatsQbittorrent;
  disk?: StatsDiskUsage;
  /** Top torrents by downloaded bytes. */
  topDownloads?: StatsTopItem[];
  /** Top torrents by uploaded bytes. */
  topUploads?: StatsTopItem[];
  /** Largest Sonarr series and Radarr movies by `statistics.sizeOnDisk`. */
  topStorage?: StatsTopItem[];
  /** Sources that could not be read; the rest of the response is still valid. */
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

/** One partly watched title, straight from Jellyfin's per-user resume list. */
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
  /** IMDb/TVDB vote count, used to rank results. */
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
  /**
   * Radarr imported the file but Jellyfin does not list the movie yet: the
   * in-between state between a finished download and a playable title.
   */
  imported?: boolean;
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

/** `POST /api/tv/pair/start`: a device asks to be paired. */
export interface PairingStartRequest {
  /** What to call the device in the dashboard, such as "Living Room TV". */
  deviceName: string;
}

export interface PairingStartResponse {
  /** Six characters to show on the TV; someone signed in approves it. */
  code: string;
  /** Keep private: only the device polls with it, in `x-churn-pair-token`. */
  pollToken: string;
  /** ISO time the code stops working. */
  expiresAt: string;
  /** Where to approve it, relative to the server: put it in a QR code. */
  approvePath: string;
  /** How often to poll `GET /api/tv/pair/{code}`. */
  pollIntervalSeconds: number;
}

/**
 * `GET /api/tv/pair/{code}`, polled by the device. `approved` comes exactly
 * once, with the device's token; after that, or after `denied`, the code is
 * gone and polling it returns 404.
 */
export interface PairingStatusResponse {
  status: "pending" | "approved" | "denied";
  /** Send as `Authorization: Bearer <token>` on every request. */
  token?: string;
  user?: AuthUser;
  /** ISO time the token stops working if the device goes unused. */
  expiresAt?: string;
}

/** `GET /api/tv/pair/{code}/details`: what a person is about to approve. */
export interface PairingDetailsResponse {
  code: string;
  deviceName: string;
  status: "pending" | "approved" | "denied";
  expiresAt: string;
}

/** A paired device, as listed in the dashboard. */
export interface PairedDevice {
  id: string;
  name: string;
  user: { id: string; name: string };
  /** ISO times. */
  pairedAt: string;
  lastSeenAt: string;
}

export interface PairingApproveResponse {
  status: "approved";
  device: PairedDevice;
}

export interface PairedDevicesResponse {
  devices: PairedDevice[];
}

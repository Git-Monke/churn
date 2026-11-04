import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { detectLanAddress } from "./lan.js";

export type ServiceId = "jellyfin" | "sonarr" | "radarr";
export type CookieSecureSetting = "auto" | boolean;

export interface ServiceConfig {
  id: ServiceId;
  name: string;
  url: string;
  apiKey?: string;
}

export interface QbittorrentConfig {
  url: string;
  apiKey?: string;
}

export interface ProwlarrConfig {
  url: string;
  apiKey?: string;
}

export interface VpnConfig {
  /** Loopback-only address of the torrent stack's vpn-status agent. */
  statusUrl: string;
  /** The agent runs external curl probes, so this is longer than a normal API timeout. */
  timeoutMs: number;
}

export interface BrowserHostHeaders {
  host?: string;
  "x-forwarded-host"?: string | string[];
  forwarded?: string | string[];
}

export interface AppConfig {
  host: string;
  port: number;
  serverDir: string;
  frontendDist: string;
  requestTimeoutMs: number;
  /**
   * Timeout for media search and request-option lookups. Sonarr can take
   * several seconds to answer a lookup on a large library, so this is more
   * forgiving than `requestTimeoutMs`.
   */
  searchTimeoutMs: number;
  /**
   * Timeout for Sonarr/Radarr release lookups such as the episode picker.
   * Direct season and movie grabs are sent to qBittorrent instead.
   */
  releaseTimeoutMs: number;
  sessionTtlMs: number;
  cookieSecure: CookieSecureSetting;
  /** Writable directory for persisted profiles and sessions. */
  stateDir: string;
  /**
   * Jellyfin URL handed to the browser for video streams. An explicit
   * `JELLYFIN_PUBLIC_URL` always wins; otherwise the request host is used (see
   * `jellyfinPublicUrlForRequest`), with this value as the fallback.
   */
  jellyfinPublicUrl: string;
  /** True when `JELLYFIN_PUBLIC_URL` was set and must override the request host. */
  jellyfinPublicUrlExplicit: boolean;
  /** Address used as that fallback; undefined when no LAN interface was found. */
  lanAddress?: string;
  services: Record<ServiceId, ServiceConfig>;
  qbittorrent: QbittorrentConfig;
  prowlarr: ProwlarrConfig;
  vpn: VpnConfig;
}

interface LoadConfigOptions {
  serverDir?: string;
  env?: NodeJS.ProcessEnv;
  readDotEnv?: boolean;
  /** Override LAN detection; tests inject a stub to stay machine-independent. */
  detectLan?: () => string | undefined;
}

const SERVICE_DEFAULTS: Record<ServiceId, { name: string; url: string }> = {
  jellyfin: { name: "Jellyfin", url: "http://127.0.0.1:8096" },
  sonarr: { name: "Sonarr", url: "http://127.0.0.1:8989" },
  radarr: { name: "Radarr", url: "http://127.0.0.1:7878" },
};

const QBITTORRENT_DEFAULT_URL = "http://127.0.0.1:8080";
const PROWLARR_DEFAULT_URL = "http://127.0.0.1:9696";
const VPN_STATUS_DEFAULT_URL = "http://127.0.0.1:8098";

/** Resolve the `server/` directory from this module, under both src/ and dist/. */
export function resolveServerDir(): string {
  const override = process.env.CHURN_SERVER_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "../..");
}

/** Read the first <ApiKey> value from a Sonarr/Radarr config.xml. */
export function readApiKeyFromConfigXml(serverDir: string, service: "sonarr" | "radarr"): string | undefined {
  const configPath = path.join(serverDir, "config", service, "config.xml");
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const contents = readFileSync(configPath, "utf8");
    const match = contents.match(/<ApiKey>\s*([^<\s]+)\s*<\/ApiKey>/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Read the stable API key seeded by `qbittorrent-init`. qBittorrent 5.x stores
 * it under `[WebUI]`; older churn installs wrote `WebUI\APIKey` under
 * `[Preferences]`.
 */
export function readQbittorrentApiKey(serverDir: string): string | undefined {
  const configPath = path.resolve(
    serverDir,
    "..",
    "torrent",
    "config",
    "qbittorrent",
    "qBittorrent",
    "qBittorrent.conf",
  );
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const contents = readFileSync(configPath, "utf8");
    let inWebUi = false;
    let legacyKey: string | undefined;
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        inWebUi = trimmed === "[WebUI]";
        continue;
      }
      if (inWebUi) {
        const match = trimmed.match(/^APIKey\s*=\s*(.*)$/);
        const key = match ? cleanApiKey(match[1]) : undefined;
        if (key) {
          return key;
        }
      }
      const legacy = trimmed.match(/^WebUI\\APIKey\s*=\s*(.*)$/);
      if (legacy) {
        legacyKey = cleanApiKey(legacy[1]) ?? legacyKey;
      }
    }
    return legacyKey;
  } catch {
    return undefined;
  }
}

/** Read the Prowlarr key seeded by `prowlarr-init` in the torrent stack. */
export function readProwlarrApiKey(serverDir: string): string | undefined {
  const configPath = path.resolve(
    serverDir,
    "..",
    "torrent",
    "config",
    "prowlarr",
    "config.xml",
  );
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const contents = readFileSync(configPath, "utf8");
    const match = contents.match(/<ApiKey>\s*([^<\s]+)\s*<\/ApiKey>/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const serverDir = path.resolve(options.serverDir ?? resolveServerDir());
  const env = options.env ?? process.env;
  const fileEnv = options.readDotEnv === false ? {} : readDotEnv(serverDir);
  // Process environment wins over churn's generated .env file.
  const values: NodeJS.ProcessEnv = { ...fileEnv, ...env };
  const detectLan = options.detectLan ?? (() => detectLanAddress(values));
  const lanAddress = detectLan();

  const services: Record<ServiceId, ServiceConfig> = {
    jellyfin: {
      id: "jellyfin",
      name: SERVICE_DEFAULTS.jellyfin.name,
      url: normalizeUrl(values.JELLYFIN_URL, SERVICE_DEFAULTS.jellyfin.url),
      apiKey: nonEmpty(values.JELLYFIN_API_KEY),
    },
    sonarr: {
      id: "sonarr",
      name: SERVICE_DEFAULTS.sonarr.name,
      url: normalizeUrl(values.SONARR_URL, SERVICE_DEFAULTS.sonarr.url),
      apiKey: cleanApiKey(values.SONARR_API_KEY) ?? readApiKeyFromConfigXml(serverDir, "sonarr"),
    },
    radarr: {
      id: "radarr",
      name: SERVICE_DEFAULTS.radarr.name,
      url: normalizeUrl(values.RADARR_URL, SERVICE_DEFAULTS.radarr.url),
      apiKey: cleanApiKey(values.RADARR_API_KEY) ?? readApiKeyFromConfigXml(serverDir, "radarr"),
    },
  };

  const qbittorrent: QbittorrentConfig = {
    url: normalizeUrl(values.QBITTORRENT_URL, QBITTORRENT_DEFAULT_URL),
    apiKey: cleanApiKey(values.QBITTORRENT_API_KEY) ?? readQbittorrentApiKey(serverDir),
  };

  const prowlarr: ProwlarrConfig = {
    url: normalizeUrl(values.PROWLARR_URL, PROWLARR_DEFAULT_URL),
    apiKey: cleanApiKey(values.PROWLARR_API_KEY) ?? readProwlarrApiKey(serverDir),
  };

  const vpn: VpnConfig = {
    statusUrl: normalizeUrl(values.VPN_STATUS_URL, VPN_STATUS_DEFAULT_URL),
    timeoutMs: parseVpnTimeout(values.VPN_STATUS_TIMEOUT_MS),
  };

  const explicitPublicUrl = nonEmpty(values.JELLYFIN_PUBLIC_URL);

  return {
    host: nonEmpty(values.HOST) ?? "127.0.0.1",
    port: parsePort(values.PORT),
    serverDir,
    frontendDist: path.join(serverDir, "frontend", "dist"),
    requestTimeoutMs: parseTimeout(values.REQUEST_TIMEOUT_MS),
    searchTimeoutMs: parseSearchTimeout(values.SEARCH_TIMEOUT_MS),
    releaseTimeoutMs: parseReleaseTimeout(values.RELEASE_TIMEOUT_MS),
    sessionTtlMs: parseSessionTtl(values.CHURN_SESSION_TTL_MS),
    cookieSecure: parseCookieSecure(values.CHURN_COOKIE_SECURE),
    stateDir: resolveStateDir(values.CHURN_STATE_DIR, serverDir),
    jellyfinPublicUrl: resolveJellyfinPublicUrl(
      explicitPublicUrl,
      services.jellyfin.url,
      lanAddress,
    ),
    jellyfinPublicUrlExplicit: explicitPublicUrl !== undefined,
    lanAddress,
    services,
    qbittorrent,
    prowlarr,
    vpn,
  };
}

function readDotEnv(serverDir: string): NodeJS.ProcessEnv {
  const envPath = path.join(serverDir, ".env");
  if (!existsSync(envPath)) {
    return {};
  }
  try {
    return dotenv.parse(readFileSync(envPath));
  } catch {
    return {};
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cleanApiKey(value: string | undefined): string | undefined {
  return nonEmpty(value?.replace(/^["']|["']$/g, ""));
}

/**
 * Resolve the LAN-based fallback URL for video streams.
 *
 * Used when the request host cannot be used, for example for health checks or
 * a request without a Host header. A loopback Jellyfin address (or a
 * single-label container/service host such as `jellyfin`) is replaced with the
 * host's LAN address, keeping the scheme, port and base path. When no LAN
 * address is available the Jellyfin URL is used unchanged.
 */
function resolveJellyfinPublicUrl(
  explicit: string | undefined,
  jellyfinUrl: string,
  lanAddress: string | undefined,
): string {
  if (nonEmpty(explicit)) {
    return normalizeUrl(explicit, jellyfinUrl);
  }
  if (!lanAddress) {
    return jellyfinUrl;
  }

  const url = new URL(jellyfinUrl);
  if (!needsPublicHost(url.hostname)) {
    return jellyfinUrl;
  }
  url.hostname = lanAddress;
  return normalizeUrl(url.toString(), jellyfinUrl);
}

/**
 * Resolve the Jellyfin URL for the browser that made this request.
 *
 * An explicit `JELLYFIN_PUBLIC_URL` always wins. Otherwise a Jellyfin URL that
 * the browser cannot resolve (loopback or a Docker service name) is rewritten
 * to the hostname the browser used to reach Churn. That makes the same
 * deployment work through a LAN IP, a tailnet IP or a MagicDNS name without
 * extra configuration. When no request host is available the LAN-based
 * fallback from `loadConfig` is used.
 */
export function jellyfinPublicUrlForRequest(
  config: AppConfig,
  headers: BrowserHostHeaders,
): string {
  if (config.jellyfinPublicUrlExplicit) {
    return config.jellyfinPublicUrl;
  }

  const jellyfin = new URL(config.services.jellyfin.url);
  if (!needsPublicHost(jellyfin.hostname)) {
    return config.services.jellyfin.url;
  }

  const hostname = requestHostname(headers) ?? config.lanAddress;
  if (!hostname) {
    return config.jellyfinPublicUrl;
  }
  jellyfin.hostname = hostname;
  return normalizeUrl(jellyfin.toString(), config.services.jellyfin.url);
}

/** Host as the browser saw it, preferring a reverse proxy's public host. */
function requestHostname(headers: BrowserHostHeaders): string | undefined {
  const candidates = [
    firstHeader(headers["x-forwarded-host"]),
    forwardedHost(firstHeader(headers.forwarded)),
    firstHeader(headers.host),
  ];
  for (const candidate of candidates) {
    const hostname = parseHostname(candidate);
    if (hostname) {
      return hostname;
    }
  }
  return undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

function forwardedHost(value: string | undefined): string | undefined {
  return value?.match(/(?:^|;)\s*host="?([^";,]+)"?/i)?.[1];
}

/** Host header characters: names, addresses, ports and IPv6 brackets. */
const HOST_HEADER_PATTERN = /^[A-Za-z0-9._:[\]-]+$/;

function parseHostname(value: string | undefined): string | undefined {
  if (!value || value.length > 255 || !HOST_HEADER_PATTERN.test(value)) {
    return undefined;
  }
  try {
    return new URL(`http://${value}`).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** True when a browser on another machine cannot resolve this host. */
function needsPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    return true;
  }
  if (/^127\./.test(host)) {
    return true;
  }
  // Bare IPv6 literals are globally routable; leave them alone.
  if (host.includes(":")) {
    return false;
  }
  // A single-label name is a Docker service or compose host, not a LAN host.
  return !host.includes(".");
}

function normalizeUrl(value: string | undefined, fallback: string): string {
  const raw = nonEmpty(value) ?? fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid service URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`service URL must use http or https: ${raw}`);
  }
  return url.toString().replace(/\/+$/, "");
}

function parsePort(value: string | undefined): number {
  if (!value?.trim()) {
    return 4000;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${value}`);
  }
  return port;
}

function parseTimeout(value: string | undefined): number {
  if (!value?.trim()) {
    return 5000;
  }
  const timeout = Number.parseInt(value, 10);
  if (!Number.isInteger(timeout) || timeout < 250 || timeout > 60_000) {
    throw new Error(`invalid REQUEST_TIMEOUT_MS: ${value}`);
  }
  return timeout;
}

const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;
const MIN_SEARCH_TIMEOUT_MS = 1_000;
const MAX_SEARCH_TIMEOUT_MS = 120_000;

function parseReleaseTimeout(value: string | undefined): number {
  if (!value?.trim()) {
    return 120_000;
  }
  const timeout = Number.parseInt(value, 10);
  if (!Number.isInteger(timeout) || timeout < 30_000 || timeout > 300_000) {
    throw new Error(`invalid RELEASE_TIMEOUT_MS: ${value}`);
  }
  return timeout;
}

function parseSearchTimeout(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_SEARCH_TIMEOUT_MS;
  }
  const timeout = Number.parseInt(value, 10);
  if (
    !Number.isInteger(timeout) ||
    timeout < MIN_SEARCH_TIMEOUT_MS ||
    timeout > MAX_SEARCH_TIMEOUT_MS
  ) {
    throw new Error(`invalid SEARCH_TIMEOUT_MS: ${value}`);
  }
  return timeout;
}

const DEFAULT_VPN_STATUS_TIMEOUT_MS = 25_000;
const MIN_VPN_STATUS_TIMEOUT_MS = 1_000;
const MAX_VPN_STATUS_TIMEOUT_MS = 120_000;

function parseVpnTimeout(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_VPN_STATUS_TIMEOUT_MS;
  }
  const timeout = Number.parseInt(value, 10);
  if (
    !Number.isInteger(timeout) ||
    timeout < MIN_VPN_STATUS_TIMEOUT_MS ||
    timeout > MAX_VPN_STATUS_TIMEOUT_MS
  ) {
    throw new Error(`invalid VPN_STATUS_TIMEOUT_MS: ${value}`);
  }
  return timeout;
}

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseSessionTtl(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_SESSION_TTL_MS;
  }
  const ttl = Number.parseInt(value, 10);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`invalid CHURN_SESSION_TTL_MS: ${value}`);
  }
  return Math.min(Math.max(ttl, MIN_SESSION_TTL_MS), MAX_SESSION_TTL_MS);
}

function resolveStateDir(value: string | undefined, serverDir: string): string {
  const override = nonEmpty(value);
  return override ? path.resolve(override) : path.join(serverDir, ".churn-state");
}

function parseCookieSecure(value: string | undefined): CookieSecureSetting {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return "auto";
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(`invalid CHURN_COOKIE_SECURE: ${value}`);
}

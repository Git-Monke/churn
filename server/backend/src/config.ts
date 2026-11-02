import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

export type ServiceId = "jellyfin" | "sonarr" | "radarr";
export type CookieSecureSetting = "auto" | boolean;

export interface ServiceConfig {
  id: ServiceId;
  name: string;
  url: string;
  apiKey?: string;
}

export interface AppConfig {
  host: string;
  port: number;
  serverDir: string;
  frontendDist: string;
  requestTimeoutMs: number;
  sessionTtlMs: number;
  cookieSecure: CookieSecureSetting;
  jellyfinPublicUrl: string;
  services: Record<ServiceId, ServiceConfig>;
}

interface LoadConfigOptions {
  serverDir?: string;
  env?: NodeJS.ProcessEnv;
  readDotEnv?: boolean;
}

const SERVICE_DEFAULTS: Record<ServiceId, { name: string; url: string }> = {
  jellyfin: { name: "Jellyfin", url: "http://127.0.0.1:8096" },
  sonarr: { name: "Sonarr", url: "http://127.0.0.1:8989" },
  radarr: { name: "Radarr", url: "http://127.0.0.1:7878" },
};

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

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const serverDir = path.resolve(options.serverDir ?? resolveServerDir());
  const env = options.env ?? process.env;
  const fileEnv = options.readDotEnv === false ? {} : readDotEnv(serverDir);
  // Process environment wins over churn's generated .env file.
  const values: NodeJS.ProcessEnv = { ...fileEnv, ...env };

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

  return {
    host: nonEmpty(values.HOST) ?? "127.0.0.1",
    port: parsePort(values.PORT),
    serverDir,
    frontendDist: path.join(serverDir, "frontend", "dist"),
    requestTimeoutMs: parseTimeout(values.REQUEST_TIMEOUT_MS),
    sessionTtlMs: parseSessionTtl(values.CHURN_SESSION_TTL_MS),
    cookieSecure: parseCookieSecure(values.CHURN_COOKIE_SECURE),
    jellyfinPublicUrl: normalizeUrl(
      values.JELLYFIN_PUBLIC_URL,
      services.jellyfin.url,
    ),
    services,
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

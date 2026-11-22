import type { AppConfig, ServiceId } from "./config.js";

/** An icon fetched from the service itself, ready to send to the browser. */
export interface ServiceIcon {
  body: Buffer;
  contentType: string;
}

const MAX_ICON_BYTES = 256 * 1024;
const ICON_TYPES = new Set(["image/svg+xml", "image/png", "image/x-icon", "image/vnd.microsoft.icon"]);
/** How long a fetched icon (or a miss) is reused before asking the service again. */
const ICON_TTL_MS = 60 * 60 * 1000;

const cache = new Map<ServiceId, { icon: ServiceIcon | null; expires: number }>();

/**
 * Each service's own logo, so the Services page shows the icon of the version
 * that is actually installed and churn ships no third-party artwork. Sonarr and
 * Radarr serve a logo at a fixed path; Jellyfin's icons are content-hashed, so
 * its touch icon is found through the web client's index page.
 */
export async function fetchServiceIcon(
  config: AppConfig,
  id: ServiceId,
  now: () => number = Date.now,
): Promise<ServiceIcon | null> {
  const cached = cache.get(id);
  if (cached && cached.expires > now()) {
    return cached.icon;
  }
  let icon: ServiceIcon | null = null;
  try {
    icon = await loadIcon(config, id);
  } catch {
    icon = null;
  }
  cache.set(id, { icon, expires: now() + ICON_TTL_MS });
  return icon;
}

/** Forget fetched icons. For tests, which give each case its own services. */
export function clearServiceIconCache(): void {
  cache.clear();
}

async function loadIcon(config: AppConfig, id: ServiceId): Promise<ServiceIcon | null> {
  const base = config.services[id].url.replace(/\/+$/, "");
  if (id === "jellyfin") {
    const index = await fetchLimited(`${base}/web/index.html`, config.requestTimeoutMs);
    if (!index) {
      return null;
    }
    const href = /<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/i
      .exec(index.body.toString("utf8"))?.[1]
      ?? /href="(touchicon[^"]*\.png)"/i.exec(index.body.toString("utf8"))?.[1];
    if (!href || /^[a-z]+:|^\/\//i.test(href)) {
      return null;
    }
    return asIcon(await fetchLimited(`${base}/web/${href.replace(/^\/+/, "")}`, config.requestTimeoutMs));
  }
  return asIcon(await fetchLimited(`${base}/Content/Images/logo.svg`, config.requestTimeoutMs));
}

function asIcon(response: ServiceIcon | null): ServiceIcon | null {
  if (!response || !ICON_TYPES.has(response.contentType)) {
    return null;
  }
  return response;
}

async function fetchLimited(url: string, timeoutMs: number): Promise<ServiceIcon | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) {
    return null;
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0 || body.length > MAX_ICON_BYTES) {
    return null;
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  return { body, contentType };
}

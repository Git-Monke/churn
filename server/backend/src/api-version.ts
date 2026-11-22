/**
 * API versions. Clients that ship separately from the server (TV apps, for
 * example) call `/api/v1/...`; the dashboard, which always ships with the
 * server, keeps calling `/api/...`, which is always the newest version.
 *
 * Today `/api/v1/...` and `/api/...` are the same routes: a versioned URL is
 * rewritten before routing, so nothing is registered twice. When a breaking
 * change is needed, the old shape stays available under its version number
 * (see "API versions" in server/README.md).
 */

/** Every version this server serves, oldest first. */
export const API_VERSIONS: readonly number[] = [1];
export const CURRENT_API_VERSION = API_VERSIONS[API_VERSIONS.length - 1]!;

const VERSIONED_PATH = /^\/api\/v(\d+)(?=[/?]|$)/;

/**
 * The URL Fastify should route: `/api/v1/library?x` becomes `/api/library?x`.
 * URLs for versions this server doesn't serve are left as they are, so they
 * reach the not-found handler, which explains.
 */
export function routeUrlFor(url: string): string {
  const match = VERSIONED_PATH.exec(url);
  if (!match || !API_VERSIONS.includes(Number(match[1]))) {
    return url;
  }
  return `/api${url.slice(match[0].length)}`;
}

/** The version a URL asks for, when it asks for one this server lacks. */
export function unsupportedVersion(url: string): number | undefined {
  const match = VERSIONED_PATH.exec(url);
  if (!match) return undefined;
  const version = Number(match[1]);
  return API_VERSIONS.includes(version) ? undefined : version;
}

/**
 * Optional parts of the API a client can check for in `GET /api/meta`
 * before using them. Names are only ever added; a feature that goes away
 * does so in a new API version.
 */
export const API_FEATURES: readonly string[] = [
  "playback",
  "profiles",
  "release-search",
  "requests",
  "stats",
  "vpn-check",
];

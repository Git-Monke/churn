---
type: Backend Architecture
title: Dashboard backend architecture
description: Composition and request lifecycle of the Fastify backend-for-frontend that serves the churn SPA and brokers all Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent and VPN access.
tags: [backend, fastify, configuration, security, bff]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-eb3a4811a02a8c92fe31b44a
    resource: repo://server/backend/src/config.ts
  - id: openwiki-source-0a91f87754e49180fe8db10b
    resource: repo://server/backend/src/http.ts
  - id: openwiki-source-d039e250fc7625bc94095e3c
    resource: repo://server/backend/src/index.ts
  - id: openwiki-source-b4a52f3c3893a4697b46c7af
    resource: repo://server/backend/src/lan.ts
  - id: openwiki-source-ee79bc1f779a1ae3149c923c
    resource: repo://server/backend/src/routes/health.ts
  - id: openwiki-source-be77ce8f5c96454fdf2b3376
    resource: repo://server/backend/src/server.ts
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Dashboard backend architecture

`server/backend` is a Fastify 5 application that plays two roles at once:

- **API backend-for-frontend (BFF):** the SPA only talks to `/api/*`; the backend holds the upstream URLs, API keys and Jellyfin session tokens.
- **Static web server:** in production it serves the built `server/frontend/dist` SPA from the same origin.

It deliberately has no database. Temporary state lives in memory and is persisted only where `auth-state.json`-style durability matters.

## Build and startup sequence

`buildServer(config, { logger })` in `server/backend/src/server.ts` performs the whole composition:

1. Creates the Fastify instance and ensures `config.stateDir` exists.
2. Constructs process-wide collaborators:
   - `sessionStore` (profiles, sessions, persistence),
   - `loginThrottle`,
   - `releaseEvents` (recent automatic re-pick events),
   - `mediaCache` (arr metadata),
   - `introDb` service with its own cache,
   - `mediaAttribution` store (who added a title),
   - `releaseSearch` service with a Prowlarr cache directory,
   - `libraryScan` watcher, started immediately.
3. Registers an `onClose` hook that stops the watcher, flushes and closes the session store.
4. Installs the error handler, cookie plugin, authentication/CSRF middleware, route modules and static-file handling.

`server/backend/src/index.ts` is the executable entrypoint: it loads config, builds the app with logging, logs which Jellyfin public-URL mode is active, listens on `config.host:config.port`, and closes the app on `SIGINT`/`SIGTERM`.

The container health check calls `GET /api/health`, which only reports `{ status: "ok" }` and is on the public allowlist.

## Configuration resolution

`loadConfig()` in `server/backend/src/config.ts`:

1. Resolves the server directory: `CHURN_SERVER_DIR` if set, otherwise the directory two levels above the compiled module (`src/` or `dist/`).
2. Reads `server/.env` with dotenv (unless disabled for tests) and merges it **under** `process.env`, so process environment wins.
3. Builds service configs for Jellyfin, Sonarr and Radarr using URL defaults `http://127.0.0.1:8096`, `:8989`, `:7878`, plus qBittorrent `:8080`, Prowlarr `:9696`, IntroDB `https://api.introdb.app` and the VPN status agent `:8098`.
4. Resolves API keys in this order: environment override, then generated config files:
   - Sonarr/Radarr `<ApiKey>` from `server/config/<service>/config.xml`.
   - qBittorrent `[WebUI] APIKey` from `../torrent/config/qbittorrent/...`, with the legacy `WebUI\APIKey` accepted.
   - Prowlarr `<ApiKey>` from `../torrent/config/prowlarr/config.xml`.
5. Validates numeric settings and throws at startup for invalid values.

Timeout defaults are deliberately differentiated:

| Setting | Default | Valid range |
| --- | --- | --- |
| `REQUEST_TIMEOUT_MS` | 5000 | 250–60000 |
| `SEARCH_TIMEOUT_MS` | 20000 | 1000–120000 |
| `RELEASE_TIMEOUT_MS` | 120000 | 30000–300000 |
| `INTRODB_TIMEOUT_MS` | 5000 | 250–60000 |
| `VPN_STATUS_TIMEOUT_MS` | 25000 | 1000–120000 |

`PORT` defaults to 4000, `HOST` to `127.0.0.1`, `frontendDist` to `<serverDir>/frontend/dist`, and `stateDir` to `<serverDir>/.churn-state`.

### Browser-facing URLs vs backend URLs

Upstream calls always use the configured service URLs (`127.0.0.1` inside the host-networked dashboard container). URLs handed to the browser go through `serviceUrlForRequest`, which:

- returns an explicit `<ID>_PUBLIC_URL` verbatim when set;
- otherwise rewrites loopback, `localhost` and single-label Docker hostnames to the hostname the browser used (`X-Forwarded-Host`, `Forwarded: host=`, then `Host`);
- falls back to the detected LAN address (`lan.ts`) when no request host is available.

This is what makes the same deployment work through a LAN IP, Tailscale IP or MagicDNS name. `JELLYFIN_PUBLIC_URL` additionally hard-pins the video-stream base URL through `jellyfinPublicUrlForRequest`.

LAN detection prefers private RFC1918 addresses, then public addresses, then CGNAT, and penalizes virtual interfaces (`docker`, `veth`, `tun`, `tailscale`, `wg`, ...). `CHURN_HOST_IP` overrides detection.

## Error envelope

`server.ts` installs a single error handler:

| Thrown | Response |
| --- | --- |
| `ApiError(statusCode, code, message)` | That status, `{ error: { code, message } }` |
| `UpstreamError` | `502 { error: { code: "upstream_error", message } }` |
| Anything else | Logged; `500 internal_error` |

Upstream errors are produced by `server/backend/src/http.ts`, which wraps `fetch` with `AbortSignal.timeout` and maps timeouts/unreachable hosts, non-2xx responses and invalid JSON into `UpstreamError` instances with a `service`, `kind` and optional HTTP `status`. Error messages are constructed to be safe to show to the browser; upstream API keys never appear in them.

## Request middleware

`await app.register(cookie)` adds cookie parsing. Then a single `onRequest` hook handles every `/api/*` request:

- Non-GET/HEAD/OPTIONS requests from a different origin are rejected with `403 cross_origin_request`. Origin comparison includes reverse-proxy headers.
- Six public endpoints bypass authentication: `GET /api/health`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`, `GET /api/auth/profiles` and `POST /api/auth/profile-login`.
- Everything else requires a session record; the hook decorates `request.auth` with user, Jellyfin token, device id, kind, profile id and a `destroySession` callback.

<!-- openwiki: broken internal link [/openwiki/dashboard/auth-and-profiles.md] link "/openwiki/dashboard/auth-and-profiles.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
The authentication details are in [Authentication, sessions and household profiles](/openwiki/dashboard/auth-and-profiles.md).

## Route modules

Each route family is a `register*Routes` function invoked from `buildServer`:

| Module | Surface |
| --- | --- |
| `routes/health.ts` | Liveness only |
| `routes/auth.ts`, `routes/profiles.ts` | Login, session, logout, managed profiles |
| `routes/status.ts` | Jellyfin/Sonarr/Radarr health and browser-facing URLs |
| `routes/stats.ts` | qBittorrent transfer totals and disk usage |
| `routes/vpn.ts` | VPN exit identity, leak checks and sidecar coverage |
| `routes/library.ts` | Jellyfin library, continue watching, item deletion, images |
| `routes/requested.ts` | Titles tracked in Sonarr/Radarr but not yet in Jellyfin |
| `routes/movies.ts` | Movie detail, releases, grabs, live download status and cancellation |
| `routes/shows.ts` | Show detail, seasons/episodes, releases, grabs and episode cancellation |
| `routes/search.ts` | Cross-service media search and artwork proxying |
| `routes/requests.ts` | Request options and creation |
| `routes/activity.ts` | Aggregated active downloads plus recent re-picks |
| `routes/services.ts` | Safe redirects to upstream UIs |
| `routes/playback.ts` | Playback item, HLS/stream redirects, report endpoints |

The dependency graph is explicit: `buildServer` passes only the collaborators a route family needs, which keeps upstream clients out of modules that do not use them.

## Static SPA and fallback behaviour

If `<frontendDist>/index.html` exists, `@fastify/static` serves that directory with `wildcard: false`. The custom not-found handler then decides:

- `/api/*` unknown paths return `404 { error: { code: "not_found" } }`.
- If the frontend was not built, non-API requests return `503 frontend_not_built`.
- Non-GET/HEAD requests return 404.
- Otherwise the handler sends `index.html`, so client-side hash routes load the SPA shell.

## Writable cache selection

The Jellyfin-owned `server/cache` directory may be root-owned on an installed stack. `resolveReleaseCacheDir` tries, in order:

1. `<serverDir>/cache/releases`,
2. `<serverDir>/.churn-cache/releases`,
3. `<tmpdir>/churn-releases`,

and picks the first directory it can create and write. Release snapshots and media metadata therefore survive restarts when one of the persistent paths is writable, and degrade to temporary storage otherwise.

## Tests worth reading

`server/backend/test/routes.test.ts` exercises the HTTP surface end to end with mocked upstreams (health, status, stats, VPN, library, continue watching, requested library, deletion/cancellation). `server/backend/test/config.test.ts` covers URL resolution and configuration defaults. Client construction and timeout behaviour are covered in the per-upstream test files.

## Related pages

<!-- openwiki: broken internal link [/openwiki/dashboard/auth-and-profiles.md] link "/openwiki/dashboard/auth-and-profiles.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Authentication, sessions and household profiles](/openwiki/dashboard/auth-and-profiles.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/upstream-integrations.md] link "/openwiki/dashboard/upstream-integrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Upstream integrations and upstream state](/openwiki/dashboard/upstream-integrations.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/frontend.md] link "/openwiki/dashboard/frontend.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Dashboard frontend](/openwiki/dashboard/frontend.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)

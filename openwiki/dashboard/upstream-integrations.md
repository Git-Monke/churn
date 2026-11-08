---
type: Integration Design
title: Upstream integrations and upstream state
description: The client layer between the dashboard and Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent and the VPN status agent, including credential discovery, timeouts, error classification and the status/stats/VPN health endpoints.
tags: [integrations, jellyfin, sonarr, radarr, prowlarr, qbittorrent, health]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-eb3a4811a02a8c92fe31b44a
    resource: repo://server/backend/src/config.ts
  - id: openwiki-source-0a91f87754e49180fe8db10b
    resource: repo://server/backend/src/http.ts
  - id: openwiki-source-fae642600d2366bfa431bae4
    resource: repo://server/backend/src/routes/stats.ts
  - id: openwiki-source-4f652240c214a8654f68b561
    resource: repo://server/backend/src/routes/status.ts
  - id: openwiki-source-39511b7369a81eb7b963d1fe
    resource: repo://server/backend/src/stats.ts
  - id: openwiki-source-ab3df65326753202b5ebe24c
    resource: repo://server/backend/src/upstream/jellyfin.ts
  - id: openwiki-source-50093b9ff558f1576baf2955
    resource: repo://server/backend/src/upstream/prowlarr.ts
  - id: openwiki-source-90fe4c71fe992ea52f962895
    resource: repo://server/backend/src/upstream/qbittorrent.ts
  - id: openwiki-source-7022fa924048466bed775d18
    resource: repo://server/backend/src/upstream/servarr.ts
  - id: openwiki-source-60b55bf6d29e76af28b2541d
    resource: repo://server/backend/src/upstream/states.ts
  - id: openwiki-source-06c54f77f3b5abb584b2f409
    resource: repo://server/backend/src/upstream/vpn.ts
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Upstream integrations and upstream state

The backend is the only component that talks to upstream services. The SPA calls `/api/*`; the backend holds API keys, user tokens and internal URLs, and returns browser-safe state objects instead of raw upstream responses.

All upstream access goes through `server/backend/src/upstream/*` and the shared `http.ts` helpers.

## Shared HTTP and error model

`fetchWithTimeout` wraps `fetch` with `AbortSignal.timeout(timeoutMs)` and converts:

- timeout/abort → `UpstreamError(service, "unreachable", "<service> did not respond in time")`
- other network failure → `UpstreamError(service, "unreachable", ...)`

`fetchJson` adds JSON headers, sends an optional JSON body, and throws:

- `UpstreamError(service, "unauthorized", "<service> rejected the API key", status)` for 401/403,
- `UpstreamError(service, "http", "<service> returned HTTP <status>: <detail>", status)` for other non-2xx responses,
- `UpstreamError(service, "invalid_response", ...)` when the body is not JSON.

`deleteRequest` handles Sonarr/Radarr's empty-body deletes. `upstreamResponseError` extracts concise arr error messages for the browser.

`upstream/states.ts` reduces an error to `"unauthorized"` or `"unreachable"` for status cards, and only exposes `UpstreamError` messages; unknown errors become a generic "Service check failed".

## Credential discovery

The backend resolves keys once at startup in `loadConfig` (`config.ts`):

| Service | Environment override | Generated fallback |
| --- | --- | --- |
| Jellyfin | `JELLYFIN_API_KEY` | churn writes it to `server/.env` after first-run setup |
| Sonarr | `SONARR_API_KEY` | `<sonarr-config>/config.xml` `<ApiKey>` |
| Radarr | `RADARR_API_KEY` | `<radarr-config>/config.xml` `<ApiKey>` |
| Prowlarr | `PROWLARR_API_KEY` | `torrent/config/prowlarr/config.xml` `<ApiKey>` |
| qBittorrent | `QBITTORRENT_API_KEY` | `[WebUI] APIKey` in the seeded `qBittorrent.conf`, with the legacy `WebUI\APIKey` accepted |

The backend mounts the other stack's config read-only, so key discovery works without copying secrets. Keys are never included in API responses or error messages.

## Jellyfin client

`createJellyfinClient(config, timeoutMs, token?, options?)`:

- Sends `X-Emby-Token`, `X-Emby-Client: Churn`, `X-Emby-Device-Name`, `X-Emby-Device-Id` and a client version on authenticated calls.
- Uses an `Authorization: MediaBrowser Client=..., Device=..., DeviceId=..., Version=...` header for `Users/AuthenticateByName`, because login has no token yet.
- Accepts a token per call site: admin API key for provisioning-style reads, or the signed-in user's access token for library, resume, playback and item lookups.

Notable behaviours:

- `getPublicInfo` is unauthenticated and tells whether the startup wizard is complete.
- `listLibrary` enumerates the user's views and queries only items inside those views, deduplicating them. A global recursive query would include orphaned Jellyfin records left behind after a library path was removed.
- `getSeasons`, `getEpisodes`, `listResumeItems`, `listNextUpItems`, `listPlayedEpisodes` and `listItemsByType` shape listing queries for the dashboard.
- `getPlaybackInfo`, report start/progress/stop, `refreshLibrary`, `deleteItem` and `getItemImage` cover the remaining mutation/read paths.
- Image responses are size-limited (`MAX_IMAGE_BYTES` 15 MB) and returned as `{ body, contentType }` for the image proxy.

## Sonarr and Radarr client

Both use `X-Api-Key` against `/api/v3` through one `createArrClient(service, config, timeoutMs)`:

- status, series/movie lookup and listing,
- `/parse` release-name parsing,
- quality profiles, root folders, disk space and indexers,
- queue listing and queue-record deletion,
- series/movie get/delete,
- history since a timestamp (`downloadFolderImported` events),
- episodes and season/episode/movie release lists,
- `runCommand` and `grabRelease`,
- add/update series and movies,
- remote image fetch with a 15 MB cap.

Delete helpers always send `deleteFiles=true` unless the caller says otherwise; cancellation code depends on this.

## Prowlarr client

Uses `X-Api-Key`:

- `GET /api/v1/indexer` lists indexers.
- `GET /api/v1/search?query=...&indexerIds=<one>&type=search&limit=100&categories=...` searches **one** indexer at a time.

Fan-out across indexers is done by the release-search service, not by Prowlarr, so each indexer gets its own progress/error state.

## qBittorrent client

Uses the seeded API key as `Authorization: Bearer <key>`:

| Method | Endpoint | Notes |
| --- | --- | --- |
| `getTorrents` | `GET /api/v2/torrents/info` | live progress/state |
| `getMainData` | `GET /api/v2/sync/maindata` | all-time totals and free space |
| `addTorrent` | `POST /api/v2/torrents/add` | form-encoded magnet/URL, save path, category, tags, `autoTMM`, `contentLayout` |
| `addTags` | `POST /api/v2/torrents/addTags` | tag existing torrents without changing state |
| `removeTorrent` | `POST /api/v2/torrents/delete` | `deleteFiles` is explicit; cleanup normally removes the torrent and keeps files |

`addTorrent` treats `Ok.` and an empty body as success, accepts both the legacy text response and the newer JSON counts, and rejects a response where nothing was added or pending. `normalizeInfoHash` strips an optional `urn:btih:` prefix so hashes match regardless of representation.

## VPN status agent client

`createVpnClient` calls the loopback `vpn-status` agent at `/status` with `VPN_STATUS_TIMEOUT_MS` (default 25 s, because the agent runs external probes).

`mapVpnStatus` is deliberately strict: it requires `checkedAt`, `durationMs`, `secure`, all five boolean checks, DNS nameservers, firewall direct-egress state, IPv6 state and a coverage array. A missing or malformed field becomes `UpstreamError("vpn", "invalid_response", ...)`. It then produces browser-safe labels/details for:

- `mullvad_exit`
- `kill_switch`
- `dns`
- `ipv6`
- `firewall_exception`

and coverage for qBittorrent, Prowlarr and FlareSolverr.

## Health endpoints

### `GET /api/status`

Probes all three media services in parallel:

- Jellyfin `System/Info/Public`, then `System/Info` when an API key exists. A completed-wizard check makes a fresh Jellyfin `unconfigured`; a missing key also reports `unconfigured`.
- Sonarr/Radarr `GET /api/v3/system/status` with their keys.

Each result includes `id`, `name`, state (`ok`/`unconfigured`/`unauthorized`/`unreachable`), optional version, detail and measured latency. The returned `url` is rewritten with `serviceUrlForRequest`, so the browser receives a LAN/tailnet/MagicDNS address rather than `127.0.0.1`.

### `GET /api/stats`

Combines two independent sources with `Promise.allSettled`:

- qBittorrent `server_state` for all-time downloaded/uploaded bytes and free space,
- Sonarr or Radarr `/diskspace` plus `/rootfolder` for total capacity, trying Sonarr first and falling back to Radarr.

`selectDiskSpace` prefers a mount that contains one of the configured root folders and then the largest reported total. Free space prefers qBittorrent's value (it is the filesystem downloads actually land on) when it is valid, otherwise the arr value. Either source failing adds an entry to `errors` but still returns the other half.

### `GET /api/vpn`

Returns the mapped agent status directly. An invalid agent payload becomes `502 invalid_response`; an unreachable agent becomes the standard `502 upstream_error`. The endpoint requires a dashboard session like every other non-public API.

## Failure semantics

- A dashboard route usually degrades instead of failing: status, stats, library, search and activity keep the healthy half of their data and include a state/detail.
- Mutations (grab, request, delete, profile update) propagate `ApiError`/`UpstreamError` so the user sees a failure.
- An upstream 401 is treated as a session/credential problem, never as "service down".

## Relevant tests

`server/backend/test/jellyfin.test.ts`, `servarr.test.ts`, `qbittorrent.test.ts`, `config.test.ts`, `stats.test.ts` and the status/VPN sections of `routes.test.ts` cover credential discovery, request shaping, error mapping, partial stats and strict VPN payload validation.

## Related pages

<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Dashboard backend architecture](/openwiki/dashboard/backend-architecture.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/release-discovery.md] link "/openwiki/dashboard/release-discovery.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Release discovery and ranking](/openwiki/dashboard/release-discovery.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/downloads-and-sync.md] link "/openwiki/dashboard/downloads-and-sync.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Downloads, activity and library sync](/openwiki/dashboard/downloads-and-sync.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)

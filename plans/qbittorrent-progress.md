# qBittorrent-backed live download progress

## Context

Library cards poll `/api/activity` every 500 ms while downloads are active, but
the numbers still move slowly because Sonarr/Radarr only refresh their queue
view from qBittorrent on their own schedule. The server already has a safe path
to qBittorrent:

- gluetun publishes qBittorrent's WebUI on host port `8080`; the backend on the
  host reaches it at `http://127.0.0.1:8080`.
- `qbittorrent-init` seeds a stable `[WebUI] APIKey=qbt_…` in
  `torrent/config/qbittorrent/qBittorrent/QBittorrent.conf` (mode 644).
- `prowlarr-init.sh` already authenticates with
  `Authorization: Bearer <key>`.

The goal is to overlay qBittorrent's live torrent progress, ETA and download
speed onto the existing Library activity items, without exposing the API key to
the browser and without loosening the VPN jail. If qBittorrent is unavailable,
behaviour falls back to today's Sonarr/Radarr numbers.

## Decisions

- Scope: **Library activity only**. No changes to ShowPage or the Services page.
- Key source: **`QBITTORRENT_API_KEY` override, otherwise read the seeded
  qBittorrent config file**. No installer change required.
- Cards show **live download speed** in addition to progress/ETA.
- Keep the WebUI published as `0.0.0.0:8080`; document the existing exposure
  rather than changing compose/network settings.

## Approach

1. **Read-only qBittorrent client** (`upstream/qbittorrent.ts`)
   - `GET /api/v2/torrents/info` only, with
     `Authorization: Bearer <key>`.
   - No generic proxy and no mutating endpoints (add/delete/pause).
   - Short timeout: `min(config.requestTimeoutMs, 2000)` so a wedged qBittorrent
     cannot stall `/api/activity`.
   - Return the fields we need: `hash`, `infohash_v1`, `infohash_v2`,
     `progress` (0–1), `size`, `amount_left`, `dlspeed`, `eta`, `state`.
   - Reuse `fetchJson`, `fetchWithTimeout`, `UpstreamError` and
     `isUnauthorized` from `http.ts` / `errors.ts`. Widen the upstream service
     label type to include `"qbittorrent"` without adding it to `ServiceId`
     (so `/api/status`, `/api/services/:id/open` and the Services UI are
     untouched).

2. **Config resolution** (`config.ts`)
   - Add `qbittorrent: { url: string; apiKey?: string }` to `AppConfig`.
   - `QBITTORRENT_URL` default `http://127.0.0.1:8080`.
   - `QBITTORRENT_API_KEY` wins; otherwise parse
     `<serverDir>/../torrent/config/qbittorrent/qBittorrent/qBittorrent.conf`.
   - Parse exactly like `qbittorrent-init.sh` / `prowlarr-init.sh`:
     `[WebUI]` section `APIKey=`, falling back to legacy
     `WebUI\APIKey=` under `[Preferences]`.
   - Reuse the `cleanApiKey` / `nonEmpty` / `normalizeUrl` helpers.

3. **Pure overlay** (`torrent-progress.ts`, new)
   - `indexTorrents(torrents)` keyed by lowercased `hash`, `infohash_v1` and
     `infohash_v2`.
   - `applyTorrentProgress(records, index)` returns cloned records. Only
     records with `protocol === "torrent"`, an active arr state and a
     `downloadId` matching an index entry are changed.
   - Overlay:
     - `size = torrent.size` when > 0
     - `sizeleft = round(size * (1 - progress))` (prefer
       `amount_left` when it is a valid non-negative number)
     - `timeleft = formatDuration(eta)` when `0 < eta < 8640000`
       (`8640000` is qBittorrent's “infinite” sentinel)
     - `downloadSpeed = dlspeed` (bytes/s)
   - Keep arr's `status`, `trackedDownloadStatus`, `trackedDownloadState`,
     `downloadClient`, quality and status messages. That preserves importing,
     warnings and failures.
   - Ignore usenet records, unmatched hashes and torrents outside the arr queue
     (e.g. the `prowlarr` category).

4. **Wire into the activity feed** (`activity-feed.ts`)
   - Fetch both arr queues and qBittorrent in parallel once per snapshot:
     `Promise.all([loadQueue("sonarr"), loadQueue("radarr"), loadQbittorrent()])`.
   - `loadQbittorrent()` returns an empty map when the key is missing or the
     request fails, so the feed always succeeds.
   - Apply the overlay to the filtered active records before
     `mapSeriesActivity` / `mapMovieActivity`.
   - Existing snapshot cache (400 ms) and single-flight already cap this at
     roughly two qBittorrent reads per second across all tabs. `torrents/info`
     is local and small; `sync/maindata` is not needed for now.

5. **Speed in the activity shape**
   - Add `downloadSpeed?: number` to `ServarrQueueRecord` as an overlay-only
     field (commented as not coming from the arr API).
   - `aggregateQueueRecords` sums speeds over `uniqueQueueDownloads` so season
     packs counted once; expose `downloadSpeedBytes?: number` on
     `ActivityAggregate` / `ActivityItem`.
   - Mirror the optional field in the frontend `ActivityItem` type.
   - In `LibraryGrid.downloadSource`, append a formatted speed
     (`5.2 MB/s`) when present and the item is downloading; reuse the existing
     `formatBytes` style and add a tiny `formatSpeed` helper.

6. **Docs**
   - `server/README.md`: add `QBITTORRENT_URL` / `QBITTORRENT_API_KEY`, explain
     the config-file fallback and read-only use.
   - `docs/src/web-ui.md`: note that Library torrent progress/ETA/speed comes
     from qBittorrent and falls back to arr values.
   - `docs/src/torrent.md`: note that the WebUI is LAN-published over plain HTTP
     with an API key; churn uses it read-only from the host and never exposes
     the key to the browser.

## Files to modify

- `server/backend/src/upstream/qbittorrent.ts` (new) — torrent types + client.
- `server/backend/src/torrent-progress.ts` (new) — hash index + overlay.
- `server/backend/src/config.ts` — qBittorrent URL/key + config-file parser.
- `server/backend/src/errors.ts`, `http.ts` — widen upstream service label.
- `server/backend/src/activity.ts` — speed aggregation + item field.
- `server/backend/src/activity-feed.ts` — parallel qBittorrent load + overlay.
- `server/backend/src/types.ts`, `server/frontend/src/api/types.ts` — optional
  `downloadSpeedBytes`.
- `server/frontend/src/features/library/LibraryGrid.tsx` — show speed.
- `server/backend/test/config.test.ts`, `activity.test.ts`,
  `activity-feed.test.ts` (plus new `torrent-progress.test.ts` /
  `qbittorrent.test.ts`) — coverage.
- `server/README.md`, `docs/src/web-ui.md`, `docs/src/torrent.md`.

Test helpers that build `AppConfig` (`routes.test.ts`, `auth.test.ts`,
`activity-feed.test.ts`) gain the new `qbittorrent` field.

## Reuse

- `server/backend/src/http.ts` — `fetchJson` / `fetchWithTimeout`.
- `server/backend/src/errors.ts` — `UpstreamError`, `isUnauthorized`.
- `server/backend/src/activity.ts` — `filterActiveQueueRecords`,
  `aggregateQueueRecords`, `uniqueQueueDownloads`, progress/status mapping.
- `server/backend/src/config.ts` — `readApiKeyFromConfigXml` pattern,
  `cleanApiKey`, `normalizeUrl`.
- `server/backend/src/activity-feed.ts` — snapshot cache + single-flight.
- `server/frontend/src/features/library/LibraryGrid.tsx` — `downloadEta`,
  `formatBytes`, `downloadSource`.
- `torrent/scripts/qbittorrent-init.sh` / `prowlarr-init.sh` — key parsing and
  Bearer-header conventions.

## Steps

- [x] Add `qbittorrent` config (env + config-file fallback) and parser tests.
- [x] Widen the upstream service label; add the qBittorrent client.
- [x] Add `torrent-progress.ts` with hash indexing, overlay and unit tests.
- [x] Add `downloadSpeed` aggregation + `downloadSpeedBytes` to activity types.
- [x] Fetch qBittorrent once per snapshot in `activity-feed.ts`, fail soft.
- [x] Show speed on Library cards.
- [x] Update docs.
- [x] Run typecheck, tests and production build.

## Verification

- `cd server && npm test && npm run typecheck && npm run build`.
- Unit tests:
  - env key wins over file; file key parsed from `[WebUI]` and legacy path.
  - qBittorrent request uses the Bearer header and read-only path.
  - overlay updates progress/size/ETA/speed for a matching torrent hash.
  - usenet, unmatched hashes and unmatched categories are untouched.
  - importing/warning arr status survives the overlay.
  - qBittorrent failure or missing key leaves arr values and the route healthy.
  - season-pack speed is counted once.
- Manual:
  - `curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/api/v2/torrents/info`
    to confirm the key/path.
  - Start a torrent; Library card progress, ETA and speed update every 500 ms.
  - Stop qBittorrent; Library still renders arr progress after the timeout.
  - Check `/api/activity` JSON/network tab for any key leakage (must be none).
  - Re-run `torrent/scripts/vpn-check.sh` / `docker compose up -d` to confirm
    the VPN jail and published-port behaviour are unchanged.

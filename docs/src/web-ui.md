# Web dashboard

The dashboard is a TypeScript app under `server/` with two workspaces. It has
three pages — Services, Library and Search — selected by hash routes
(`#/services`, `#/library`, `#/search`). Services has **Services** and **VPN**
tabs; the VPN tab runs a live leak test when opened and on demand.

```
server/backend/    Fastify API, also serves frontend/dist
server/frontend/   React + Vite SPA
```

The backend is a BFF. It calls Jellyfin, Sonarr and Radarr and keeps no
database. The browser only requests `/api/*`; API keys and upstream service URLs
are never sent to it. Login sessions live in process memory, so restarting the
backend signs everyone out. The app binds to `127.0.0.1` by default and requires
a Jellyfin login.

## Running it

```bash
cd server
npm install
npm run dev        # UI http://127.0.0.1:5173, API http://127.0.0.1:4000
```

Vite proxies `/api` to Fastify in development. For a single production server:

```bash
cd server
npm run build
npm start          # http://127.0.0.1:4000
```

## Configuration

`server/.env` is read after the process environment, so real environment
variables win. Churn preserves keys it does not manage, so hand-added settings
survive a rerun.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Backend bind address |
| `PORT` | `4000` | Backend port |
| `JELLYFIN_URL` | `http://127.0.0.1:8096` | Jellyfin base URL used by the backend |
| `JELLYFIN_PUBLIC_URL` | `JELLYFIN_URL` | Browser-facing Jellyfin URL for video playback |
| `JELLYFIN_API_KEY` | — | Written by churn after Jellyfin setup |
| `JELLYFIN_ADMIN_USER` | `admin` | Optional non-interactive setup username |
| `JELLYFIN_ADMIN_PASSWORD` | — | Optional non-interactive setup password |
| `SONARR_URL` / `RADARR_URL` | localhost ports | Arr base URLs |
| `SONARR_API_KEY` / `RADARR_API_KEY` | `config.xml` | Optional overrides |
| `VPN_STATUS_URL` | `http://127.0.0.1:8098` | Loopback address of the torrent stack's VPN status agent |
| `VPN_STATUS_TIMEOUT_MS` | `25000` | Timeout for the agent's live checks |
| `REQUEST_TIMEOUT_MS` | `5000` | Upstream timeout |
| `CHURN_SESSION_TTL_MS` | `43200000` (12 hours) | Server-side idle session TTL; clamped to 5 minutes–30 days |
| `CHURN_COOKIE_SECURE` | `auto` | `auto`, `true` or `false` for the session cookie's `Secure` flag |
| `CHURN_SERVER_DIR` | module-relative | Override `server/` root |

Churn completes Jellyfin's first-run setup after starting the server stack. It
asks for a Jellyfin admin username and password when none is configured yet,
creates the first admin, completes the wizard with remote access disabled, and
creates an API key named `churn`. The key is written to `server/.env`:

```bash
JELLYFIN_API_KEY=<generated-key>
```

The admin password is not written to `.env`. Set `JELLYFIN_ADMIN_USER` and
`JELLYFIN_ADMIN_PASSWORD` in the environment for non-interactive setup. Reruns
reuse a valid existing key.

## Authentication

Churn uses Jellyfin as its account system. The login form posts a username and
password to the backend, which calls Jellyfin's `/Users/AuthenticateByName` and
stores the returned user access token in a server-side session. The browser gets
only an opaque `churn_session` cookie: `HttpOnly`, `SameSite=Lax`, path-scoped,
and `Secure` when served over HTTPS.

Sessions are a TTL Map in backend memory, keyed by a SHA-256 hash of the cookie
value. There is no database or session file. The default idle TTL is 12 hours;
restarting the backend signs everyone out. Signing out clears the cookie,
destroys the session and makes a best-effort Jellyfin logout call.

Library, show and image requests use the signed-in user's Jellyfin token, so
Jellyfin still enforces that user's library access. The Jellyfin API key remains
server-side for status checks. Every logged-in Jellyfin user gets the full
dashboard, including search, requests, release grabs, and cancel/delete actions,
which mutate global Sonarr/Radarr state. Churn does not add an admin-only gate;
use Jellyfin user permissions to limit library visibility.

Failed logins are throttled to 10 attempts per 15 minutes per IP and username.
Auth responses are `no-store`, and cross-origin mutating requests are rejected.
Playback uses the signed-in user's Jellyfin session token rather than a static
token in `.env`, so resume positions and watched state are per user.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Backend liveness (no session required) |
| `POST /api/auth/login` | Validate Jellyfin credentials and set the session cookie |
| `POST /api/auth/logout` | Destroy the session and clear the cookie |
| `GET /api/auth/session` | Current session state (200 when signed out) |
| `GET /api/status` | Service health, version and latency |
| `GET /api/vpn` | On-demand VPN leak test from the torrent stack's protected namespace |
| `GET /api/library` | Jellyfin movies and series with provider ids, scoped to the user's library views |
| `GET /api/library/images/:itemId` | Poster proxy |
| `GET /api/library/requested` | Sonarr/Radarr library titles, including requested items not yet downloaded |
| `DELETE /api/library/requested/:service/:id` | Cancel queue items, delete the title (and files) from the arr, refresh Jellyfin |
| `GET /api/library/shows/:source/:id` | Show seasons, episodes and download overlays |
| `GET /api/library/shows/:source/:id/releases?season=N` | Sonarr season release search, including rejected and multi-season packs |
| `POST /api/library/shows/:source/:id/releases/grab` | Grab a selected release with an override when Sonarr can map it |
| `GET /api/playback/items/:itemId` | Playable item metadata, resume position and same-origin stream URL |
| `GET /api/playback/items/:itemId/stream` | Redirect the media element to Jellyfin's direct stream URL for this session |
| `GET /api/playback/items/:itemId/hls.m3u8` | Redirect to a Jellyfin HLS transcode (H.264/AAC) when the source is not browser-compatible |
| `POST /api/playback/items/:itemId/start` | Report playback start to Jellyfin |
| `POST /api/playback/items/:itemId/progress` | Report position and paused state to Jellyfin |
| `POST /api/playback/items/:itemId/stop` | Report playback stop to Jellyfin |
| `GET /api/activity` | Active Sonarr/Radarr queue grouped by movie/show |
| `GET /api/search?q=<term>` | Sonarr/Radarr lookup with library-state markers |
| `GET /api/search/images/:service` | Proxied artwork (allowlisted CDN `remoteUrl`) |
| `GET /api/requests/options` | Quality profiles, root folders and defaults |
| `POST /api/requests` | Add a movie or series and optionally start a search |
| `GET /api/services/:id/open` | Redirect to a native service UI |

Errors use `{ "error": { "code": "...", "message": "..." } }`. The library route
returns HTTP 200 with an empty list and a setup state when Jellyfin is not ready;
unexpected backend failures are 5xx.

Jellyfin can keep orphaned items in its database after a library folder is
removed, and those records are still returned by a global
`/Items?Recursive=true` query. The backend therefore lists items per user view
(`/Users/{userId}/Views`, then `/Users/{userId}/Items?ParentId=...`) instead of
querying all items globally. Items outside the user's current libraries, such as
files from an in-progress download that was previously indexed, no longer appear.

## VPN status

The Services → VPN tab calls `GET /api/vpn`. The backend asks the torrent
stack's `vpn-status` agent to run the same checks as `vpn-check`: the public
exit must be Mullvad, direct `eth0` egress must be blocked, DNS must use
Gluetun's resolver, IPv6 must be disabled, and the firewall exception must be a
local address. The response also includes the exit IP, city/country, Mullvad
server hostname, and whether qBittorrent, Prowlarr and FlareSolverr answer on
their loopback ports inside the shared namespace.

The agent listens on `127.0.0.1:8098` only and is never exposed on the LAN. If
the torrent stack is not running, the tab shows an error with the command to
start it:

```bash
cd torrent && docker compose up -d --no-deps --force-recreate vpn-status
```

If Gluetun itself was recreated, recreate the whole torrent stack:
`docker compose down && docker compose up -d`.

## Search and requests

Searching runs a debounced query against Sonarr and Radarr at the same time. Each
result carries its metadata ids, rating, runtime, certification and a
backend-proxied poster. Titles already in the arr library are marked
**Available** when Radarr has a movie file or Sonarr has every episode, otherwise
**Requested**. This uses Sonarr `tvdbId` and Radarr `tmdbId` matches, not the
Jellyfin library.

**Request options** persists quality profile, root folder, TV monitoring,
search-on-add and a **Prefer smaller files** switch in `localStorage`. The
switch is on by default and auto-picks a 720p-only profile first, then a
combined 720p/1080p profile, then 1080p-only, avoiding 4K/Ultra-HD when anything
smaller exists. Turn it off to use the arr default (`HD - 720p/1080p`, then
`HD-1080p`, then `HD-720p`). The other defaults are the first accessible root
folder, all seasons and search on add. The Request button uses these settings
directly.

On `POST /api/requests` the backend re-fetches canonical metadata by id, checks
for duplicates, validates the profile and root folder against the live arr APIs,
then adds the title. Sonarr receives the selected monitoring scope; Radarr adds
with `released` minimum availability. When one app is unavailable, search and
request options still work for the other.

## Library and activity

`GET /api/activity` reads both arr v3 queues in parallel and keeps only active
records: queued, downloading, importing, or waiting on import. Failed and already
imported records are hidden. Records are grouped by movie or show with
aggregated progress, ETA, size, download client, protocol, quality and warning
messages. Posters come from arr metadata through the existing backend image
proxy.

The route reuses a short-lived snapshot (400 ms) and caches series/movie metadata
for five minutes, so polling is cheap: concurrent tabs share one upstream refresh
and repeat polls skip the per-title metadata requests. Library polls every 500 ms
while a download is active and backs off to every 2 s once the queue is empty,
which keeps progress bars moving without hammering Sonarr/Radarr.

For torrent downloads the feed also reads qBittorrent's read-only
`/api/v2/torrents/info` endpoint once per snapshot, matches records by torrent
hash, and overlays live progress, ETA and download speed. If qBittorrent is
unavailable or its key is not configured, the arr values remain. Usenet
downloads still follow Sonarr/Radarr's own queue refresh.

Library merges `/api/library`, `/api/library/requested` and `/api/activity`:

- movies and shows already in Jellyfin and active in an arr are matched by
  `tmdbId` / `tvdbId` and shown once;
- unmatched downloads appear as downloading-only cards;
- titles downloaded in Sonarr/Radarr but not yet in Jellyfin appear as
  **Available** cards;
- tracked titles with no downloaded file appear as **Requested** cards;
- active downloads come first;
- a failed arr shows a per-service alert without hiding Jellyfin or the other
  arr.

Cards backed by Sonarr or Radarr have a trash button. The confirmation dialog
calls `DELETE /api/library/requested/:service/:id`, which removes the title's
queue records with `removeFromClient=true`, deletes the movie or series with
`deleteFiles=true`, and triggers a best-effort Jellyfin library refresh. It
stops an in-progress download and removes the arr entry so the title can be
requested again with a smaller quality profile. Deleting a completed title also
deletes its files.

Movies show progress on the card. Shows link to
`#/library/show/<source>/<id>`, backed by
`GET /api/library/shows/:source/:id`. That route unions Jellyfin and Sonarr
episodes by season/episode, marks availability (Jellyfin, in Sonarr, missing,
upcoming), and overlays per-episode downloads. Sonarr season packs mark every
episode in the season. Jellyfin shows are matched to Sonarr through
`ProviderIds.Tvdb`; download-only shows use the Sonarr source directly.

Sonarr-backed shows also have a release picker per season. It searches the
indexers again and lists **all** results — automatic, rejected, single-season
and multi-season — with size, quality, indexer, seed count and rejection
reasons. **All seasons** runs the same search across the show's other seasons
and keeps multi-season packs that cover the selected season, which catches
packs such as `S01-05` that Sonarr indexes under Season 1. When no release is
automatic, the smallest mapped multi-season pack is recommended. Choosing a
release sends it to Sonarr with an override, so a pack like `S01-03` can be used
for season 1 when its size is acceptable. Upstream GUIDs and magnet URLs stay
on the backend.

Missing episodes have their own **Choose release** action. It searches by
Sonarr episode id rather than by season, so individual episode releases show up
even when no season pack exists.

After requesting a series, churn opens the picker immediately for the first
monitored season so release options appear without visiting the show page.
Sonarr's automatic search continues in the background, and the overlay stays
open with a retry action if no releases are returned.

## Playback

Movies in Library and episodes in show detail open `#/play/<itemId>`. The player
uses Jellyfin's per-user `UserData` to resume where you stopped, then sends
playback start/progress/stop reports so Jellyfin apps see the same position and
watched state.

Playback is codec-aware. Browser-compatible sources use a same-origin
`/api/playback/items/:itemId/stream` URL; the backend validates the session and
redirects to Jellyfin's `static=true` stream with the user's token. Sources the
browser cannot decode (for example HEVC/AC3 in an MKV) use
`/api/playback/items/:itemId/hls.m3u8`, which redirects to a Jellyfin HLS
transcode with H.264 video and AAC stereo audio at the source resolution. The
frontend plays HLS with `hls.js` and falls back to native HLS when available.

The token stays out of the page DOM and API responses but is visible to browser
devtools in redirect targets and Jellyfin HLS playlist/segment URLs; video bytes
still come directly from Jellyfin. Set `JELLYFIN_PUBLIC_URL` when the browser
reaches Jellyfin at a different address than the backend. Playback failures show
the media error alert with an **Open Jellyfin** fallback.

## Roadmap

1. Library + service status dashboard — done
2. Search and media requests — done
3. Active downloads in Library — done
4. Jellyfin login and per-user sessions — done
5. Download history and queue actions — next
6. Jellyfin playback/session controls — done

## Container note

Docker support is deferred. For a later container, set `HOST=0.0.0.0`, use
Compose service names for the URLs, pass keys in the environment, and mount
`server/config/{sonarr,radarr}` read-only if relying on `config.xml` discovery.

# Web dashboard

The dashboard is a TypeScript app under `server/` with two workspaces. It has
three pages — Services, Library and Search — selected by hash routes
(`#/services`, `#/library`, `#/search`). An empty or unknown hash lands on the
library (`#/library`). The selected season lives in the URL
(`#/library/show/<source>/<id>/season/<n>`), and the player records
where it was opened from so it can return to that season. Services has
**Services** and **VPN** tabs; the VPN tab runs a live test when opened and on
demand.

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
| `HOST` | `0.0.0.0` in the compose container | Backend bind address |
| `PORT` | `4000` | Backend port (`DASHBOARD_PORT` in compose) |
| `JELLYFIN_URL` | `http://127.0.0.1:8096` | Jellyfin base URL used by the backend |
| `JELLYFIN_PUBLIC_URL` | request host, LAN address as fallback | Browser-facing Jellyfin URL for video playback and service links |
| `SONARR_PUBLIC_URL` / `RADARR_PUBLIC_URL` | request host, LAN address as fallback | Browser-facing arr URLs for service links and redirects |
| `JELLYFIN_API_KEY` | — | Written by churn after Jellyfin setup |
| `JELLYFIN_ADMIN_USER` | `admin` | Optional non-interactive setup username |
| `JELLYFIN_ADMIN_PASSWORD` | — | Optional non-interactive setup password |
| `SONARR_URL` / `RADARR_URL` | localhost ports | Arr base URLs |
| `SONARR_API_KEY` / `RADARR_API_KEY` | `config.xml` | Optional overrides |
| `VPN_STATUS_URL` | `http://127.0.0.1:8098` | Loopback address of the torrent stack's VPN status agent |
| `VPN_STATUS_TIMEOUT_MS` | `25000` | Timeout for the agent's live checks |
| `REQUEST_TIMEOUT_MS` | `5000` | Upstream timeout for status probes and normal API calls |
| `SEARCH_TIMEOUT_MS` | `20000` | Timeout for media search and request-option lookups |
| `RELEASE_TIMEOUT_MS` | `120000` | Timeout for Sonarr/Radarr release lookups; direct grabs go to qBittorrent |
| `PROWLARR_URL` | `http://127.0.0.1:9696` | Prowlarr base URL for progressive release search |
| `PROWLARR_API_KEY` | `torrent/config/prowlarr/config.xml` | Optional Prowlarr API-key override |
| `INTRODB_URL` | `https://api.introdb.app` | IntroDB base URL for intro/recap/credits timestamps |
| `INTRODB_TIMEOUT_MS` | `5000` | Timeout for unauthenticated IntroDB reads |
| `CHURN_SESSION_TTL_MS` | `43200000` (12 hours) | Server-side idle session TTL; clamped to 5 minutes–30 days |
| `CHURN_STATE_DIR` | `server/.churn-state` (`/app/state` in the container) | Persisted profiles, sessions and added-by tags |
| `CHURN_COOKIE_SECURE` | `auto` | `auto`, `true` or `false` for the session cookie's `Secure` flag |
| `CHURN_SERVER_DIR` | module-relative | Override `server/` root |

Churn completes Jellyfin's first-run setup after starting the server stack. It
asks for a Jellyfin admin username and password when none is configured yet,
creates the first admin, completes the wizard with remote access disabled, and
creates an API key named `churn`. It also adds the private LAN ranges and
Tailscale's `100.64.0.0/10` range to Jellyfin's LAN networks, so tailnet clients
can stream directly from Jellyfin without enabling remote access. The key is
written to `server/.env`:

```bash
JELLYFIN_API_KEY=<generated-key>
```

The admin password is not written to `.env`. Set `JELLYFIN_ADMIN_USER` and
`JELLYFIN_ADMIN_PASSWORD` in the environment for non-interactive setup. Reruns
reuse a valid existing key.

## Authentication

Churn uses Jellyfin as its account system, with household profiles in front of
it. The login screen lists the people an admin has added. Selecting a profile
posts its password (or the one-time PIN on first use) to the backend, which
calls Jellyfin's `/Users/AuthenticateByName` and stores the returned user access
token in a server-side session. The browser gets only an opaque `churn_session`
cookie: `HttpOnly`, `SameSite=Lax`, path-scoped, and `Secure` when served over
HTTPS.

An admin signs in with a Jellyfin administrator account and opens **People** to
add a person. Churn creates a real Jellyfin user for that person and shows a
6-digit PIN next to them until their first login. The person enters the PIN,
then chooses their own password. Each person has a distinct Jellyfin user, so
watch progress stays separate. Deleting a person deletes their Jellyfin user
and history.

Sessions are a TTL map keyed by a SHA-256 hash of the cookie value, persisted
atomically to `CHURN_STATE_DIR/auth-state.json` (mode 0600) with the profiles.
Requests made through Churn also record who added each title in
`CHURN_STATE_DIR/media-attribution.json`. The default idle TTL is 12 hours and
slides on activity; dashboard restarts and `churn` reruns keep people signed in.
`churn uninstall` removes the `churn-state` volume. Signing out clears the
cookie, destroys the session and makes a best-effort Jellyfin logout call.

Each session has a unique Jellyfin device id, so multiple people (and multiple
browsers for the same person) can be signed in at once without revoking each
other's tokens.

Library, show and image requests use the signed-in user's Jellyfin token, so
Jellyfin still enforces that user's library access. The Jellyfin API key remains
server-side for status checks and user management. Every logged-in Jellyfin user
gets the full dashboard, including search, requests, release grabs, and
cancel/delete actions, which mutate global Sonarr/Radarr state. Only profile
management is admin-only; use Jellyfin user permissions to limit library
visibility.

Failed logins and PIN attempts are throttled to 10 attempts per 15 minutes per
IP and username/profile. Cross-origin mutating requests are rejected. Playback
uses the signed-in user's Jellyfin session token rather than a static token in
`.env`, so resume positions and watched state are per user.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Backend liveness (no session required) |
| `POST /api/auth/login` | Validate Jellyfin credentials and set the session cookie |
| `GET /api/auth/profiles` | Public profile picker list |
| `POST /api/auth/profile-login` | Sign in as a profile or complete first-login setup |
| `GET /api/profiles` | Admin: list people and pending PINs |
| `POST /api/profiles` | Admin: create a person and Jellyfin user |
| `POST /api/profiles/:id/pin` | Admin: reset a PIN and sign out that profile |
| `DELETE /api/profiles/:id` | Admin: delete a person and Jellyfin user |
| `POST /api/auth/logout` | Destroy the session and clear the cookie |
| `GET /api/auth/session` | Current session state (200 when signed out) |
| `GET /api/status` | Service health, version and latency |
| `GET /api/vpn` | On-demand VPN leak test from the torrent stack's protected namespace |
| `GET /api/library` | Jellyfin movies and series with provider ids and `addedBy`, scoped to the user's library views |
| `GET /api/library/images/:itemId` | Poster proxy |
| `GET /api/library/requested` | Sonarr/Radarr library titles with `addedBy`, including requested items not yet downloaded |
| `DELETE /api/library/requested/:service/:id` | Cancel queue items, delete the title (and files) from the arr, remove matching qBittorrent torrents, refresh Jellyfin |
| `DELETE /api/library/jellyfin/:itemId` | Delete a Jellyfin-only movie/show and its files, or use the matching arr title when one is found |
| `GET /api/library/shows/:source/:id` | Show seasons, episodes and download overlays |
| `GET /api/library/shows/:source/:id/downloads` | Lightweight per-episode qBittorrent stats, polled twice per second while downloading |
| `GET /api/library/movies/:source/:id/download` | Lightweight live qBittorrent stats for one movie, polled twice per second while downloading |
| `GET /api/library/shows/:source/:id/releases?season=N` | Progressive per-indexer Prowlarr search with live progress |
| `POST /api/library/shows/:source/:id/releases/refresh?season=N` | Start a fresh Prowlarr search |
| `POST /api/library/shows/:source/:id/releases/grab` | Send the chosen torrent or magnet directly to qBittorrent |
| `DELETE /api/library/shows/sonarr/:id/episodes/:season/:episode/download` | Cancel one episode's active download and blocklist the release |
| `GET /api/playback/items/:itemId` | Playable item metadata, resume position, quality presets and same-origin stream URL; `?quality=max\|high\|medium\|low` |
| `GET /api/playback/items/:itemId/stream` | Redirect the media element to Jellyfin's direct stream URL for this session |
| `GET /api/playback/items/:itemId/hls.m3u8` | Redirect to a Jellyfin HLS transcode (H.264/AAC) when the source is not browser-compatible; honours `?quality=` |
| `POST /api/playback/items/:itemId/start` | Report playback start to Jellyfin |
| `POST /api/playback/items/:itemId/progress` | Report position and paused state to Jellyfin |
| `POST /api/playback/items/:itemId/stop` | Report playback stop to Jellyfin |
| `GET /api/activity` | Active qBittorrent downloads grouped by local library title |
| `GET /api/search?q=<term>` | Sonarr/Radarr lookup with Jellyfin availability and local catalog markers |
| `GET /api/search/images/:service` | Proxied artwork (allowlisted CDN `remoteUrl`) |
| `GET /api/requests/options` | Quality profiles, root folders and defaults |
| `POST /api/requests` | Add a movie or series, cache metadata, and start its Prowlarr release search in the background |
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
backend-proxied poster. **Available** comes only from a matching Jellyfin item
(`tvdbId` / `tmdbId`). A title that is only in the Sonarr/Radarr catalog is
marked **Requested** so it remains selectable before anything downloads. Arr file
state and queue state are not used for availability.

**Request options** persists the quality profile and root folder in
`localStorage`. Requesting a title only adds it unmonitored; it never starts a
download. It starts the progressive Prowlarr release search in the background,
after caching the Radarr/Sonarr metadata for the title (including TMDB/TVDB ids
and seasons) under `server/cache/releases/media`. For a series, every regular
season is queued for a Prowlarr search immediately, in season order, so opening a
season usually finds its results already cached. Seasons Sonarr has already
completed are skipped.

Release search is Prowlarr-first. Opening a movie or season sends one search to
each enabled Prowlarr indexer in parallel. The chooser opens as soon as the first
usable result arrives, then keeps adding results as each indexer finishes, with
progress such as `5/9 indexers finished` and a chip per indexer. If the user has
not picked a tier, the chooser selects `1080p` when it is available, otherwise
steps down to `720p`, then `480p`, and only falls back to `2160p` when nothing at
or below 1080p exists. 4K is never the default while a lower tier is available.
Sonarr/Radarr's own `/api/v3/parse` endpoint supplies title/year,
season, episode and quality metadata used to filter unrelated releases. Options are grouped into the quality
tiers that actually have releases (`480p`, `720p`, `1080p`, `2160p`, `Other`)
and ordered by seeders, then size. The best-seeded release is shown first, with
**Show more options** to expand the tier.

Every enabled Prowlarr indexer is shown, including indexers that are not synced
to Sonarr/Radarr. A result with a torrent or magnet URL is downloaded directly
by qBittorrent; there is no second arr search or arr grab. Direct downloads are
tagged `churn-direct` and saved into the existing show/movie folder under
`/data/media`, so Jellyfin sees them without an arr import.

Snapshots persist in `server/cache/releases/prowlarr` (or
`server/.churn-cache/releases/prowlarr` when the container-owned `cache/`
directory is not writable) across backend restarts. Later opens show the
snapshot until **Search again** starts a fresh search. A tier whose best release
has fewer than 50 seeders displays a stale-results warning and a **Search again**
button.

Picking a release sends that exact torrent or magnet to qBittorrent. A movie is
saved in its Radarr movie folder; a single season or episode is saved under
`Show/Season N`; a multi-season pack is saved in the show folder. These direct
downloads are tagged `churn-direct`, so Sonarr monitoring and arr import are not
required. Episode level picking remains available for repairing one missing
episode: the episode chooser reuses the per-indexer Prowlarr season search and
narrows the cached results to that episode, so the same indexer progress and
direct qBittorrent grabs apply.
If qBittorrent has an older arr-managed download that Sonarr never queued, the
show page matches its filename to the series and season/episode and shows live
progress. Once that download finishes, churn asks Sonarr to scan its content
path; `churn-direct` downloads are already in the library and skip that scan.
A background watcher sees `churn-direct` torrents finish in qBittorrent and asks
Jellyfin to refresh, so direct downloads do not depend on Jellyfin's own
filesystem watcher.

On `POST /api/requests` the backend re-fetches canonical metadata by id, checks
for duplicates, validates the profile and root folder against the live arr APIs,
then adds the title unmonitored with no search command. Movie adds use
`released` minimum availability. When one app is unavailable, search and request
options still work for the other.

## Library and activity

`GET /api/activity` reads qBittorrent's active downloads and groups them by the
local Sonarr/Radarr catalog. It does not read the arr queues. Completed and
seeding torrents are excluded; queued, downloading and stalled downloads are
included, with progress, size, speed, ETA, season hints and warning messages
coming directly from qBittorrent. The route keeps a short-lived snapshot (400 ms)
and caches the catalog for five minutes, so polling stays cheap and concurrent
tabs share one refresh.

Library merges `/api/library` (Jellyfin), `/api/library/requested` (the local
arr catalog) and `/api/activity` (qBittorrent):

- **Available** and play links require a matching Jellyfin item;
- **Downloading** requires an active qBittorrent torrent;
- **Requested** means the title is in the local arr catalog but not Jellyfin or
  qBittorrent yet;
- **Scanning** is only a transitional, non-playable state while the arr has
  imported files and Jellyfin has not indexed them yet;
- active downloads sort before available titles;
- qBittorrent failures show a download notice without hiding Jellyfin, and arr
  failures only affect release search/request actions.

The Library toolbar has a search box that filters the grid in the browser: no
API call, no navigation. It matches every word of the query against the title,
and any word can instead hit the year, network, content rating, score or
overview, so `2021`, `hbo` or `spiders` work. Title hits are listed before
metadata-only hits, the type tabs and their counts follow the search, and
Escape or the clear button resets it.

**Added by me** is a separate toolbar toggle that composes with the search and
the type tabs. Requesting a title records the signed-in Jellyfin user as its
adder, and each card shows a small `Added by <name>` line. The toggle shows only
titles added by the current user; titles added directly in Sonarr, Radarr or
Jellyfin stay untagged. Deleting a title clears its attribution, and the tag is
stored by TMDB/TVDB id, so it is independent of the download client.

Every card has a trash button. Sonarr/Radarr-backed cards call
`DELETE /api/library/requested/:service/:id`, which removes the title's queue
records with `removeFromClient=true`, deletes the movie or series with
`deleteFiles=true`, removes any matching qBittorrent torrents that the arr no
longer knows about, and refreshes Jellyfin. A follow-up refresh covers scans that
started midway through deletion.

Jellyfin-only cards call `DELETE /api/library/jellyfin/:itemId`. Before deleting
from Jellyfin, churn checks Sonarr/Radarr for the same provider id or the same
normalized title and compatible year. If exactly one arr title matches, it uses
the normal arr delete instead. Otherwise it deletes the Jellyfin item and its
files, and removes matching qBittorrent torrents. If the arr catalog cannot be
checked, churn refuses the Jellyfin delete rather than risking an orphaned arr
entry.

The backend watches Sonarr/Radarr import history and qBittorrent for finished
`churn-direct` downloads. Either event asks Jellyfin to refresh, even when no
dashboard tab is open. A finished direct download keeps requesting a scan every
15 seconds for up to 10 minutes until Jellyfin exposes the series or movie, so a
scan that starts before the files are visible is retried instead of losing the
download. While a Library card is **Scanning**, the page polls Jellyfin every 2
seconds so the card becomes playable as soon as the item is indexed.

Movies stay at card level. Clicking a show opens
`/api/library/shows/:source/:id`, which unions Jellyfin and Sonarr episodes by
season/episode. Jellyfin alone marks an episode playable; Sonarr `hasFile` without
Jellyfin is shown as **Waiting for Jellyfin**, not as Available. Downloads come
only from qBittorrent and are matched to the show and covered episodes by the
torrent name, including season packs and active upgrades. Jellyfin shows are
matched to Sonarr through `ProviderIds.Tvdb`; catalog-only shows use the Sonarr
source directly.

Open movie and show pages show live download speed, downloaded/total size,
connected and swarm seeders, and ETA. While a download is active, the page polls
the lightweight movie/show download endpoint twice per second. Those endpoints
read only qBittorrent plus a cached title/episode identity populated by the
full detail route, so Jellyfin, Sonarr and Radarr are not queried on every tick.
Finished and imported downloads stay on the slower full-detail cadence. Once
Jellyfin exposes an episode, a still-seeding finished torrent is hidden from the
live show endpoint so **Available** and **Importing** never appear together.

If a qBittorrent download finished before Sonarr imported it, churn asks Sonarr
to scan its content path. This recovers downloads whose queue record was lost
when a series was re-added or Sonarr restarted. The normal import watcher then
refreshes Jellyfin.

Jellyfin can keep a series item while failing to link its on-disk episodes, for
instance after a restart or an interrupted import. When a Jellyfin show loads
with no episodes, the backend requests a library scan (at most once every five
minutes) and the page polls every two seconds while that scan is likely still
running, so the episode list fills in without a manual reload.

For shows tracked in Sonarr — including Jellyfin-backed shows — **Choose
release** runs the progressive Prowlarr season search. The chooser opens on the
first result and updates as each indexer finishes; the progress line says how
many indexers are still running. Grabbing a release closes the chooser and stays
on the current season; while its download is active, **Choose release** is
disabled so the same season cannot be grabbed twice. Results are parsed through
Sonarr/Radarr's `/api/v3/parse` endpoint and grouped by the quality tiers they
actually cover; each row shows size, quality, indexer, seeders and
season/episode coverage. Grabbing sends the exact torrent to qBittorrent:
single seasons use `Show/Season N`, while a multi-season pack uses the show
folder and Jellyfin groups the files by `SxxExx`.

Missing individual episodes also get their own **Choose release** action. That
runs the same per-indexer Prowlarr season search and filters the results down to
the episode, so single-episode releases and episode-covering season packs both
appear with the usual indexer progress. An episode that is
already downloading gets a **Cancel download** action instead: it removes the
matching Sonarr queue records and download when available, or falls back to
removing the matched qBittorrent torrent, and leaves imported files alone. A
season-pack download cancels the whole pack, and the confirmation says so.
Upstream GUIDs, magnet URLs and indexer ids stay on the backend. A show that
exists only in Sonarr still opens a Sonarr-backed detail page.

## Playback

Movies in Library and episodes in show detail open `#/play/<itemId>`. The player
uses Jellyfin's per-user `UserData` to resume where you stopped, then sends
playback start/progress/stop reports so Jellyfin apps see the same position and
watched state.

Episode metadata also carries intro, recap and credits ranges from
[IntroDB](https://introdb.app). They are fetched in the background when a season
or episode release is grabbed — not when the player opens — and cached per
series in `server/cache/releases/introdb/<imdbId>.json`. `GET /api/playback/items/:itemId`
exposes them as `segments` (`intro`, `recap`, `outro`, `postCredits`, in
seconds) when the cache has data. IntroDB receives only the IMDb id and
season/episode number; no session, account or viewing progress is sent. While
playback is inside the intro range, the player shows a **Skip intro** button
that jumps to the end of the intro.

Playback is codec-aware. Browser-compatible sources use a same-origin
`/api/playback/items/:itemId/stream` URL; the backend validates the session and
redirects to Jellyfin's `static=true` stream with the user's token. Sources the
browser cannot decode (for example HEVC/AC3 in an MKV) use
`/api/playback/items/:itemId/hls.m3u8`, which redirects to a Jellyfin HLS
transcode with H.264 video and AAC stereo audio at the source resolution. The
frontend plays HLS with `hls.js` and falls back to native HLS when available.

The player has a **Quality** picker for slow connections.
`GET /api/playback/items/:itemId?quality=` accepts `max` (default), `high`
(1080p, 10 Mbps), `medium` (720p, 5 Mbps) and `low` (480p, 2 Mbps). `max` keeps
the original stream and may direct-play; any other preset always transcodes and
caps both `MaxHeight` and `VideoBitrate` in the Jellyfin request, so Jellyfin
downscales a 1080p file to 720p during the encode it already runs. Presets never
exceed the source: a 3 Mbps file at `high` encodes at 3 Mbps, and presets at or
above the source bitrate are not offered at all (a file below 2 Mbps shows no
picker). The HLS route accepts the same `quality` parameter.

The response advertises the applied `quality` and the selectable `qualities`,
so the UI needs no preset table of its own. Switching quality mid-playback asks
for a new item (fresh `PlaySessionId`, because Jellyfin keys transcoding jobs by
session), rebuilds the HLS pipeline at the current position, stops the old
Jellyfin session and reports the new one; playback continues without a page
reload and a paused player stays paused. A switched tier also reports
`PlayMethod: Transcode` so Jellyfin's dashboard shows the real method instead of
claiming DirectPlay.

If Jellyfin's transcode job stops because the source file has a damaged
section, the player retries transient network and media errors in place. If the
stream stays stuck, it recreates the HLS pipeline with an explicit start
position a few seconds ahead; that segment request makes Jellyfin restart FFmpeg
past the damaged keyframe. Retries skip further ahead (5s, 15s, then 30s) and
continue automatically even if the player emits no further error. Only after
those attempts does it show the interruption alert with a **Retry** action.

The token stays out of the page DOM and API responses but is visible to browser
devtools in redirect targets and Jellyfin HLS playlist/segment URLs; video bytes
still come directly from Jellyfin. By default Churn uses the hostname the
browser used to reach the dashboard (replacing a loopback or container host in
`JELLYFIN_URL`, keeping scheme, port and base path), so playback works through
a LAN address, a Tailscale IP or a MagicDNS name without configuration. The
server stack publishes Jellyfin on port 8096, so tailnet clients reach it the
same way they reach Churn. Set `JELLYFIN_PUBLIC_URL` when the public address is
something else, such as a reverse-proxy name; an explicit value always wins.
The backend logs the effective fallback at startup. Playback failures show the
media error alert with an **Open Jellyfin** fallback, except for an HLS
interruption, which offers **Retry**.

The Services page and `/api/services/:id/open` follow the same rule: each
service link uses the host the browser used to reach the dashboard, so a
tailnet client sees `http://100.x.y.z:8096` rather than `http://127.0.0.1:8096`.
Internal health probes still call the configured internal URLs.
`SONARR_PUBLIC_URL` and `RADARR_PUBLIC_URL` override the arr links.

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

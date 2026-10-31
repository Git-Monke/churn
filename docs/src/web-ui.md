# Web dashboard

The dashboard is a TypeScript app under `server/` with two workspaces. It has
three pages — Services, Library and Search — selected by hash routes
(`#/services`, `#/library`, `#/search`):

```
server/backend/    Fastify API, also serves frontend/dist
server/frontend/   React + Vite SPA
```

The backend is a stateless BFF. It calls Jellyfin, Sonarr and Radarr and keeps
no database. The browser only requests `/api/*`; API keys and upstream URLs are
never sent to it. The app binds to `127.0.0.1` by default and has no login
screen in this version.

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
| `JELLYFIN_URL` | `http://127.0.0.1:8096` | Jellyfin base URL |
| `JELLYFIN_API_KEY` | — | Written by churn after Jellyfin setup |
| `JELLYFIN_ADMIN_USER` | `admin` | Optional non-interactive setup username |
| `JELLYFIN_ADMIN_PASSWORD` | — | Optional non-interactive setup password |
| `SONARR_URL` / `RADARR_URL` | localhost ports | Arr base URLs |
| `SONARR_API_KEY` / `RADARR_API_KEY` | `config.xml` | Optional overrides |
| `REQUEST_TIMEOUT_MS` | `5000` | Upstream timeout |
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

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Backend liveness |
| `GET /api/status` | Service health, version and latency |
| `GET /api/library` | Jellyfin movies and series with provider ids |
| `GET /api/library/images/:itemId` | Poster proxy |
| `GET /api/library/shows/:source/:id` | Show seasons, episodes and download overlays |
| `GET /api/activity` | Active Sonarr/Radarr queue grouped by movie/show |
| `GET /api/search?q=<term>` | Sonarr/Radarr lookup with library-state markers |
| `GET /api/search/images/:service` | Proxied arr media cover |
| `GET /api/requests/options` | Quality profiles, root folders and defaults |
| `POST /api/requests` | Add a movie or series and optionally start a search |
| `GET /api/services/:id/open` | Redirect to a native service UI |

Errors use `{ "error": { "code": "...", "message": "..." } }`. The library route
returns HTTP 200 with an empty list and a setup state when Jellyfin is not ready;
unexpected backend failures are 5xx.

## Search and requests

Searching runs a debounced query against Sonarr and Radarr at the same time. Each
result carries its metadata ids, rating, runtime, certification and a
backend-proxied poster. Titles already in the arr library are marked
**Requested**; this is based on Sonarr `tvdbId` and Radarr `tmdbId` matches, not
the Jellyfin library.

**Request options** persists quality profile, root folder, TV monitoring and
search-on-add in `localStorage`. Defaults prefer the `HD - 720p/1080p` profile,
fall back to `HD-1080p` and then the first profile, use the first accessible root
folder, monitor all seasons and start searching immediately. The Request button
uses these settings directly.

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

Library merges `/api/library` with `/api/activity`:

- movies and shows already in Jellyfin and active in an arr are matched by
  `tmdbId` / `tvdbId` and shown once;
- unmatched downloads appear as downloading-only cards;
- active downloads come first;
- a failed arr shows a per-service alert without hiding Jellyfin or the other
  arr.

Movies show progress on the card. Shows link to
`#/library/show/<source>/<id>`, backed by
`GET /api/library/shows/:source/:id`. That route unions Jellyfin and Sonarr
episodes by season/episode, marks availability (Jellyfin, in Sonarr, missing,
upcoming), and overlays per-episode downloads. Sonarr season packs mark every
episode in the season. Jellyfin shows are matched to Sonarr through
`ProviderIds.Tvdb`; download-only shows use the Sonarr source directly.

## Roadmap

1. Library + service status dashboard — done
2. Search and media requests — done
3. Active downloads in Library — done
4. Download history and queue actions — next
5. Jellyfin playback/session controls

## Container note

Docker support is deferred. For a later container, set `HOST=0.0.0.0`, use
Compose service names for the URLs, pass keys in the environment, and mount
`server/config/{sonarr,radarr}` read-only if relying on `config.xml` discovery.

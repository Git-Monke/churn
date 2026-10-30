# Web dashboard

The dashboard is a TypeScript app under `server/` with two workspaces:

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
| `GET /api/library` | Jellyfin movies and series |
| `GET /api/library/images/:itemId` | Poster proxy |
| `GET /api/services/:id/open` | Redirect to a native service UI |

Errors use `{ "error": { "code": "...", "message": "..." } }`. The library route
returns HTTP 200 with an empty list and a setup state when Jellyfin is not ready;
unexpected backend failures are 5xx.

## Roadmap

1. Library + service status dashboard
2. Search and request media through Sonarr/Radarr
3. Download and activity queue
4. Jellyfin playback/session controls

## Container note

Docker support is deferred. For a later container, set `HOST=0.0.0.0`, use
Compose service names for the URLs, pass keys in the environment, and mount
`server/config/{sonarr,radarr}` read-only if relying on `config.xml` discovery.

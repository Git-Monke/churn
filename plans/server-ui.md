# Server orchestration app + UI

## Context

The `server` and `torrent` Compose stacks are already in place and wired by the
one-shot init scripts. What is missing is one web app the user opens instead of
juggling Jellyfin, Sonarr and Radarr tabs.

This plan adds a TypeScript project under `server/` with two sections:

```
server/
  backend/    Fastify API layer, also serves the built frontend
  frontend/   React + Vite SPA
```

The app is a thin, stateless BFF:

- it reads from Jellyfin, Sonarr and Radarr APIs only;
- it stores no database and writes no application data;
- the browser only talks to the backend; upstream URLs and API keys never reach
  the frontend;
- it binds to `127.0.0.1` by default and has no login screen in v1;
- Docker is deferred, but URLs/keys are environment-driven so a Dockerfile and
  Compose service can be added later.

### v1 scope and roadmap order

The requested development order is:

1. **Library + service status dashboard** (this plan)
2. Search + request media (Sonarr/Radarr lookups and add)
3. Download/activity queue
4. Jellyfin playback/session controls

v1 shows the Jellyfin library (movies and series) and whether Jellyfin, Sonarr
and Radarr are reachable. Library data comes from **Jellyfin only**, per the
decision made while planning. Sonarr/Radarr are status-only in v1.

### Jellyfin caveat / installer follow-up

Jellyfin has no API key wiring today. The current install has
`IsStartupWizardCompleted=false` and no users or API keys in `jellyfin.db`.
v1 therefore treats the key as optional and degrades cleanly:

- with no key or an incomplete wizard, the dashboard shows a clear setup state;
- with `JELLYFIN_API_KEY` set, the library appears.

**Follow-up for the installer:** `churn` should eventually finish Jellyfin's
first-run setup and create a server API key during installation, writing
`JELLYFIN_API_KEY` into `server/.env`. Jellyfin cannot create a key before the
startup wizard is completed and an admin exists, so manual setup is documented
for now. Capture this as a note in the README/docs and the roadmap.

## Approach

### Tooling

- npm workspaces rooted at `server/package.json`, with `backend/` and
  `frontend/` workspaces. npm ships with Node and avoids adding another package
  manager.
- Backend: Fastify 5, `@fastify/static`, TypeScript, ESM.
- Frontend: React 19 + Vite + TypeScript, Tailwind v4 via `@tailwindcss/vite`,
  shadcn/ui components, TanStack Query for polling/caching.
- Backend default port `4000`, host `127.0.0.1`.
- Dev: Vite on `5173` with `/api` proxied to Fastify; backend does not serve the
  SPA in dev.
- Production: `npm run build` builds the SPA, then the backend serves
  `frontend/dist` and falls back to `index.html` for non-API GET routes.

### Configuration and credentials

`server/backend/src/config.ts` resolves configuration in this order:

1. process environment;
2. `server/.env` loaded with `dotenv` (churn-generated file, gitignored);
3. defaults.

URLs default to localhost:

| service | default URL | key source |
| --- | --- | --- |
| Jellyfin | `http://127.0.0.1:8096` | `JELLYFIN_API_KEY` env only |
| Sonarr | `http://127.0.0.1:8989` | `SONARR_API_KEY` env, else `server/config/sonarr/config.xml` |
| Radarr | `http://127.0.0.1:7878` | `RADARR_API_KEY` env, else `server/config/radarr/config.xml` |

`config.xml` parsing reuses the init scripts' approach: read the first
`<ApiKey>...</ApiKey>` value. No XML dependency is needed.

Add documented optional keys to `server/.env.example` without changing what
churn writes. Churn preserves unknown keys on rerun, so hand-added values
survive.

### Backend API contract

All responses are JSON except image proxying and service redirects. Errors use a
small envelope: `{ "error": { "code": "...", "message": "..." } }`.

- `GET /api/health`
  - backend liveness only: `{ "status": "ok" }`.

- `GET /api/status`
  - probes each service and returns:
    ```ts
    {
      checkedAt: string;
      services: Array<{
        id: "jellyfin" | "sonarr" | "radarr";
        name: string;
        url: string;
        state: "ok" | "unconfigured" | "unauthorized" | "unreachable";
        version?: string;
        detail?: string;
        latencyMs?: number;
      }>;
    }
    ```
  - Jellyfin: call `/System/Info/Public` for reachability/version and
    `StartupWizardCompleted`; if a key is set, also call authenticated
    `/System/Info` to validate the key.
  - Sonarr/Radarr: call `/api/v3/system/status` with `X-Api-Key`; missing key is
    `unconfigured`, 401/403 is `unauthorized`, network/timeout is `unreachable`.
  - Use `Promise.allSettled`, timeouts, and never fail the whole status route
    because one service is down.

- `GET /api/library`
  - Jellyfin-only list of movies and series:
    ```ts
    {
      source: "jellyfin";
      state: "ok" | "setup_required" | "unconfigured" | "unauthorized" | "unreachable";
      items: Array<{
        id: string;
        name: string;
        type: "Movie" | "Series";
        year?: number;
        overview?: string;
        rating?: number;
        officialRating?: string;
        runtimeMinutes?: number;
        imageUrl?: string;   // always a backend URL
      }>;
      total: number;
    }
    ```
  - State resolution: unreachable public info -> `unreachable`; wizard not
    complete -> `setup_required`; missing key -> `unconfigured`; key rejected ->
    `unauthorized`; otherwise map `/Items`.
  - Jellyfin request:
    `/Items?Recursive=true&IncludeItemTypes=Movie,Series&SortBy=SortName&SortOrder=Ascending&Fields=ProductionYear,RunTimeTicks,CommunityRating,OfficialRating,Genres,Overview&ImageTypeLimit=1&EnableImageTypes=Primary`
    with the API key in a server-side header.
  - Non-`ok` states return HTTP 200 with an empty `items` array so the UI can
    render a useful empty state. Only unexpected backend failures return 5xx.

- `GET /api/library/images/:itemId?tag=...`
  - proxies Jellyfin `/Items/{id}/Images/Primary` (allowlisted image kind in the
    future), forwards `tag`/size params, streams the upstream content type, and
    sets cache headers. No API key is exposed.
  - Validate `id` and query parameters; unknown IDs return 404.

- `GET /api/services/:id/open`
  - 302 redirect to the configured Jellyfin/Sonarr/Radarr UI URL. This lets the
    UI offer "Open Jellyfin" buttons without the frontend ever calling upstream
    directly. Only known service ids and `http(s)` URLs are allowed.

No CORS setup: same-origin by design. No backend cache in v1; TanStack Query
handles client caching and polling. The only persistent data remains the
existing `server/config`, `server/cache` and `.env` files.

### Backend structure

```
server/backend/
  package.json
  tsconfig.json
  src/
    index.ts              # reads config, starts Fastify
    server.ts             # buildServer() for tests + static serving
    config.ts             # env, .env loading, config.xml key discovery
    errors.ts             # UpstreamError, error envelope, Fastify error handler
    http.ts               # fetchWithTimeout and JSON helper
    routes/
      health.ts
      status.ts
      library.ts
      services.ts
    upstream/
        servarr.ts        # shared Sonarr/Radarr status adapter
        jellyfin.ts       # public info, list items, image fetch
    types.ts              # backend response types
  test/
    config.test.ts
    jellyfin.test.ts
    routes.test.ts
```

Implementation notes:

- `fetch` with `AbortSignal.timeout(5000)`; treat timeouts and non-2xx responses
  as typed upstream errors.
- Never log API keys. Log service IDs, URLs without credentials, and HTTP
  statuses only.
- Resolve `server/` directory from `import.meta.url` so the same code works
  from `src/` under `tsx` and from `dist/` in production. Allow
  `CHURN_SERVER_DIR` override for future container layouts.
- Register `@fastify/static` only when `frontend/dist` exists; otherwise log a
  clear "run npm run build" message.
- SPA fallback must not swallow `/api/*` 404s.

### Frontend

- Single dashboard page, no router in v1.
- TanStack Query:
  - `/api/status` poll every 30s;
  - `/api/library` poll every 60s;
  - manual refresh invalidates both.
- Layout:
  - app header with name, last-checked time, refresh button;
  - `ServiceStatus` cards for Jellyfin/Sonarr/Radarr: state `Badge`, version,
    latency, and an "Open" button using `/api/services/:id/open` when configured;
  - `Library` section with `Tabs` for All / Movies / Series, responsive poster
    grid, title/year/type/rating metadata, and backend-proxied poster images;
  - loading uses `Skeleton`, service failures use `Alert`, no results use
    `Empty`, refresh feedback uses `sonner`.
- Setup states:
  - `setup_required` -> "Finish Jellyfin first-run setup", link through
    `/api/services/jellyfin/open`, and mention that installer automation is a
    planned follow-up;
  - `unconfigured` -> explain `JELLYFIN_API_KEY` in `server/.env`;
  - `unauthorized` -> explain the key was rejected;
  - `unreachable` -> show the configured Jellyfin URL from `/api/status`.
- Use semantic shadcn/Tailwind tokens only; no raw color classes. Use the
  shadcn `Empty`, `Alert`, `Badge`, `Card`, `Tabs`, `Skeleton`, `Button`,
  `Tooltip`, `Separator` and `sonner` components. Follow the shadcn rules for
  composition and imports.

Suggested files:

```
server/frontend/
  package.json
  index.html
  vite.config.ts
  tsconfig.json
  components.json
  src/
    main.tsx
    App.tsx
    index.css
    api/client.ts
    api/types.ts
    lib/utils.ts
    components/ui/...          # shadcn-generated
    components/AppHeader.tsx
    components/StatusBadge.tsx
    features/status/ServiceStatusGrid.tsx
    features/library/LibrarySection.tsx
    features/library/LibraryCard.tsx
```

(Drop `utils/` into `src/lib/utils.ts` if shadcn's default alias expects it.)

### Scripts / workspace

Root `server/package.json`:

- `dev`: `concurrently` backend `tsx watch` + Vite dev server
- `build`: frontend build, then backend `tsc`
- `start`: `node backend/dist/index.js`
- `typecheck`: both workspaces
- `test`: backend Vitest
- `lint`/`format` only if we add tooling; keep v1 lean and rely on `tsc`

Backend scripts: `dev` (`tsx watch src/index.ts`), `build` (`tsc -p
tsconfig.build.json`), `start`, `test` (`vitest run`), `typecheck`.
Frontend scripts: `dev`, `build` (`tsc -b && vite build`), `preview`,
`typecheck`.

## Files to modify / create

- `server/package.json`, `server/package-lock.json` (generated by npm install)
- `server/backend/**` (new project)
- `server/frontend/**` (new project)
- `server/README.md` (run/build/env/Jellyfin setup + roadmap note)
- `server/.env.example` — add optional web app/Jellyfin env keys with comments
- `.gitignore` — add `node_modules/`, `dist/`, `.vite/`, `*.tsbuildinfo`
- `README.md` — add a short "Web dashboard" section and roadmap/installer note
- `docs/src/server.md` — mention the app and dev commands
- `docs/src/SUMMARY.md` + new `docs/src/web-ui.md` (optional; recommended) for
  the dashboard, configuration, v1 scope and roadmap

No changes to Rust code, compose files, or init scripts in this plan.

## Reuse

- API-key extraction pattern from `server/scripts/server-init.sh` and
  `torrent/scripts/prowlarr-init.sh` (`<ApiKey>` in `config.xml`).
- Sonarr/Radarr `/api/v3/system/status` and API-key header pattern already used
  by `server-init.sh` and `prowlarr-init.sh`.
- Existing `server/.env` conventions from `src/stack.rs` and `src/envfile.rs`;
  unknown keys survive churn reruns.
- Existing docs structure in `docs/src/` (mdBook).
- shadcn/ui components and rules instead of hand-rolled UI primitives.

## Steps

- [x] Create npm workspace at `server/` with `backend` and `frontend`
  workspaces, lockfile, TypeScript configs and root scripts.
- [x] Implement backend config loading: env + `server/.env`, URL defaults,
  `config.xml` API-key discovery, env overrides.
- [x] Implement `http.ts` fetch helper with timeout and normalized upstream
  errors.
- [x] Add Jellyfin adapter: public info, authenticated system info, library
  items, image proxy.
- [x] Add shared Sonarr/Radarr status adapter.
- [x] Build status aggregator route and `/api/health`.
- [x] Build Jellyfin-only library route with state resolution and mapping.
- [x] Add image proxy route with parameter validation and cache headers.
- [x] Add service redirect route and 404/error handling.
- [x] Serve the built SPA from Fastify with SPA fallback; add Vite dev proxy.
- [x] Scaffold Vite + React + Tailwind v4 + shadcn/ui, then add only needed
  components.
- [x] Build dashboard shell, status cards, library grid, polling, skeleton,
  empty/setup/error states, manual refresh.
- [x] Add backend Vitest tests for config parsing, Jellyfin mapping/state
  transitions, route behavior, and image parameter validation.
- [x] Add `.env.example` keys, `.gitignore` entries, README/docs updates and the
  roadmap/installer notes.
- [x] Run typecheck, tests, production build, and manual smoke test against the
  local services.

## Verification

Automated:

```bash
cd server
npm install
npm run typecheck
npm test
npm run build
```

Manual smoke test (services are already running locally):

```bash
cd server
npm run dev
# UI: http://127.0.0.1:5173, API: http://127.0.0.1:4000

curl -s http://127.0.0.1:4000/api/health
curl -s http://127.0.0.1:4000/api/status | jq
curl -s http://127.0.0.1:4000/api/library | jq
```

Expected on the current machine:

- `/api/status` reports Sonarr and Radarr `ok` with versions from
  `server/config/*/config.xml`;
- Jellyfin is reachable but reports `setup_required` because
  `StartupWizardCompleted=false`;
- `/api/library` returns `state: "setup_required"` and an empty list;
- the dashboard shows the Jellyfin setup alert and Sonarr/Radarr status cards;
- no API key appears in browser network responses.

After manually completing Jellyfin setup and creating an API key:

```bash
# add to server/.env
JELLYFIN_API_KEY=<key>
```

Restart the backend, add media to `/data/media/tv` or `/data/media/movies`, run
a Jellyfin library scan, and confirm:

- `/api/library` returns movies/series with backend image URLs;
- posters load through `/api/library/images/...`;
- the dashboard tabs filter All/Movies/Series;
- stopping one *arr container makes only that status card go `unreachable`
  while the rest of the dashboard keeps working.

Production serving check:

```bash
cd server
npm run build
npm start
# open http://127.0.0.1:4000 — SPA served by Fastify
```

## Risks / notes

- **Jellyfin first-run is manual in v1.** The app can only show a setup state
  until the wizard and API key exist. Installer automation is explicitly a
  follow-up.
- **Jellyfin API keys cannot be created before setup.** Future churn automation
  needs to complete the startup wizard / create an admin, then create a key via
  an authenticated `/Auth/Keys` call or the dashboard.
- **No fallback library source by decision.** If Jellyfin is down or unkeyed,
  the library is empty even if Sonarr/Radarr have titles. This is intentional
  for v1.
- **No app auth.** Bind to `127.0.0.1`; document that exposing the port requires
  a reverse proxy or a later auth feature.
- **Container later.** For Docker, set `HOST=0.0.0.0`, use service DNS names
  (`http://jellyfin:8096`, etc.), pass keys via env, and mount
  `server/config/{sonarr,radarr}` read-only if relying on config.xml discovery.

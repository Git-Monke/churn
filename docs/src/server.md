# Server stack

The server stack is the media-facing half of the setup. It runs outside the
VPN because it serves the local library and provides the automation APIs used
by the torrent stack.

## Services

| Service | Role | Host port |
| --- | --- | --- |
| `jellyfin` | Media server and player frontend | `JELLYFIN_PORT` (default `8096`) |
| `sonarr` | TV series management and downloads | `SONARR_PORT` (default `8989`) |
| `radarr` | Movie management and downloads | `RADARR_PORT` (default `7878`) |
| `dashboard` | Churn web UI | `DASHBOARD_PORT` (default `4000`) |
| `server-init` | One-shot setup for media folders and root folders | none |

## Storage

churn asks for two host paths, and every service mounts both at fixed container
paths:

| Answer | `.env` key | Default | Container path | Purpose |
| --- | --- | --- | --- | --- |
| Download directory | `DOWNLOAD_DIR` | `/data` | `/data` | qBittorrent's scratch and in-progress downloads |
| Media directory | `MEDIA_DIR` | `<DOWNLOAD_DIR>/media` | `/data/media` | the library Jellyfin indexes |

Downloads are asked for first, because the media default derives from that
answer. The download directory is best on an SSD or fast local disk — files are
written and re-read while seeding — while the media directory is best on a large
hard drive or a NAS, since it is what Jellyfin streams from.

The two answers are validated together: `DOWNLOAD_DIR` may not equal
`MEDIA_DIR` or live inside it. Jellyfin indexes the whole media root, so a
download directory inside it would put partial files in the library.

Because the container paths never change, the host paths can move freely:
Jellyfin still reads `/data/media`, and Sonarr/Radarr still use `/data` and
`/data/media` for their libraries and completed downloads. No path translation
is needed between the two stacks.

Pointing `MEDIA_DIR` at an existing library adopts it in place — no copy and no
folder restructuring. Jellyfin types each item itself, so one mixed library at
the media root covers both films and shows.

An install from before the split stored a single path under `DATA_DIR`. churn
still reads that key as the download directory, so a rerun keeps the existing
location, and rewrites the file with `DOWNLOAD_DIR` so the legacy key does not
linger. Nothing changes on disk unless `MEDIA_DIR` is set to a different path.

`server-init` creates:

```text
/data/media/tv
/data/media/movies
```

These are arr root folders for new downloads, not Jellyfin libraries. It also
sets ownership to `PUID`/`PGID` and registers those directories as the Sonarr
and Radarr root folders. The one-shot is idempotent and can be rerun:

```bash
cd server
docker compose run --rm server-init
```

Do **not** add `/data` itself as a Jellyfin library root. qBittorrent saves
downloads under `/data` and incomplete files under `/data/incomplete`, so a
root-level library makes Jellyfin index media that is still downloading.
Churn makes sure one mixed library covers `/data/media` — Jellyfin types each
item itself, so movies and TV share a library root and the `movies/` and `tv/`
folders exist only as arr root folders. A library that already covers the media
root, or sits inside it (as an install from before the split does with separate
`Movies` and `Shows` libraries), is reused rather than duplicated, because
Jellyfin does not support nested library paths. Any `/data` library path is
removed, and the whole thing is safe to rerun.

churn also adds the private LAN ranges and Tailscale's `100.64.0.0/10` range to
Jellyfin's LAN networks, so tailnet clients can stream video directly from
Jellyfin while remote access stays disabled.

## Migrating storage

Move an existing library to a new disk or NAS with `churn migrate`. It moves
`MEDIA_DIR` by default; `--download` moves `DOWNLOAD_DIR` instead, and each
location is migrated independently:

```bash
sudo churn migrate --to /mnt/library --dry-run
sudo churn migrate --to /mnt/library
sudo churn migrate --to /mnt/library --move
sudo churn migrate --download --to /mnt/ssd
```

The default matters: the library is the tree that outgrows a disk, and moving
it leaves the download directory — and every in-flight torrent — untouched. A
download move carries a library nested under `<DOWNLOAD_DIR>/media` with it and
leaves one on its own disk alone.

The command reads the current path from both stacks' `.env` files, refuses
nested, unwritable, read-only, network and too-small destinations, then stops
the installed stacks for the duration of the copy. It copies with rsync
(`--partial`, so an interrupted run resumes) or `cp -a` when rsync is missing,
verifies every file's size and symlink target, updates the moved key, `PUID` and
`PGID` in both `.env` files, restarts the stacks and runs the Jellyfin health
check.

A media directory on a different filesystem from the download directory stops
Sonarr and Radarr hardlinking imports: each import becomes a copy followed by a
delete. The plan warns about this before anything is stopped.

The copy shows live progress from rsync: bytes moved, transfer rate, ETA and how
many files are left to check. The percentage is rsync's own, so it describes the
bytes still to transfer — a resumed copy can reach 100% early. When rsync is not
installed the `cp -a` fallback runs behind a spinner instead. If churn's output
is redirected to a file, only one progress line per 10% is written.

The old copy is kept by default. `--move` (alias `--delete-old`) removes it only
after the copy has been verified and the services are running again. Each
stack's previous file is saved as `.env.churn-migrate.bak` and the command
prints the `cp` commands to roll back. The destination is marked while the copy
is in progress so a second run continues instead of mixing data from different
sources.

Container paths do not change: the download directory is still mounted at
`/data` and the library at `/data/media`, so Jellyfin libraries, arr root
folders and qBittorrent paths stay valid without being touched.

## Configuration

`server/.env` is generated by churn and holds `DOWNLOAD_DIR`, `MEDIA_DIR`,
`PUID`, `PGID`, `TZ`, and the chosen host ports (`JELLYFIN_PORT`, `SONARR_PORT`,
`RADARR_PORT`, `DASHBOARD_PORT`). It is `root:PGID` with mode `0640`: the
dashboard container runs as `PUID:PGID` and reads it for the Jellyfin API key,
while root ownership keeps unprivileged processes from changing values compose
interpolates. The compose file is static. Web UIs are published directly by each
service, so they are reachable at:

- Jellyfin: `http://<host>:JELLYFIN_PORT` (default 8096)
- Sonarr: `http://<host>:SONARR_PORT` (default 8989)
- Radarr: `http://<host>:RADARR_PORT` (default 7878)
- Dashboard: `http://<host>:DASHBOARD_PORT` (default 4000)

If a default host port is already occupied, churn asks once with the nearest
free port suggested. Only the host side moves; services keep their internal
ports.

The torrent stack's `prowlarr-init` reads the Sonarr and Radarr API keys from
`server/config/`. This is why the current wiring expects both stacks on the
same machine.

## Dashboard

The optional TypeScript app in `server/backend` and `server/frontend` serves a
single dashboard for the Jellyfin library, the health of Jellyfin, Sonarr and
Radarr, the torrent stack's live VPN leak status, and searching and requesting
new media. Requests are added through the Sonarr/Radarr APIs without starting a
download, and their TMDB/TVDB metadata is cached for release search. Release
search queries every enabled Prowlarr indexer in parallel and streams
per-indexer progress to the chooser. Series seasons are queued in ascending
order, one at a time, skipping seasons Sonarr already has complete; results are
parsed through Sonarr/Radarr's `/api/v3/parse` endpoint and grouped by quality.
Choosing a release sends its torrent or magnet directly to qBittorrent, tagged
`churn-direct`, and saves it into the matching `/data/media` show/movie folder.
A background watcher sees direct downloads finish and asks Jellyfin to scan, so
no manual refresh is needed and no arr import is required. Sonarr/Radarr remain the metadata,
indexer and release-search source. The app binds to `127.0.0.1` and the browser
only calls the backend; upstream keys and URLs stay server-side.

```bash
cd server
npm install
npm run dev        # UI http://127.0.0.1:5173, API http://127.0.0.1:4001
```

The dev backend listens on `4001` so the dashboard container (`DASHBOARD_PORT`,
default `4000`) can keep running alongside it; set `PORT` to move both the
backend and Vite's `/api` proxy.

After the server stack starts, churn completes Jellyfin's first-run wizard,
creates an API key named `churn`, and writes it to `server/.env` as
`JELLYFIN_API_KEY`. It asks for the Jellyfin admin username and password when
needed; the password is not stored. Sonarr and Radarr API keys are read from
`server/config/*/config.xml` unless overridden.

The dashboard requires a Jellyfin login, either through a household profile or
an administrator account. Each profile is backed by its own Jellyfin user, so
watch progress is per person; an admin creates profiles and their one-time PINs
from the People page. Churn stores the returned user token in a session that is
persisted to the `churn-state` volume and slides on activity with a 12-hour idle
TTL, so dashboard restarts and `churn` reruns do not sign people out. Each
session has a unique Jellyfin device id, so simultaneous users do not revoke
each other's tokens. Library calls and playback use the user's token, while the
installer's API key stays server-side for status checks and user management.
All logged-in Jellyfin users get the full dashboard, including Sonarr/Radarr
requests.

The planned order is: library/status dashboard, search and media requests
(done), active downloads in Library (done), Jellyfin login and per-user sessions
(done), Jellyfin playback (done), then download history and queue actions. See
[Web dashboard](web-ui.md) for the current API and configuration.

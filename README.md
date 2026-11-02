# churn

Interactive installer for a small self-hosted media + torrent setup.

Two roles, one machine each (or both on the same box):

| stack     | what it runs                                  | ports |
| --------- | --------------------------------------------- | ----- |
| `server`  | Jellyfin + Sonarr + Radarr                    | 8096, 8989, 7878 |
| `torrent` | qBittorrent + Prowlarr + FlareSolverr tunnelled through Mullvad WireGuard | 8080, 9696 |

## Usage

Run the installer as root:

```bash
cargo build --release
sudo ./target/release/churn
```

The wizard first runs two preflight checks:

- **Root access** — required, because churn writes config files as root and may
  install packages. It stops with a `sudo` hint if you are not root.
- **Docker** — churn checks for Docker and the Compose plugin *before* asking
  any setup questions. If they are missing it detects Ubuntu, Debian, Fedora or
  Arch Linux and offers to install Docker with that distribution's official
  commands. If you decline, it stops and asks you to install Docker and re-run.

Then it asks which roles this machine should run and collects what it needs:

- **Mullvad WireGuard config archive** — download the zip from
  [mullvad.net](https://mullvad.net/en/account/wireguard-config) and give churn
  its path. It opens the zip and reads `PrivateKey` and IPv4 `Address` from
  one of the `.conf` files. (Every file in one archive carries the same key and
  address, so churn just picks the first one instead of asking.)
- **Storage path** — one absolute host path for media and downloads. It is
  mounted at `/data` inside every container, so Jellyfin and qBittorrent agree
  on paths regardless of which machine they run on.

Answers are shared between installers, so selecting both roles asks for the
storage path once. Reruns prefill previous answers and reuse them if you press
Enter. Path prompts autocomplete as you type: use ↑/↓ to highlight a suggestion,
then Tab or Enter to accept it.

Once the answers are written, churn starts each selected stack with
`docker compose up -d` and reports the URLs to open. While Docker pulls images
and starts containers, churn shows one live line per process (each image,
container, network or volume) with that process's latest state, instead of a
rolling window that mixes parallel pulls together. If Compose fails, the
formatted end of its output is included in the error.

```bash
sudo ./target/release/churn --stacks server,torrent   # skip the menu
sudo ./target/release/churn --dry-run                # collect answers, write nothing
```

## Uninstall

`--uninstall` stops and removes the stack containers with `docker compose
down --remove-orphans`, then deletes the generated app state:

```
server/config      server/cache      server/.env
torrent/config     torrent/.env
```

The media/download directory (`DATA_DIR`), Docker images, and the committed
compose files and scripts are left untouched. If Docker Compose fails to remove
a stack, churn stops before deleting any config so the containers and their
credentials stay consistent.

```bash
sudo ./target/release/churn --uninstall              # both stacks
sudo ./target/release/churn --uninstall --dry-run    # show the plan only
sudo ./target/release/churn --uninstall --stacks torrent
sudo ./target/release/churn --uninstall --yes        # no confirmation
```

## What it writes

`.env` files only; the compose files are static and committed. churn then runs
`docker compose up -d` in each selected stack directory.

```
server/.env      DATA_DIR, PUID, PGID, TZ, JELLYFIN_API_KEY (after setup)
torrent/.env     the above + HOST_IP + Mullvad credentials (and the archive path)
```

`PUID`/`PGID` come from whoever owns the storage directory and `TZ` from the
host. Keys churn does not manage are preserved on rerun, so hand edits survive.
`.env` is gitignored — secrets never land in the repo.

## Web dashboard

`server/backend` and `server/frontend` hold an optional dashboard for the
Jellyfin library, the health of Jellyfin, Sonarr and Radarr, and searching,
requesting and tracking new media. It has three pages — Services, Library and
Search. It is a BFF: it reads the service APIs, stores no database, and the
browser only talks to the backend. It binds to `127.0.0.1` by default.

The dashboard now requires a Jellyfin login. Churn validates the account with
Jellyfin, keeps the resulting user token in an in-memory session, and sends only
an HttpOnly session cookie to the browser. Restarting the backend signs everyone
out. Every logged-in Jellyfin user gets full access to the dashboard, including
Sonarr/Radarr requests and cancel/delete actions; Jellyfin's own library
restrictions still apply because
library calls use the user's token. See `server/README.md` for session settings
and the full-access warning.

```bash
cd server
npm install
npm run dev        # UI http://127.0.0.1:5173, API http://127.0.0.1:4000
```

After the server stack starts, churn completes Jellyfin's first-run setup,
creates an API key named `churn`, and writes it to `server/.env` as
`JELLYFIN_API_KEY`. It also creates or repairs the `Movies` and `Shows`
libraries at `/data/media/movies` and `/data/media/tv`, and removes any `/data`
library path so Jellyfin does not index qBittorrent's in-progress downloads. The
installer asks for a Jellyfin admin username and password when needed; the
password is not saved. Reruns reuse a valid key. Sonarr and Radarr keys are read
automatically from `server/config/*/config.xml`.

Production build:

```bash
cd server
npm run build
npm start          # Fastify serves the SPA at http://127.0.0.1:4000
```

Search across Radarr and Sonarr from the dashboard and request a movie or show
with one click. Requests use saved defaults for quality profile, root folder
and TV monitoring, and start a download search immediately. The Request options
popover has a **Prefer smaller files** switch (on by default) that picks a
720p-only profile first, then 720p/1080p, so new downloads arrive faster.

The Library page merges titles already in Jellyfin with active Sonarr/Radarr
downloads. Movies show progress and ETA on their card. Each arr-backed card has
a trash button that cancels the download, removes the title and its files from
Sonarr/Radarr, and refreshes Jellyfin — useful for replacing a large release
with a smaller profile. Shows open a season and episode view with per-episode
availability and download progress, including season-pack handling. Movies and Jellyfin episodes also open an in-app player:
video streams from Jellyfin, transcoding to HLS when the browser cannot decode
the source, resume positions come from the signed-in user, and progress is
reported back to Jellyfin. See `server/README.md` for
configuration, `JELLYFIN_PUBLIC_URL` and container notes. Development is
planned in this order: library/status dashboard, search and media requests
(done), active downloads in Library (done), Jellyfin login and per-user sessions
(done), Jellyfin playback (done), then download history and queue actions.

## Running a stack

The installer starts the stacks for you. To bring them up again later (for
example after a reboot):

```bash
cd server  && docker compose up -d    # then open http://<ip>:8096 (Jellyfin),
                                     #   http://<ip>:8989 (Sonarr), http://<ip>:7878 (Radarr)
cd torrent && docker compose up -d    # temporary password: docker logs qbittorrent
```

Both web UIs are published on the `gluetun` container (the other three share its
network namespace), so Prowlarr is at `http://<ip>:9696`.

## Prowlarr and qBittorrent

Prowlarr, qBittorrent, FlareSolverr and gluetun share one network namespace, so
qBittorrent is reachable from Prowlarr at `http://localhost:8080` and
FlareSolverr at `http://localhost:8191` — no hostnames or VPN round-trip needed.

The wiring is automatic on first `docker compose up`:

1. `qbittorrent-init` seeds `config/qbittorrent` with a stable qBittorrent API
   key before the app starts. The image otherwise regenerates a random WebUI
   password on every restart.
2. Once the apps are up, `prowlarr-init` reads Prowlarr's generated API key, the
   qBittorrent key and the Sonarr/Radarr keys, then wires everything through the
   APIs (all steps are idempotent):
   - creates the qBittorrent categories `prowlarr`, `tv` and `movies`;
   - registers qBittorrent in Prowlarr as a download client (category `prowlarr`);
   - adds and enables the public indexers `EZTV`, `YTS` and `The Pirate Bay`;
   - registers FlareSolverr as a Prowlarr indexer proxy and tags the managed
     indexers so Cloudflare-protected sites such as EZTV work;
   - registers Sonarr and Radarr as Prowlarr applications, so Prowlarr pushes
     its indexers to them;
   - registers qBittorrent in Sonarr and Radarr with the `tv` and `movies`
     categories.
3. Prowlarr and Sonarr/Radarr sit in different network namespaces, so they talk
   over the host's LAN address, written to `torrent/.env` as `HOST_IP` (auto-
   detected, override with `CHURN_HOST_IP`). gluetun gets that single address
   as `FIREWALL_OUTBOUND_SUBNETS`, so the VPN kill switch still blocks
   everything else.

Because every container mounts the same `${DATA_DIR}` at `/data`, download
paths line up without translation. qBittorrent saves to `/data/` (incomplete
files under `/data/incomplete`) and Prowlarr tags its downloads with the
`prowlarr` category. Media lives in `/data/media`, which is what Jellyfin's
libraries point at; never add `/data` itself as a Jellyfin library.

Re-run the one-shots by recreating the stack (a plain `docker compose up -d`
leaves already-exited one-shots alone):

```bash
cd torrent
docker compose down && docker compose up -d
```

To re-apply the wiring after deleting something in the UIs (or after adding the
server stack later), run just the one-shot — it is idempotent:

```bash
docker compose run --rm prowlarr-init
```

The default public indexers need no accounts and are enough to get started.
Override them with a comma-separated list in `torrent/.env`:

```bash
PROWLARR_INDEXERS=eztv,yts,thepiratebay
```

Supported keys are `1337x`, `eztv`, `yts`, `thepiratebay` and `limetorrents`;
unknown names are skipped. Indexers named in `PROWLARR_INDEXERS` are added to
Prowlarr and tagged for FlareSolverr automatically. They are enabled even when
Prowlarr's immediate connectivity test fails (for example, Cloudflare blocking
EZTV); Prowlarr can then back off that indexer until it responds. Re-run the
one-shot to re-apply the enabled state and proxy tag after changing an indexer
in the UI.

FlareSolverr only runs when Prowlarr detects a Cloudflare challenge, so ordinary
indexers do not pay the Chromium startup cost. Its network traffic shares
Gluetun's namespace and therefore exits through Mullvad like the other torrent
containers. `1337x` is supported and can be enabled with
`PROWLARR_INDEXERS=1337x,eztv,yts,thepiratebay`.

## VPN leak protection

The torrent stack is designed to fail closed, not merely to prefer the VPN:

- Only `gluetun` joins a Docker network. qBittorrent, Prowlarr, FlareSolverr,
  the one-shots and `vpn-check` all use `network_mode: "service:gluetun"`, so
  they have no network path of their own. `qbittorrent-init` writes files only
  and runs with `network_mode: "none"`.
- Gluetun's kill switch is explicitly enabled. The only non-VPN exception is
  `HOST_IP/32`, which must be a loopback/LAN address; a public or broad
  exception is rejected. IPv6 is disabled in the shared namespace because the
  Mullvad import only configures IPv4.
- Every sidecar with network access bind-mounts a static
  `torrent/resolv.conf` containing only
  `nameserver 127.0.0.1`, Gluetun's DNS-over-TLS resolver. Docker does not
  allow the `dns:` option together with `network_mode: service:gluetun`, so the
  mount is what prevents a host or Docker nameserver fallback.
- Before qBittorrent, Prowlarr or FlareSolverr starts, `vpn-check` verifies that
  the public exit is a Mullvad exit, that `eth0` cannot reach the internet
  directly, and that DNS is using Gluetun's resolver. A failure stops the
  dependent containers from starting.
- `churn` validates the effective `docker compose config --format json` before
  `compose up` and refuses to start `torrent` if any service could bypass the
  VPN namespace, publish its own ports, use a non-Gluetun network, or if the
  firewall/DNS/IPv6 settings are unsafe.

Re-run the runtime check at any time:

```bash
cd torrent && docker compose up --force-recreate vpn-check
```

A passing run ends with `PASS: torrent egress is confined to the VPN`. Check
`docker logs vpn-check` for the result of the last automatic startup check.

## Sonarr and Radarr

Both run on the `server` box, outside the VPN, and share `/data` with Jellyfin.
Images are pinned (`sonarr:4.0.20.3014-ls1`, `radarr:6.4.4.10685-ls324`) so
upstream releases do not move under you. Bump those tags deliberately after
checking the release notes.

They are wired up automatically by `prowlarr-init`. The `server` stack also
runs `server-init`, which creates `/data/media/tv` and `/data/media/movies`
inside `DATA_DIR`, sets their ownership to `PUID`/`PGID`, and registers them as
the Sonarr/Radarr root folders. It waits for both APIs and is idempotent. Add
media under those directories, and point Jellyfin's TV and movie libraries at
the same container paths (`/data/media/tv`, `/data/media/movies`).

`prowlarr-init` reads the Sonarr/Radarr API keys from `../server/config`, so it
expects both stacks on **one machine**. The installer starts `server` before
`torrent` for this reason. If the server stack was not up yet, re-run the wiring
after starting it:

```bash
cd torrent && docker compose run --rm prowlarr-init
```

If the root folders were removed in the UI, re-run the server one-shot:

```bash
cd server && docker compose run --rm server-init
```

**Separate machines (not wired yet):** the current setup hardcodes the
same-host assumption through `HOST_IP`. Moving Sonarr/Radarr to their own box
means passing the server's address and API keys into the torrent stack (or
vice versa) instead of reading `../server/config`; that is a planned follow-up,
not something the installer supports today. Until then, keep both stacks on the
same host.

## Development

```bash
cargo test
```

### Documentation

The stack notes are an mdBook in `docs/`. Markdown pages live in `docs/src/`.

```bash
cargo install mdbook
mdbook serve docs    # preview at http://localhost:3000
mdbook build docs    # render the static site to docs/book
```

`src/lib.rs` holds the testable core ([`question`](src/question.rs),
[`mullvad`](src/mullvad.rs), [`stack`](src/stack.rs),
[`envfile`](src/envfile.rs), [`system`](src/system.rs)); `src/main.rs` is the
wizard flow. Dedupe of questions, the VPN-before-storage ordering, and parsing
of Mullvad `.conf`/zip files are covered by `tests/installer.rs`; distro
detection and root-uid parsing by `tests/system.rs`.

`vendor/cliclack` is a local patch for path autocomplete: the first suggestion
is selected automatically, Tab completes it without submitting, and Enter only
submits the typed value.

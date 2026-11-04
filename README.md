# churn

Interactive installer for a small self-hosted media + torrent setup.

Two roles, one machine each (or both on the same box):

| stack     | what it runs                                  | ports |
| --------- | --------------------------------------------- | ----- |
| `server`  | Jellyfin + Sonarr + Radarr + dashboard | 8096, 8989, 7878, 4000 (configurable) |
| `torrent` | qBittorrent + Prowlarr + FlareSolverr tunnelled through Mullvad WireGuard | 8080, 9696, 8098 (localhost; configurable) |

Every published host port defaults to its conventional value. A free default is
used without asking; if it is already taken, churn suggests the nearest free
port and asks which one to use. The chosen values live in each stack's `.env`,
and reruns reuse them.

## Install

On a fresh Linux machine (root required):

```bash
curl -fsSL https://raw.githubusercontent.com/Git-Monke/churn/main/install.sh | sudo sh
sudo churn
```

`install.sh` downloads the latest static release binary. churn then installs
Docker if it is missing, writes the stack files, pulls the prebuilt dashboard
image, and configures the services.

## Update

Update the churn CLI and the server dashboard to the latest release:

```bash
sudo churn update
```

`churn update` downloads and checksum-verifies the same release binary that
`install.sh` installs, replaces it atomically, then pulls the matching dashboard
image and recreates only the dashboard container. The previous binary is kept
as `churn.previous` until the dashboard is healthy.

Check versions without changing anything (no root required):

```bash
churn update --check
```

Use `--binary-only` or `--dashboard-only` to update one part, and `--to 0.1.4`
to pin a specific release. Jellyfin, Sonarr and Radarr stay on their pinned
versions.

## Usage from a source checkout

To build and run the installer from a checkout:

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

On a rerun, churn inspects the existing Compose project before asking for ports.
If its containers are still running or stopped, churn reuses their published
host ports instead of treating its own Jellyfin on 8096 as a conflict and moving
the service to a new port. Older `.env` files that predate configurable ports
are filled in from the containers themselves.

## Service URLs

`churn show` prints the exact URL for every installed service, using the host
ports in the generated `.env` files and the machine's detected LAN address:

```bash
churn show
churn show --stacks torrent
```

It is read-only: it does not need root, Docker, or running containers. Set
`CHURN_HOST_IP` when the machine has several addresses or detection picks the
wrong one:

```bash
CHURN_HOST_IP=192.168.1.20 churn show
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
server/.env      DATA_DIR, PUID, PGID, TZ, host ports, JELLYFIN_API_KEY (after setup)
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

The dashboard now requires a Jellyfin login. Churn supports household profiles:
an admin adds a person, which creates a Jellyfin user for them, and hands over a
one-time PIN that the person replaces with their own password. Sessions use a
unique Jellyfin device per login, last 12 hours of inactivity, and are persisted
to a state volume, so simultaneous users and dashboard restarts no longer sign
everyone out. Every logged-in Jellyfin user gets full access to the dashboard, including
Sonarr/Radarr requests and cancel/delete actions; Jellyfin's own library
restrictions still apply because
library calls use the user's token. See `server/README.md` for session settings
and the full-access warning.

The Services page has **Services** and **VPN** tabs. The VPN tab runs an
on-demand leak test from the torrent stack's `vpn-status` agent and shows the
verdict, the Mullvad exit IP/location, DNS and kill-switch checks, IPv6 state,
and whether qBittorrent, Prowlarr and FlareSolverr are sharing the protected
network namespace.

```bash
cd server
npm install
npm run dev        # UI http://127.0.0.1:5173, API http://127.0.0.1:4000
```

After the server stack starts, churn completes Jellyfin's first-run setup,
creates an API key named `churn`, and writes it to `server/.env` as
`JELLYFIN_API_KEY`. It also creates or repairs the `Movies` and `Shows`
libraries at `/data/media/movies` and `/data/media/tv`, and removes any `/data`
library path so Jellyfin does not index qBittorrent's in-progress downloads. It
also adds the private LAN ranges and Tailscale's `100.64.0.0/10` range to
Jellyfin's LAN networks, so tailnet clients can stream directly from Jellyfin
while remote access stays disabled. The installer asks for a Jellyfin admin
username and password when needed; the password is not saved. Reruns reuse a
valid key. Sonarr and Radarr keys are read automatically from
`server/config/*/config.xml`.

Production build:

```bash
cd server
npm run build
npm start          # Fastify serves the SPA at http://127.0.0.1:4000
```

Search across Radarr and Sonarr from the dashboard and request a movie or show.
Requests only add the title to the library: they do **not** start a download or
run an automatic search. Churn adds the title unmonitored and caches the metadata
Radarr/Sonarr returned (title, year, TMDB/TVDB/IMDB ids, seasons and poster).

Release search is Prowlarr-first. Opening a movie or season runs one Prowlarr
search per enabled indexer in parallel, and the chooser opens as soon as the
first usable result arrives and keeps updating as each indexer finishes. A
progress line shows `5/9 indexers finished`, with a chip for every indexer, so
you can see whether more results are still coming. For a series, seasons are
searched in ascending order, one season at a time; seasons Sonarr already has
complete are skipped, and opening another season manually starts it immediately.
Churn's own release-name parser filters the results by title, year, season and episode and
extracts quality, season ranges and episode ranges. Results are grouped by
quality tier (`480p`, `720p`, `1080p`, `2160p`, and `Other`) and sorted by
seeders, then size. Only the best-seeded release is shown initially; **Show more
options** expands the tier.

Every enabled Prowlarr indexer is represented and every result with a torrent
or magnet URL can be downloaded, whether or not Sonarr/Radarr has that indexer.
Choosing a release sends exactly that torrent straight to qBittorrent; there is
no second arr search and no arr grab. qBittorrent saves into the existing
Sonarr/Radarr show or movie folder, using `Show/Season N` for a single season
and the show folder for a multi-season pack. The `churn-direct` tag identifies
these downloads so churn does not ask Sonarr to re-import them.

Release-search snapshots persist in `server/cache/releases/prowlarr` (or
`server/.churn-cache/releases/prowlarr` when the container-owned `cache/`
directory is not writable). Later opens show the snapshot until **Search again**
starts a fresh search. When the best option in a tier has fewer than 50 seeders,
the chooser shows a “may be stale” warning and a refresh button instead of
hiding the options.

The Library page uses Jellyfin as the only source of playable titles and
qBittorrent as the only source of active download progress. The requested-library
catalog still lists titles added to Sonarr/Radarr so a show or movie remains
available for release selection before anything has downloaded. Movies show
qBittorrent progress and ETA on their card. Every card has a trash button:
Sonarr/Radarr-backed titles are removed there, cleaned up in qBittorrent and
refreshed in Jellyfin, while Jellyfin-only titles are deleted from Jellyfin and
its filesystem. When the provider ids differ, churn matches a Jellyfin title back
to Sonarr/Radarr by title and year before falling back to a Jellyfin delete.
Shows open a season and episode view with
Sonarr's missing episodes, Jellyfin playability and qBittorrent download
progress, including season-pack handling. A downloading episode has its own
**Cancel download** action that stops just that download and keeps imported
files; shows that are in Jellyfin still get Sonarr release search through the
matched Sonarr series.
Movies and Jellyfin episodes also open an in-app player:
video streams from Jellyfin, transcoding to HLS when the browser cannot decode
the source, resume positions come from the signed-in user, and progress is
reported back to Jellyfin. Playback follows the hostname used to open the
dashboard, so the same install works through a LAN IP, a Tailscale IP or a
MagicDNS name without extra configuration. See `server/README.md` for
configuration, `JELLYFIN_PUBLIC_URL` and container notes. Development is
planned in this order: library/status dashboard, search and media requests
(done), active downloads in Library (done), Jellyfin login and per-user sessions
(done), Jellyfin playback (done), then download history and queue actions.

## Running a stack

The installer starts the stacks for you. To bring them up again later (for
example after a reboot):

```bash
cd server  && docker compose up -d    # then open the JELLYFIN_PORT, SONARR_PORT
                                     #   and RADARR_PORT URLs from server/.env
cd torrent && docker compose up -d    # temporary password: docker compose logs qbittorrent
```

Both web UIs are published on the `gluetun` container (the other three share its
network namespace), so Prowlarr is at the `PROWLARR_PORT` shown in the install summary.

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
   - adds and enables the public indexers `EZTV`, `YTS`, `The Pirate Bay`,
     `1337x`, `LimeTorrents`, `Torrent Downloads`, `TorrentDownload` and
     `Uindex`;
   - registers FlareSolverr as a Prowlarr indexer proxy and tags the managed
     indexers so Cloudflare-protected sites such as EZTV work;
   - registers Sonarr and Radarr as Prowlarr applications, so Prowlarr pushes
     its indexers to them, and keeps their sync categories limited to normal
     TV/movie categories (adult XXX categories are excluded);
   - registers qBittorrent in Sonarr and Radarr with the `tv` and `movies`
     categories.
3. Prowlarr and Sonarr/Radarr sit in different network namespaces, so they talk
   over the host's LAN address, written to `torrent/.env` as `HOST_IP` (auto-
   detected, override with `CHURN_HOST_IP`). gluetun gets that single address
   as `FIREWALL_OUTBOUND_SUBNETS`, so the VPN kill switch still blocks
   everything else.

Because every container mounts the same `${DATA_DIR}` at `/data`, download
paths line up without translation. Direct release grabs are saved into
`/data/media/tv` and `/data/media/movies`; older arr-managed downloads still use
`/data` (incomplete files under `/data/incomplete`). Media lives in
`/data/media`, which is what Jellyfin's libraries point at; never add `/data`
itself as a Jellyfin library.

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
PROWLARR_INDEXERS=eztv,yts,thepiratebay,1337x,limetorrents,torrentdownloads,torrentdownload,uindex
```

Supported keys are `1337x`, `eztv`, `yts`, `thepiratebay`, `limetorrents`,
`torrentdownloads`, `torrentdownload` and `uindex`; unknown names are skipped.
Indexers named in `PROWLARR_INDEXERS` are added to Prowlarr and tagged for
FlareSolverr automatically. They are enabled even when Prowlarr's immediate
connectivity test fails; Prowlarr can then back off that indexer until it
responds. Re-run the one-shot to re-apply the enabled state and proxy tag after
changing an indexer in the UI.

Indexer availability depends on the VPN exit country. Courts in some countries
order blocks for specific sites, and Cloudflare answers those with **HTTP 451
(Unavailable For Legal Reasons)** — a legal block, not a challenge, so
FlareSolverr cannot solve it. The Netherlands, for example, blocks EZTV, 1337x,
YTS, The Pirate Bay and LimeTorrents. churn derives `SERVER_COUNTRIES` from the
selected Mullvad config filename (`us-atl-wg-001.conf` -> `USA`) instead of
hardcoding a country. To pin a different exit, set it in `torrent/.env`:

```bash
SERVER_COUNTRIES=USA
```

Prowlarr does not have a global "hide adult categories" setting. churn filters
adult releases where it can do so reliably: the Sonarr and Radarr applications
are synced with only TV and movie categories, never the `6000`-series XXX
categories, and re-running `prowlarr-init` updates existing synced indexers to
match. Prowlarr's own Search page can still return adult results when a search
does not restrict categories; that is a Prowlarr limitation. The filter follows
indexer categories, so an adult release a tracker files under TV or Movies can
still slip through.

FlareSolverr only runs when Prowlarr detects a Cloudflare challenge, so ordinary
indexers do not pay the Chromium startup cost. Its network traffic shares
Gluetun's namespace and therefore exits through Mullvad like the other torrent
containers.

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
- `vpn-status` stays running beside the apps and exposes the same live checks as
  JSON on `127.0.0.1:8098`. It shares Gluetun's namespace, so the dashboard's
  Services → VPN tab tests the same path qBittorrent uses. The port is bound to
  the host loopback only and is not reachable from the LAN.
- `churn` validates the effective `docker compose config --format json` before
  `compose up` and refuses to start `torrent` if any service could bypass the
  VPN namespace, publish its own ports, use a non-Gluetun network, expose the
  status agent beyond localhost, or if the firewall/DNS/IPv6 settings are
  unsafe.

Re-run the startup check at any time:

```bash
cd torrent && docker compose up --force-recreate vpn-check
```

A passing run ends with `PASS: torrent egress is confined to the VPN`. Check
`docker compose logs vpn-check` for the result of the last automatic startup check.

Before starting the torrent stack, churn starts a throwaway container on the
Compose network and verifies it has an IPv4 default route. If gluetun reports
`default route not found`, Docker's bridge or the existing Compose network is
broken; check `/etc/docker/daemon.json`, remove the stale network, and restart
Docker before rerunning churn.

Re-run the dashboard's VPN test by opening Services → VPN and pressing **Run
test again**, or restart the agent:

```bash
cd torrent && docker compose up -d --no-deps --force-recreate vpn-status
curl -s http://127.0.0.1:8098/status
```

Do not recreate `gluetun` by itself. Every torrent app shares its network
namespace, so if Gluetun is recreated the apps must be recreated too:

```bash
cd torrent && docker compose down && docker compose up -d
```

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

### Releasing

`Cargo.toml` is the single source of truth for the version. The `churn`
binary embeds it (`CARGO_PKG_VERSION`) and CI refuses to publish an image whose
`v*` tag does not match it. Use the helper so the version bump, lockfile, commit
and tag cannot drift apart:

```bash
scripts/release.sh 0.1.4
```

That updates `Cargo.toml` and `Cargo.lock`, commits `Release v0.1.4`, creates
the tag and pushes both. The published assets are what `install.sh` and
`churn update` download, and the image tag must match the same version. To
check the files without releasing:

```bash
scripts/check-version.sh          # Cargo.toml <-> Cargo.lock
scripts/check-version.sh v0.1.4   # ...and the tag
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

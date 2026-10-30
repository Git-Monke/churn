# churn

Interactive installer for a small self-hosted media + torrent setup.

Two roles, one machine each (or both on the same box):

| stack     | what it runs                                  | ports |
| --------- | --------------------------------------------- | ----- |
| `server`  | Jellyfin + Sonarr + Radarr                    | 8096, 8989, 7878 |
| `torrent` | qBittorrent + Prowlarr tunnelled through Mullvad WireGuard | 8080, 9696 |

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
server/.env      DATA_DIR, PUID, PGID, TZ
torrent/.env     the above + HOST_IP + Mullvad credentials (and the archive path)
```

`PUID`/`PGID` come from whoever owns the storage directory and `TZ` from the
host. Keys churn does not manage are preserved on rerun, so hand edits survive.
`.env` is gitignored — secrets never land in the repo.

## Running a stack

The installer starts the stacks for you. To bring them up again later (for
example after a reboot):

```bash
cd server  && docker compose up -d    # then open http://<ip>:8096 (Jellyfin),
                                     #   http://<ip>:8989 (Sonarr), http://<ip>:7878 (Radarr)
cd torrent && docker compose up -d    # temporary password: docker logs qbittorrent
```

Both web UIs are published on the `gluetun` container (the other two share its
network namespace), so Prowlarr is at `http://<ip>:9696`.

## Prowlarr and qBittorrent

Prowlarr, qBittorrent and gluetun share one network namespace, so qBittorrent is
reachable from Prowlarr at `http://localhost:8080` — no hostnames or VPN
round-trip needed.

The wiring is automatic on first `docker compose up`:

1. `qbittorrent-init` seeds `config/qbittorrent` with a stable qBittorrent API
   key before the app starts. The image otherwise regenerates a random WebUI
   password on every restart.
2. Once the apps are up, `prowlarr-init` reads Prowlarr's generated API key, the
   qBittorrent key and the Sonarr/Radarr keys, then wires everything through the
   APIs (all steps are idempotent):
   - creates the qBittorrent categories `prowlarr`, `tv` and `movies`;
   - registers qBittorrent in Prowlarr as a download client (category `prowlarr`);
   - registers Sonarr and Radarr as Prowlarr applications, so Prowlarr pushes
     its indexers to them;
   - registers qBittorrent in Sonarr and Radarr with the `tv` and `movies`
     categories.
3. Prowlarr and Sonarr/Radarr sit in different network namespaces, so they talk
   over the host's LAN address, written to `torrent/.env` as `HOST_IP` (auto-
   detected, override with `CHURN_HOST_IP`). gluetun gets that single address
   as `FIREWALL_OUTBOUND_SUBNETS`, so the VPN kill switch still blocks
   everything else.

Because both containers mount the same `${DATA_DIR}` at `/data`, download paths
line up without translation. qBittorrent saves to `/data/` and Prowlarr tags
its downloads with the `prowlarr` category.

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

Then add indexers under **Indexers** in Prowlarr; they propagate to Sonarr and
Radarr automatically.

## Sonarr and Radarr

Both run on the `server` box, outside the VPN, and share `/data` with Jellyfin.
Images are pinned (`sonarr:4.0.20.3014-ls1`, `radarr:6.4.4.10685-ls324`) so
upstream releases do not move under you. Bump those tags deliberately after
checking the release notes.

They are wired up automatically by `prowlarr-init`, so after both stacks are up
you only need to set root folders (`/data/media/tv`, `/data/media/movies`) and
add media.

`prowlarr-init` reads the Sonarr/Radarr API keys from `../server/config`, so it
expects both stacks on **one machine**. The installer starts `server` before
`torrent` for this reason. If the server stack was not up yet, re-run the wiring
after starting it:

```bash
cd torrent && docker compose run --rm prowlarr-init
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

`src/lib.rs` holds the testable core ([`question`](src/question.rs),
[`mullvad`](src/mullvad.rs), [`stack`](src/stack.rs),
[`envfile`](src/envfile.rs), [`system`](src/system.rs)); `src/main.rs` is the
wizard flow. Dedupe of questions, the VPN-before-storage ordering, and parsing
of Mullvad `.conf`/zip files are covered by `tests/installer.rs`; distro
detection and root-uid parsing by `tests/system.rs`.

`vendor/cliclack` is a local patch for path autocomplete: the first suggestion
is selected automatically, Tab completes it without submitting, and Enter only
submits the typed value.

# churn

Interactive installer for a small self-hosted media + torrent setup.

Two roles, one machine each (or both on the same box):

| stack     | what it runs                                  | ports |
| --------- | --------------------------------------------- | ----- |
| `server`  | Jellyfin                                      | 8096  |
| `torrent` | qBittorrent tunnelled through Mullvad WireGuard | 8080 |

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

- **Mullvad WireGuard credentials** — private key and interface address, both
  from a generated WireGuard config `.json`. The key input is masked.
- **Storage path** — one absolute host path for media and downloads. It is
  mounted at `/data` inside every container, so Jellyfin and qBittorrent agree
  on paths regardless of which machine they run on.

Answers are shared between installers, so selecting both roles asks for the
storage path once. Reruns prefill previous answers and reuse them if you press
Enter.

```bash
sudo ./target/release/churn --stacks server,torrent   # skip the menu
sudo ./target/release/churn --dry-run                # collect answers, write nothing
```

## What it writes

Only `.env` files; the compose files are static and committed.

```
server/.env      DATA_DIR, PUID, PGID, TZ
torrent/.env     the above + Mullvad credentials
```

`PUID`/`PGID` come from whoever owns the storage directory and `TZ` from the
host. Keys churn does not manage are preserved on rerun, so hand edits survive.
`.env` is gitignored — secrets never land in the repo.

## Running a stack

```bash
cd server  && docker compose up -d    # then open http://<ip>:8096
cd torrent && docker compose up -d    # temporary password: docker logs qbittorrent
```

## Development

```bash
cargo test
```

`src/lib.rs` holds the testable core ([`question`](src/question.rs),
[`stack`](src/stack.rs), [`envfile`](src/envfile.rs),
[`system`](src/system.rs)); `src/main.rs` is the wizard flow. Dedupe of questions
and the VPN-before-storage ordering are covered by `tests/installer.rs`; distro
detection and root-uid parsing by `tests/system.rs`.

# Prebuilt dashboard image + self-contained installer

## Goal

A user runs one installer binary on a fresh Linux box. It installs Docker,
writes the stack files, pulls the dashboard image from a registry, starts
everything, and completes Jellyfin setup. The target machine needs **no repo
checkout, no Node.js, no npm, no Rust** — only network access to pull images.

Two parts, in order:

1. **Publish** the dashboard image from CI (no local build on the target).
2. **Ship** the installer as a static binary that materializes its own compose
   files and scripts, so it does not depend on a checkout either.

Part 2 is a prerequisite for the stated goal. `envfile::root()` currently
defaults to the compile-time `CARGO_MANIFEST_DIR`, and `docker compose` is run in
`<root>/server` / `torrent` where the committed compose files and scripts are
expected to exist. A released binary run outside the build checkout therefore
points at a path that does not exist (or worse, at the developer's source tree).

## Current constraints that shape the design

- Every upstream is a host `127.0.0.1` address (Jellyfin, Sonarr, Radarr,
  Prowlarr, qBittorrent).
- `vpn-status` is published **loopback-only** by the torrent stack. A bridge
  container cannot reach it.
- The backend reads API keys from `../torrent/config/...` and `.env` from its
  own root.
- The backend derives the browser-facing Jellyfin URL from the host's LAN
  interface.
- Churn writes `JELLYFIN_API_KEY` to `server/.env` **after** `docker compose up`.
- The cache falls back from `server/cache/releases` to
  `server/.churn-cache/releases` to `$TMPDIR`.
- Churn already installs and enables Docker on Ubuntu, Debian, Fedora and Arch.

## Decisions

| Topic | Decision |
| --- | --- |
| Registry | GHCR: `ghcr.io/git-monke/churn-dashboard`, public package |
| Tagging | Immutable release tags `<cargo-version>`; `main` + PR builds are not used by releases |
| Runtime network | `network_mode: host`; no published ports |
| Image build source | CI only. The shipped compose has `image:` and **no** `build:` |
| Installer distribution | Static musl binaries on GitHub Releases + `install.sh` |
| Stack state root | `/var/lib/churn` by default; cwd/`CHURN_ROOT` for development |
| Assets | Embedded in the binary with `include_str!` and written on every run |
| Pinning | Churn writes `CHURN_DASHBOARD_IMAGE=<repo>:<version>` to `server/.env` |
| Upgrade | New installer binary writes the new tag; `compose up -d` pulls/recreates |
| API-key race | Churn force-recreates `dashboard` after `setup_jellyfin()` |

## Phase 0 — Make the installer independent of the checkout

### 0.1 Fixed state root

`src/envfile.rs::root()`:

```text
CHURN_ROOT set          -> that path
./server/docker-compose.yml exists -> cwd (developer/checkout mode)
otherwise               -> /var/lib/churn
```

Keep `/var/lib/churn` root-owned `0755`. All generated `.env`, config, cache and
materialized stack assets live there. `--uninstall` keeps its current semantics
(delete config/cache/.env, keep DATA_DIR).

Migration note for existing checkout installs: running the binary from the
checkout keeps using the checkout. To move an existing install, stop the
stacks, move `server/` and `torrent/` to `/var/lib/churn/`, and rerun. Put this
in the release notes.

### 0.2 Embed stack assets

New `src/assets.rs` with a single table:

```rust
pub struct Asset {
    pub path: &'static str,   // relative to the stack root
    pub body: &'static str,
    pub mode: u32,
}
```

Include:

- `server/docker-compose.yml`
- `torrent/docker-compose.yml`
- `torrent/resolv.conf`
- `server/scripts/server-init.sh`
- `torrent/scripts/{prowlarr-init,qbittorrent-init,vpn-check,vpn-lib,vpn-status}.sh`

`materialize(root)` creates the directories, writes atomically, and sets modes
(`0755` for scripts, `0644` otherwise). It runs on every install/rerun, so the
assets always match the installed binary. Document that hand edits to the
compose files are overwritten — the supported customization point is `.env`.

Add a Rust test that materializes into a temp dir and asserts the paths, modes
and non-empty contents. Add a CI check that the checkout still runs
`docker compose config` against the materialized files.

### 0.3 Ship the binary

Add a release workflow (Phase 1) that produces static
`x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` binaries plus
SHA-256 checksums. Add `install.sh`:

- detect `uname -m`, map to the asset name
- download the latest release binary + checksum from GitHub Releases
- verify, install to `/usr/local/bin/churn` (`0755`)
- print `sudo churn` as the next step

This is the only user-facing install step. Docker is still installed by churn
itself, so the user installs neither Docker nor Node manually.

## Phase 1 — CI: publish the dashboard image and the installer

### 1.1 `server/Dockerfile` + `server/.dockerignore`

Multi-stage `node:22-bookworm-slim`:

1. **build** — copy root + workspace `package.json`s and lockfile, `npm ci`,
   copy `backend/` and `frontend/` sources, `npm run build`,
   `npm prune --omit=dev`.
2. **runtime** — copy `node_modules`, `package.json`, `backend/package.json`,
   `backend/dist`, `frontend/dist`; `ENV NODE_ENV=production
   CHURN_SERVER_DIR=/app PORT=4000`; pre-create `/app/.churn-cache` owned by
   `node`; `USER node`; `CMD ["node", "backend/dist/index.js"]`.
   `HEALTHCHECK` uses Node's `fetch('/api/health')`.

`.dockerignore`: `node_modules`, `**/node_modules`, `backend/dist`,
`frontend/dist`, `.env`, `config`, `cache`, `.churn-cache`. This is both a size
and a secret-leak guard.

No backend code change is needed for the image; `resolveServerDir()` already
resolves `/app` from `/app/backend/dist/index.js`.

### 1.2 Workflows

`.github/workflows/dashboard-image.yml`:

- **PR**: build the image (no push) + run `npm test`/`npm run typecheck`, and
  smoke-test `docker run --rm --network none` with a minimal env by checking
  `/api/health` (the route is static, so it needs no upstreams).
- **push to `main`**: push `ghcr.io/git-monke/churn-dashboard:main` and `:sha-<short>`.
- **tag `v<version>`**: push `:<version>` (no `v` prefix) and `:latest`.
- buildx multi-arch `linux/amd64,linux/arm64`; `type=gha` cache;
  `permissions: contents: read, packages: write`; login with `GITHUB_TOKEN`.
- After the first push, set the GHCR package visibility to public once, in
  GitHub package settings. Private would force `docker login` on every target
  machine and break the "install nothing" goal.

`.github/workflows/release.yml` (tag `v<version>`):

- build the two musl binaries and checksums
- create/update the GitHub Release and attach the artifacts
- version coupling: the image tag equals the Cargo package version, and the
  churn binary embeds the same version. Both jobs must run from the same tag, or
  `v0.2.0` churn will pull a missing `:0.2.0` image.
- Forks that publish their own image set `CHURN_IMAGE_REPO` at build time
  (compiled-in default is `ghcr.io/git-monke/churn-dashboard`).

## Phase 2 — Compose service that pulls the prebuilt image

Add to the committed `server/docker-compose.yml` (this file is also embedded):

```yaml
  dashboard:
    image: ${CHURN_DASHBOARD_IMAGE:?run the churn installer to set this}
    container_name: churn-dashboard
    network_mode: host
    init: true
    user: "1000:1000"
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    pull_policy: missing
    environment:
      - NODE_ENV=production
      - CHURN_SERVER_DIR=/app
    volumes:
      - ./.env:/app/.env:ro
      - ./config:/app/config:ro
      - ../torrent/config/prowlarr:/torrent/config/prowlarr:ro
      - ../torrent/config/qbittorrent:/torrent/config/qbittorrent:ro
      - churn-cache:/app/.churn-cache
    tmpfs:
      - /tmp
    restart: unless-stopped

volumes:
  churn-cache:
```

- No `build:` in the shipped compose. Contributors build locally with
  `docker build -t churn-dashboard:dev server` and set
  `CHURN_DASHBOARD_IMAGE=churn-dashboard:dev`.
- Host networking keeps every loopback URL, the VPN agent and LAN detection
  working. It also means `HOST`/`PORT` in `.env` control exposure; the default
  stays `127.0.0.1:4000`.
- The two torrent mounts are narrow on purpose: only the files the backend
  reads.
- Named volume, not `./.churn-cache`, so container uid 1000 is independent of
  host `PUID`. Pre-creating the directory in the image gives a fresh volume the
  right ownership.
- `container_name` keeps `docker logs churn-dashboard` stable.

### 2.1 Write the pinned image reference

In `Stack::apply` for `Stack::Server`, add the managed key:

```text
CHURN_DASHBOARD_IMAGE=ghcr.io/git-monke/churn-dashboard:<CARGO_PKG_VERSION>
```

An explicit `CHURN_DASHBOARD_IMAGE` process env wins (same pattern as other
settings), so a user can override/pin without editing code. Because it is
managed, rerunning a newer installer upgrades the tag and the next
`compose up -d` pulls and recreates the container.

## Phase 3 — Installer lifecycle

### 3.1 Start order

`docker compose up -d` starts the dashboard along with Jellyfin/Sonarr/Radarr.
`pull_policy: missing` pulls the pinned image when it is not present. If the
pull fails, the install fails with Compose's error, same as any other image —
there is no local build to fall back to.

### 3.2 Fix the Jellyfin API-key race

`setup_jellyfin()` writes `JELLYFIN_API_KEY` to `server/.env` after the stack is
up, but the dashboard reads that file only at boot. After a successful
`setup_jellyfin()` for `Stack::Server`, run:

```text
docker compose up -d --no-deps --force-recreate dashboard
```

- log "dashboard restarted with the Jellyfin API key"
- skip in `--dry-run`
- fail loudly if the restart fails (the key is unusable otherwise)

### 3.2 Uninstall

Keep deleting `config/`, `cache/` and `.env`; also remove the `churn-cache`
volume? Decision: remove it, since it is a disposable search/media cache. Keep
the image (same as the current "images are left untouched" rule). Mention both
in the uninstall summary.

## Phase 4 — Verification

| Check | How |
| --- | --- |
| Clean install, no checkout | Fresh VM, `install.sh`, `sudo churn`, then use the dashboard |
| No Node/npm/Rust on host | `command -v node npm cargo` all empty |
| Image provenance | `docker inspect churn-dashboard --format '{{.Config.Image}}'` shows the pinned GHCR tag |
| Image is public | anonymous `docker pull ghcr.io/git-monke/churn-dashboard:<version>` |
| Architecture | amd64 and arm64 hosts |
| Health | `docker inspect --format '{{.State.Health.Status}}' churn-dashboard` |
| VPN tab | host-networked container reaches `127.0.0.1:8098` |
| LAN playback | open from another LAN device; stream URL uses host LAN IP |
| Secrets | `docker history --no-trunc` contains no API keys; image context excludes `.env`/`config` |
| Cache | search, restart container, search again from cache |
| Rerun | same binary: idempotent; newer binary: new tag pulled and container recreated |
| Upgrade/rollback | pin an older image ref in `.env` and `docker compose up -d dashboard` |
| Uninstall | containers, config, cache, `.env` and `churn-cache` removed; DATA_DIR kept |
| CI | PR image build + backend tests; tag publishes image and binaries atomically |

## Risks

- **Part 2 is a real refactor, not a packaging detail.** Moving the state root
  and embedding assets is the difference between "installer works" and
  "installer writes into the developer's checkout path".
- **Version skew.** A churn binary pinning an image tag that CI never pushed
  breaks installs. Always release both from one tag and add a smoke check.
- **Private GHCR package** forces `docker login`, breaking the goal. Make it
  public and document the one-time setting.
- **Host networking is Linux-only.** Already true for the torrent stack. State
  it rather than pretending bridge support.
- **Port 4000 conflict** with a leftover `npm start` is the most likely
  first-run failure; document it.
- **Compose assets are now generated by the binary.** Hand edits are overwritten;
  keep `.env` as the supported surface and say so.
- **Cache ownership.** Do not remove the pre-created `/app/.churn-cache` from the
  image; the named volume inherits its ownership.
- **Supply chain.** Optionally sign images with cosign and add a digest pinning
  step later; immutable version tags are the minimum now.

## Task order

1. Dockerfile + `.dockerignore`; prove locally with
   `docker run --network host` against the existing `.env` and loopback services.
2. `dashboard` service in compose; prove UI, VPN tab, cache, healthcheck.
3. Churn restart-after-Jellyfin and uninstall/volume handling.
4. Embedded assets + fixed `/var/lib/churn` state root + tests.
5. Image workflow (PR build, main/tag push) and make the GHCR package public.
6. Release workflow (musl binaries + `install.sh`) with the version coupling.
7. Docs: root README install path, server README development-only npm, release
   notes for existing installs.

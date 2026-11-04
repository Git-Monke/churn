# `churn update` — update the churn binary and the server dashboard

## Goal

Add a first-class update command that moves an installed host to the latest
published churn release in one step:

```bash
sudo churn update
```

It updates **both**:

1. the `churn` CLI binary itself (the same asset `install.sh` installs), and
2. the `ghcr.io/git-monke/churn-dashboard:<version>` image used by the server
   stack.

After replacing the binary it re-execs the new binary, which re-materializes the
new compose assets, pulls the matching dashboard image, updates the pin in
`server/.env`, recreates only the `dashboard` container, and verifies
`/api/health`. A failed dashboard update rolls back to the previous image.

## Non-goals

- Updating Jellyfin, Sonarr, Radarr, qBittorrent or Prowlarr. Their tags stay
  pinned and move deliberately.
- Touching `DATA_DIR`, generated config, caches or volumes.
- Updating the torrent stack.
- Package-manager integration (apt, Homebrew, etc.).

## Current state

- `install.sh` downloads `churn-<target>` plus `.sha256` from
  `https://github.com/git-monke/churn/releases/latest/download/`, verifies the
  checksum, and installs to `${CHURN_INSTALL_DIR:-/usr/local/bin}/churn`.
- `server/.env` carries `CHURN_DASHBOARD_IMAGE=<repo>:<CARGO_PKG_VERSION>`
  (`src/stack.rs:18`, `src/stack.rs:228`).
- `server/docker-compose.yml` uses that value with `pull_policy: missing`, so
  `docker compose pull` alone will not move an existing install to a new tag.
  The pin must be rewritten before restarting.
- `src/system.rs` already has streaming Compose helpers:
  `compose_up`, `compose_recreate_service`, `compose_down`, `compose_ps`.
- `ureq` is already a dependency and is used by the Jellyfin client.
- Releases are tagged `vX.Y.Z`; the image workflow refuses to publish unless
  the tag matches `Cargo.toml`.

## Decisions

| Topic | Decision |
| --- | --- |
| Source of "latest" | GitHub Releases API `releases/latest` |
| Binary asset | Same names as `install.sh`: `churn-x86_64-unknown-linux-musl`, `churn-aarch64-unknown-linux-musl` + `.sha256` |
| Binary replacement | Download to the executable's directory, verify, set `0755`, atomic `rename` over the running binary |
| Old binary backup | `<exe>.previous`; restored if the rename fails, removed after a successful re-exec handoff |
| Re-exec | After replacing the binary, `exec` it with `update --dashboard-only --to <version> --yes`, so the new code materializes assets and updates the dashboard |
| Recursion guard | `--dashboard-only` on the re-exec makes self-update impossible; no env marker needed |
| Pin | Rewrite `CHURN_DASHBOARD_IMAGE` with `envfile::upsert`, preserving comments and other keys |
| Image availability | `docker manifest inspect <ref>` before changing `.env` |
| Pull | `docker pull <ref>` before rewriting `.env`, so a failed pull changes nothing |
| Restart | `docker compose up -d --no-deps --force-recreate dashboard` |
| Health | Poll `http://127.0.0.1:<DASHBOARD_PORT>/api/health` for 60s |
| Dashboard failure | Restore the old pin and recreate the old container; the binary remains updated |
| Version override | `--to <X.Y.Z>` (also accepts `vX.Y.Z`), otherwise GitHub latest |
| `--check` | Read-only, no root/Docker required; reports binary and dashboard versions |
| Custom image | Refuse to update a non-churn dashboard image unless `--image <ref>` is given |
| Dev/checkout binary | Skip self-update when the running executable is under a Cargo `target/` directory |

## CLI

Update `HELP` and `Args` in `src/main.rs`.

```text
churn update [--check] [--to <version>] [--image <ref>] [--force]
             [--binary-only | --dashboard-only] [--dry-run] [-y]

  --check           print installed and latest versions; change nothing
  --to <ver>        update to a specific X.Y.Z instead of the latest release
  --image <ref>     override the dashboard image reference (development)
  --force           re-pull/recreate even when already on the target version
  --binary-only     update the CLI binary, skip the dashboard
  --dashboard-only  update the dashboard, skip the CLI binary
  --dry-run         print what would happen; do not download, write or start
  -y, --yes         skip confirmations
```

`churn update --check` behaves like `churn show`: no root check, no Docker
check, no writes. Applying a binary update requires root. Docker is only
required when the dashboard is updated.

## Flow

### 1. Resolve the target

- `--to` wins; normalize a leading `v`; require `^\d+\.\d+\.\d+$`.
- Else `CHURN_VERSION` if set (same convention as `install.sh`).
- Else `GET https://api.github.com/repos/Git-Monke/churn/releases/latest` with
  `User-Agent: churn/<version>` and a 10s timeout; parse `tag_name` and
  `html_url`.
- Normalize the release tag to a bare `X.Y.Z`.

New `src/update.rs` keeps this testable:

```rust
pub struct Release { pub version: String, pub url: String }
pub fn parse_latest_release(body: &str) -> io::Result<Release>;
pub fn normalize_version(value: &str) -> Result<String, String>;
pub fn image_ref(version: &str) -> String;
pub fn image_tag(image: &str) -> Option<&str>;
pub fn release_target() -> Result<&'static str, String>;
```

`release_target()` maps `std::env::consts::ARCH` to the same asset names as
`install.sh`. `image_tag` handles registry ports (`host:5000/image:tag`) and
rejects digest refs.

### 2. Read installed versions

- CLI: `env!("CARGO_PKG_VERSION")` of the running binary.
- Dashboard: read `CHURN_DASHBOARD_IMAGE` from `server/.env`; fall back to the
  repo with the running binary's version if the key is absent.
- Missing `server/.env` or compose file means the dashboard is not installed;
  `churn update` still updates the binary and reports the skipped dashboard
  (unless `--dashboard-only`, which then errors).

### 3. Check mode

Print both rows:

```text
churn      installed 0.1.3   latest 0.1.4
dashboard  installed 0.1.3   latest 0.1.4
```

Exit 0 when both are current, 1 when either needs an update, 2 on errors.
`--check` does not call Docker.

### 4. Plan and confirm

For an apply, print:

```text
churn
  current  /usr/local/bin/churn 0.1.3
  target   /usr/local/bin/churn 0.1.4
dashboard
  current  ghcr.io/git-monke/churn-dashboard:0.1.3
  target   ghcr.io/git-monke/churn-dashboard:0.1.4
```

If both are current and `--force` is absent, stop successfully with
`churn 0.1.4 and the dashboard are up to date`.

Unless `-y` is set, ask `Update churn and restart the dashboard?` defaulting to
true. `--dry-run` stops after printing the plan.

### 5. Self-update the binary

Skip when `--dashboard-only`, when already on the target version without
`--force`, or when the running executable lives under `target/debug` or
`target/release` (source checkout). In checkout mode print a clear note and
continue with the dashboard unless `--binary-only` was requested.

Otherwise:

1. Determine `exe = std::env::current_exe()` and its directory. Resolve
   symlinks so a versioned/symlinked install replaces the real file. Require
   the directory to be writable (root check already happened).
2. Download `churn-<target>` and `churn-<target>.sha256` from
   `https://github.com/Git-Monke/churn/releases/download/v<version>/`.
   Use `ureq`, follow redirects, set a `User-Agent`.
3. Parse the first 64-hex digest from the checksum file and verify the
   downloaded bytes with `sha2` (add `sha2 = "0.10"`; format the digest with
   `{:x}`, no extra hex crate).
4. Write to `exe.with_extension("new")` in the same directory, `chmod 0755`,
   `fsync`, then:
   - `rename(exe, exe.with_extension("previous"))` (best effort),
   - `rename(new, exe)`.
   If the second rename fails, restore the previous file and abort.
5. If `--binary-only`, or the server stack is not installed, stop here and
   remove `<exe>.previous`.
6. Otherwise re-exec the new binary with:

   ```text
   churn update --dashboard-only --to <version> --yes [--image <ref>] [--force]
   ```

   `--dashboard-only` bypasses the self-update code entirely, so this cannot
   recurse, even with `--force`. The new binary then materializes the new
   assets and updates the dashboard.
7. After the dashboard step succeeds, the new process removes
   `<exe>.previous` (computed from `current_exe()`). If the dashboard step
   fails, it keeps the backup and prints its path.

Use `std::os::unix::process::CommandExt::exec` on Unix. Because the old inode
is still running, replacing the file is safe.

### 6. Preflight, pull and pin the dashboard

Skip when `--binary-only` or the server is not installed.

- `docker manifest inspect <target>`; on failure:
  `image <ref> is not published; nothing changed`.
- `system::docker_pull(image, on_event)` (new helper next to the Compose
  helpers), streaming through `LiveLog`. Pulling first means a network or
  registry failure leaves both `.env` and the running container untouched.
- `assets::materialize(&envfile::root(), Stack::Server)` so the compose file
  matches the new binary.
- `envfile::upsert(&server_env, DASHBOARD_IMAGE_ENV, &target_ref)`.
- `system::compose_recreate_service(&Stack::Server.dir(), "dashboard", …)`.
  This already does `up -d --no-deps --force-recreate dashboard`, so Jellyfin,
  Sonarr and Radarr keep running.

### 7. Health check and dashboard rollback

- Read `DASHBOARD_PORT` from `server/.env` (default `Port::Dashboard`), then
  poll `http://127.0.0.1:<port>/api/health` every second for up to 60s.
- Success: print `churn 0.1.4; dashboard updated to 0.1.4`.
- Failure:
  - Capture the last ~100 lines of `docker compose logs dashboard` and print
    them (new `system::compose_logs` helper).
  - Restore the old `CHURN_DASHBOARD_IMAGE` with `upsert`.
  - Recreate the dashboard from the old ref.
  - Exit non-zero with `dashboard update failed; rolled back to 0.1.3` and note
    that the churn binary is already 0.1.4.
- If the rollback recreate also fails, leave the old pin in place, print the
  exact commands to inspect/start manually, and exit non-zero.

The old image stays in Docker's local cache, so rollback does not need a second
pull.

## Files touched

| File | Change |
| --- | --- |
| `src/update.rs` | New: release fetch/parse, version normalization, image refs, target triple, SHA-256 verify, plan struct |
| `src/lib.rs` | `pub mod update;` |
| `src/main.rs` | `update` dispatch, args, `update_host()`, `update_check()`, self-replace/re-exec, backup cleanup, health polling |
| `src/system.rs` | `docker_pull`, `docker_manifest_inspect`, `compose_logs` |
| `Cargo.toml` | `sha2 = "0.10"` |
| `src/envfile.rs` | Tests only if `upsert` lacks coverage for this case |
| `install.sh` | Comment that `churn update` uses the same release assets; no logic duplication |
| `README.md` | "Updating" section next to Install |
| `docs/src/introduction.md` | Short pointer to `churn update` |
| `.github/workflows/release.yml` | Optional: smoke-test the built binary's asset naming against `install.sh` |

## Tests

Unit / pure:

- GitHub release JSON parsing, including a `v` prefix and a missing `tag_name`.
- Version normalization and rejection of `latest`, `0.1`, `v0.1.4-rc1`.
- Image ref/tag parsing for `ghcr.io/...:0.1.4`, `localhost:5000/churn:dev`,
  and digest refs.
- `release_target()` matches the asset naming in `install.sh`.
- Checksum parsing accepts `<hash>  churn-<target>` and rejects short/invalid
  hashes; verify a known SHA-256 fixture.
- Update plan: same version, newer version, explicit `--to`, custom image,
  binary-only/dashboard-only.
- `envfile::upsert` keeps unrelated keys and comments when changing only
  `CHURN_DASHBOARD_IMAGE`.

Integration / manual:

- Install an older release with `install.sh`, run `churn update --check`,
  confirm exit 1 and no writes, then `churn update -y`; confirm the binary
  version, `.env` pin, container image and `/api/health`.
- Run `churn update` again; confirm "already up to date" and no restart.
- Corrupt the downloaded binary/checksum locally; confirm the binary is not
  replaced.
- Point `--image` at a non-existent tag; confirm the manifest check fails
  before `.env` is written.
- Start a deliberately unhealthy dashboard image with `--image`; confirm logs
  are shown and the previous image is restored and healthy.
- `--dry-run` changes nothing.
- Run from `target/debug/churn`; confirm self-update is skipped and the
  dashboard still updates.
- Run `--binary-only` on a host with no server install; confirm only the
  binary moves.

## README section

Under Install:

```markdown
## Update

Update the churn CLI and the server dashboard to the latest release:

    sudo churn update

Check without changing anything:

    churn update --check

`churn update` replaces the binary atomically and restarts only the dashboard
container. Jellyfin, Sonarr and Radarr stay on their pinned versions. Use
`--binary-only` or `--dashboard-only` to update one part.
```

## Deferred

- Update channels (`--channel main`) once there are moving dev images.
- Updating the pinned Jellyfin/Sonarr/Radarr tags behind `--include-services`.
- Signature verification beyond the published SHA-256 checksum.

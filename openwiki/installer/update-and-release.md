---
type: Release Engineering
title: Updates, releases and version pinning
description: How churn update replaces the binary and dashboard image, how release assets and checksums are produced and verified, how versions stay aligned, and how rollback works.
tags: [update, release, versioning, checksum, ci, rollback]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-531e8b45d9db18692bef1cea
    resource: repo://.github/workflows/dashboard-image.yml
  - id: openwiki-source-4d1d392666be6dfdd7a91a2e
    resource: repo://.github/workflows/release.yml
  - id: openwiki-source-03ffc32a0ca502ab67c54b25
    resource: repo://install.sh
  - id: openwiki-source-da65c1c77668cd623d9b4182
    resource: repo://scripts/check-version.sh
  - id: openwiki-source-76478c25db28b99104e23105
    resource: repo://scripts/release.sh
  - id: openwiki-source-b55a21a31ede1b56cd31a6a6
    resource: repo://src/main.rs
  - id: openwiki-source-0ecba5538b5fd9860f10332f
    resource: repo://src/update.rs
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Updates, releases and version pinning

The `churn` binary and the dashboard container image are released together and share one version. That version comes from `Cargo.toml`; the binary pins `ghcr.io/git-monke/churn-dashboard:<cargo version>` by default, and the release pipeline refuses to publish a tag whose matching image is not already public.

## Version sources

`scripts/check-version.sh` is the single gate:

```bash
scripts/check-version.sh          # Cargo.toml == Cargo.lock entry for churn
scripts/check-version.sh v0.1.4   # ...and the tag equals v<cargo version>
```

It reads the first `version = "..."` in `Cargo.toml` and the `churn` package entry in `Cargo.lock`. The dashboard workflow runs it on every build; the release workflow runs it with the tag in both jobs.

`update::normalize_version` accepts `X.Y.Z` or `vX.Y.Z` only: three numeric parts, no leading zeros, no pre-release suffixes or channels.

## `churn update`

### Target resolution

`resolve_target` picks, in order:

1. `--to <version>` (strict version validation);
2. the tag of `--image` when running `--dashboard-only` and it looks like a version;
3. `CHURN_VERSION` when set and not `latest`;
4. GitHub's `releases/latest`, normalized from `tag_name`.

An empty or `latest` value falls through to GitHub. Network failures abort the update.

### `--check`

`update --check` prints a comparison table and changes nothing:

```
churn      installed 0.1.3   latest 0.1.4
dashboard  installed 0.1.3   latest 0.1.4
```

Exit status is `0` when everything is current and `1` when something is stale, which makes it usable in scripts. A missing server install reports the dashboard as "not installed". `--dashboard-only` errors if there is no server install.

### What gets updated

| Flags | Binary | Dashboard |
| --- | --- | --- |
| none | yes | yes, when the server stack is installed |
| `--binary-only` | yes | no |
| `--dashboard-only` | no | yes |

Updates are skipped when the current version already equals the target, unless `--force` or an explicit `--image` is given. `--stacks` may only name `server` for update; `--binary-only` and `--dashboard-only` are mutually exclusive. `--dry-run` downloads and starts nothing, and `--yes` skips the confirmation.

A binary run from `target/debug` or `target/release` inside a checkout is detected by `is_checkout_binary`:

- a normal update warns and skips the binary, still updating the dashboard;
- `--binary-only` refuses outright, pointing at `install.sh`.

### Binary download and verification

`self_update`:

1. Maps `x86_64` → `x86_64-unknown-linux-musl` and `aarch64` → `aarch64-unknown-linux-musl`; other architectures are told to use `install.sh`.
2. Downloads `https://github.com/git-monke/churn/releases/download/v<version>/churn-<target>` with a 120-second timeout, `churn/<version>` user agent and a hard 64 MiB cap.
3. Downloads the `.sha256` sidecar, extracts the first 64-character hex token and compares SHA-256 digests.
4. Replaces the running executable atomically: write a sibling temp file, mode `0755`, `sync_all`, rename the old binary to `churn.previous`, rename the temp into place. A failed final rename restores the backup.

Any download, checksum or replacement failure leaves the old binary in place.

### Binary then dashboard handoff

If both halves need updating, the new binary is installed first, then re-executed as:

```
churn update --dashboard-only --to <version> --yes
```

with `CHURN_UPDATE_CHILD=1`, preserving `--image` and `--force`. The new binary owns the new Compose assets. If exec fails, `restore_binary` puts the previous binary back. On full success the `.previous` backup is removed.

### Dashboard update

`update_dashboard` works in the server stack directory:

1. Refuses when `CHURN_DASHBOARD_IMAGE` is set in the process environment, because Compose would ignore the `.env` change.
2. Refuses to replace a custom pinned image unless `--image` is passed.
3. Checks for a local image; otherwise verifies the tag exists remotely (`docker manifest inspect`).
4. Pulls the image when missing or `--force`, streaming pull output into the spinner.
5. Re-materializes the embedded server assets and upserts `CHURN_DASHBOARD_IMAGE` in `server/.env`.
6. Recreates only the `dashboard` Compose service.
7. Polls `http://127.0.0.1:<dashboard port>/api/health` for 60 seconds.

On failure, it prints the last 100 dashboard logs and calls `rollback_dashboard`, which restores the old image reference in `.env` and recreates the service again. The reported error distinguishes successful rollback from a failed one. If the binary half already ran, the error also names the kept `.previous` binary.

## Install script and version pinning

`install.sh` is the from-scratch path for hosts without a checkout:

- Linux only; `x86_64`/`amd64` and `aarch64`/`arm64` map to the musl assets;
- requires `curl` and root;
- downloads over HTTPS with `--proto '=https' --tlsv1.2`;
- verifies the sidecar with `sha256sum -c` or `shasum -a 256 -c`;
- installs to `/usr/local/bin` by default, mode `0755`.

Overrides:

| Variable | Meaning |
| --- | --- |
| `CHURN_REPO` | repository to download from |
| `CHURN_VERSION` | pin a release (`0.2.0`); default `latest` |
| `CHURN_INSTALL_DIR` | destination directory |

The script and the self-updater download exactly the same asset names and checksum format, so a pinned install and an in-place update are equivalent.

## Release workflow

`.github/workflows/release.yml` triggers on `v*` tags:

1. **binaries** matrix (`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`):
   - check tag against `Cargo.toml`;
   - `cross build --locked --release --target ...`;
   - copy to `dist/churn-<target>` and write `sha256sum` output to `churn-<target>.sha256`;
   - upload artifacts.
2. **publish**:
   - check the tag again;
   - read the version from `Cargo.toml`, then poll `docker manifest inspect ghcr.io/git-monke/churn-dashboard:<version>` for up to 10 minutes. Missing or private image → hard failure, because a fresh install would not be able to start the dashboard;
   - download all binary artifacts and create the GitHub release with generated notes.

The dashboard-image workflow also runs for the same tag, so the two workflows proceed in parallel; the publish job waits for the image to appear rather than publishing a release whose pinned image does not exist yet.

## Dashboard image workflow

`.github/workflows/dashboard-image.yml` triggers on pushes to `main`, `v*` tags, pull requests touching `server/**` or the workflow itself, and manual dispatch.

- **test** job: Node 22 with npm cache, `npm ci`, `npm run typecheck`, `npm test`.
- **image** job (needs test):
  - lowercases the GHCR path;
  - checks `Cargo.toml`/`Cargo.lock` agreement, plus tag agreement for tags;
  - QEMU/Buildx setup;
  - logs in to GHCR only for pushes;
  - metadata tags: branch ref, PR ref, `sha-<short>`, `v` prefix stripped to a semver tag, `latest` only for tag pushes, and `ci-smoke` for non-push events;
  - builds `server/` for `linux/amd64` on PRs and `linux/amd64,linux/arm64` on pushes, pushing only on pushes;
  - for PRs, runs the loaded `ci-smoke` image with the same hardening as Compose (`--read-only`, `--tmpfs /tmp`, `--init`, `--cap-drop ALL`, `no-new-privileges`) and curls `/api/health` and `/` for the SPA root.

## Release helper

`scripts/release.sh` automates the tag:

- must run on `main` with a clean tree (except `--dry-run`/`--no-push`);
- default mode bumps the newest semver tag by one patch, releases the current Cargo version when it is ahead, and repairs a newest tag whose tagged `Cargo.toml` does not match the tag;
- explicit `major`, `minor`, `patch` or `X.Y.Z` are accepted;
- updates only the top-level package version in `Cargo.toml` and only the `churn` entry in `Cargo.lock`;
- runs `scripts/check-version.sh <tag>` and `cargo check --locked`;
- commits `Release v<version>`, creates an annotated tag, and pushes branch plus tag (with `--force` when re-pointing an existing inconsistent tag).

`--force` re-points an existing tag whose Cargo version is already consistent; `--no-push` stops after the local tag and prints the push commands.

## Rollback summary

| Failure | Recovery |
| --- | --- |
| download or checksum mismatch | old binary untouched |
| binary rename failure | backup restored automatically |
| new binary cannot exec | `.previous` binary restored |
| dashboard pull/recreate/health failure | `.env` restored and dashboard recreated with the old image |
| dashboard rollback failure | error includes both failures |

## Related pages

<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [churn CLI and orchestration](/openwiki/installer/churn-cli.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)
<!-- openwiki: broken internal link [/openwiki/testing/testing-strategy.md] link "/openwiki/testing/testing-strategy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Testing strategy](/openwiki/testing/testing-strategy.md)
<!-- openwiki: broken internal link [/openwiki/installer/provisioning.md] link "/openwiki/installer/provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Provisioning and environment files](/openwiki/installer/provisioning.md)

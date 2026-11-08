---
type: Testing
title: Testing strategy and CI
description: The four testing layers — Rust unit tests, Rust integration tests with fake HTTP servers and a fake rsync, backend Vitest suites, frontend Vitest suites — plus the typecheck and build commands and the three GitHub Actions workflows that gate them.
tags: [testing, cargo, vitest, ci, github-actions, release, openwiki]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-531e8b45d9db18692bef1cea
    resource: repo://.github/workflows/dashboard-image.yml
  - id: openwiki-source-6d4b4e707b8d60b6ccfa3425
    resource: repo://.github/workflows/openwiki-update.yml
  - id: openwiki-source-4d1d392666be6dfdd7a91a2e
    resource: repo://.github/workflows/release.yml
  - id: openwiki-source-da65c1c77668cd623d9b4182
    resource: repo://scripts/check-version.sh
  - id: openwiki-source-542ba8e0a605539d70027ebe
    resource: repo://server/backend/test/routes.test.ts
  - id: openwiki-source-484f2e9677ebad9673aae438
    resource: repo://server/frontend/vite.config.ts
  - id: openwiki-source-f326ebef607426b4f9621a34
    resource: repo://server/package.json
  - id: openwiki-source-fd81537e52881c1d4eb8b4ae
    resource: repo://tests/installer.rs
  - id: openwiki-source-8ae7b4423e7384a3657c7a4d
    resource: repo://tests/jellyfin.rs
  - id: openwiki-source-b0b076c44e2bc590deeaa467
    resource: repo://tests/migrate.rs
  - id: openwiki-source-a3ede65d38711fc5d9295419
    resource: repo://tests/system.rs
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Testing strategy and CI

The repository has two independent test stacks that mirror the two deployables: Rust for the `churn` installer and TypeScript for the dashboard. There is deliberately no shared test framework — the Rust side tests installer orchestration and HTTP clients directly, while the dashboard suites exercise pure functions and the Fastify route layer in-process.

## Layer map

| Layer | Location | Runner | Count |
| --- | --- | --- | --- |
| Rust unit tests | `src/*.rs` `#[cfg(test)] mod tests` | `cargo test` | ~80 `#[test]` fns across 13 modules |
| Rust integration tests | `tests/*.rs` | `cargo test` | 33 tests in 4 files |
| Backend suites | `server/backend/test/*.test.ts` | Vitest | 31 files |
| Frontend suites | `server/frontend/src/**/*.test.ts` | Vitest | 7 files |
| Container smoke test | CI only | `docker run` + curl | 1 per PR |

## Rust: unit tests

Unit tests live beside the code they cover. The distribution is not uniform — the security and migration modules dominate because their logic is pure and observable:

| Module | Tests | Focus |
| --- | --- | --- |
| `src/security.rs` | 15 | every VPN-isolation rejection path, driven by `serde_json::json!` fixtures |
| `src/migrate.rs` | 16 | copy planning, progress parsing, destination validation |
| `src/update.rs` | 7 | version comparison and release-asset naming |
| `src/compose.rs` | 6 | JSON progress-frame parsing |
| `src/stack.rs` | 6 | question dedup, start order, `.env` merging |
| `src/system.rs` | 6 | root detection and Docker readiness |
| `src/ports.rs` | 5 | port validation and free-port search |
| `src/question.rs` | 4 | validators for keys, addresses, ports |
| `src/show.rs` | 4 | installed-state assembly |
| `src/assets.rs`, `src/envfile.rs`, `src/jellyfin.rs`, `src/live.rs` | 3 each | asset extraction, atomic env writes, key discovery, log tailing |
| `src/mullvad.rs`, `src/main.rs`, `src/lib.rs` | 0 | exercised through integration tests instead |

`src/security.rs` is the most instructive example: `safe_config()` builds a JSON value that matches a correct `docker compose config --format json`, and each test mutates exactly one field to assert the exact problem string. Because `verify_torrent_isolation` returns *all* problems rather than the first, tests can assert on a specific message without ordering dependence.

## Rust: integration tests

`tests/` exists for behaviour that unit tests cannot reach — real TCP, a real subprocess, or a real filesystem.

### `tests/jellyfin.rs` (620 lines, 9 tests)

A hand-rolled mock HTTP server on `TcpListener::bind("127.0.0.1:0")`:

- `mock_server(handler)` spawns a thread with a non-blocking accept loop and returns a `MockServer` whose `Drop` sets an `AtomicBool` and joins the thread, so a panic cannot leak the listener;
- `read_request` parses method, target, headers and `Content-Length` body into a `Request` struct with case-insensitive `header()` and a `path()` that strips the query string;
- `write_response` emits a fixed `HTTP/1.1` response with `Content-Length` and `Connection: close`.

The handler is a closure, so each test states the exact request/response pairs it expects. Covered flows:

| Test | Behaviour |
| --- | --- |
| `fresh_install_creates_user_and_writes_api_key` | full wizard then key extraction |
| `completed_setup_reuses_an_existing_churn_key` | idempotent rerun |
| `fallback_finds_key_after_a_204_create_response` | 204 with no body is not a failure |
| `libraries_are_created_at_the_media_root_and_data_root_is_removed` | path translation |
| `library_setup_is_a_noop_when_media_paths_are_already_correct` | no redundant writes |
| `real_time_monitoring_is_enabled_on_the_media_libraries` | `LibraryOptions` patching preserves unknown fields |
| `tailnet_subnets_are_added_without_losing_network_config` | subnet merge |
| `tailnet_setup_is_a_noop_when_the_subnets_are_already_present` | idempotence |
| `restart_waits_until_jellyfin_is_serving_again` | the outage must be observed before success |

<!-- openwiki: broken internal link [/openwiki/installer/jellyfin-setup.md] link "/openwiki/installer/jellyfin-setup.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
See [Jellyfin setup](/openwiki/installer/jellyfin-setup.md) for what each flow does.

### `tests/migrate.rs` (98 lines, 1 test)

Proves the rsync progress plumbing end to end by prepending a **fake `rsync`** to `PATH`:

- `PathGuard::prepend` saves the original `PATH` and restores it in `Drop`, so a panic cannot poison later tests;
- the fake script emits `rsync --info=progress2` style frames and, in the failure case, an error line;
- assertions confirm the frames reach the `CopyEvent` callback **and** that progress output never crowds the actual rsync complaint out of the failure message.

This is the only test that mutates process-global state (`std::env::set_var`). It is safe because that test binary runs a single test, which the comment states explicitly.

### `tests/installer.rs` (340 lines, 17 tests)

Drives the pure installer orchestration without touching the network or Docker:

- `stack::collect_questions` — `DataDir` asked once across both stacks, VPN questions before storage, credential questions replaced by the archive prompt, server-only selection yielding exactly `DataDir`, the four server ports;
- `Question` validators and `Section` ordering;
- `mullvad::entries` / `parse` against a zip built in-process with `zip::ZipWriter` and `SimpleFileOptions`;
- `envfile` round-trips and `ports::nearest_free`.

`temp_env` / temp-directory helpers keep each test isolated, and the zip fixture is generated rather than committed so the archive format stays exercised by the real `zip` crate.

### `tests/system.rs` (87 lines, 6 tests)

Pure parsing tests over `/etc/os-release` and `/proc/self/status` content: distro detection for the four supported distributions, derivative resolution through `ID_LIKE`, quoted values, unsupported IDs reported by name, the invariant that every supported distro has install steps mentioning `docker`, and `parse_uid` for root, non-root and missing Uid.

No test in the suite requires Docker, root, a network, or a VPN — an important property, since the CI runner has none of those.

## Dashboard: backend suites

`server/backend/test/` holds 31 Vitest files, one per subsystem. They run against the real Fastify app via `buildServer()` rather than a mock, with `makeConfig()` constructing an `AppConfig` whose service URLs point at unresolvable `.test` hostnames:

```ts
const serverDir = `/tmp/churn-test-${process.pid}-${++testServerCounter}`;
```

The per-process counter keeps state directories isolated, and upstream calls are intercepted with `vi.fn()`. Coverage clusters:

| Cluster | Files |
| --- | --- |
| Auth and routing | `auth.test.ts`, `routes.test.ts`, `config.test.ts`, `lan.test.ts` |
| Releases | `releases.test.ts`, `release-search.test.ts`, `release-search-persist.test.ts`, `release-pick.test.ts`, `release-cache.test.ts`, `release-name.test.ts`, `direct-grab.test.ts` |
| Downloads | `download-import.test.ts`, `download-recovery.test.ts`, `torrent-progress.test.ts`, `qbittorrent.test.ts`, `qbittorrent-show.test.ts`, `qbittorrent-activity.test.ts`, `swarm-watch.test.ts` |
| Library and media | `library-scan.test.ts`, `shows.test.ts`, `media-cache.test.ts`, `media-attribution.test.ts`, `next-episode.test.ts`, `jellyfin.test.ts`, `servarr.test.ts` |
| Playback | `playback.test.ts`, `resume.test.ts`, `introdb.test.ts` |
| Activity and stats | `activity.test.ts`, `activity-feed.test.ts`, `stats.test.ts` |

`routes.test.ts` is the widest: it builds the full server and asserts status codes, cookie behaviour and error shapes for the API surface.

## Dashboard: frontend suites

Seven files, all pure logic — no DOM rendering, no React component mounting:

| File | Covers |
| --- | --- |
| `server/frontend/src/hooks/use-hash-route.test.ts` | hash-route parsing and navigation |
| `server/frontend/src/features/library/continue-watching-items.test.ts` | continue-watching selection |
| `server/frontend/src/features/show/episode-watch-state.test.ts` | per-episode watched state |
| `server/frontend/src/features/releases/availability.test.ts` | release availability derivation |
| `server/frontend/src/features/releases/release-tiers.test.ts` | tier ordering |
| `server/frontend/src/features/player/playback-meta.test.ts` | playback metadata formatting |
| `server/frontend/src/features/player/use-player-shortcuts.test.ts` | keyboard shortcut mapping |

Components themselves are covered by `tsc --noEmit` and the production build rather than by assertions.

## Commands

```bash
# Rust: unit + integration
cargo test

# Dashboard: typecheck then tests, both workspaces
cd server && npm run typecheck && npm test

# Individually
cd server/backend  && npx vitest run          # 31 suites
cd server/frontend && npx vitest run          # 7 suites
cd server/backend  && npm run build           # tsc -p tsconfig.build.json
cd server/frontend && npm run build           # tsc --noEmit && vite build
```

The root `server/package.json` wires the workspaces:

| Script | Effect |
| --- | --- |
| `typecheck` | `tsc -p tsconfig.json` (backend) then `tsc --noEmit` (frontend) |
| `test` | backend `vitest run` then frontend `vitest run` |
| `build` | frontend build first, then backend `tsc -p tsconfig.build.json` |
| `dev` | `concurrently` — backend on 4001, Vite on 5173 proxying `/api` with `changeOrigin: false` so the backend's same-origin check sees the dev origin |

## CI workflows

Three workflows, each with a distinct trigger and a distinct gate.

### `dashboard-image.yml`

Triggers: push to `main`, `v*` tags, PRs touching `server/**` or the workflow itself, and manual dispatch.

```
test job                          image job (needs: test)
─────────                         ────────────────────────
checkout                          checkout
setup-node 22 + npm cache         normalize IMAGE to lowercase ghcr path
npm ci                            scripts/check-version.sh
npm run typecheck                 scripts/check-version.sh "$GITHUB_REF_NAME"  (tags only)
npm test                          setup-qemu + setup-buildx + login (push only)
                                  metadata-action tags
                                  build-push-action
                                  smoke test (non-push only)
```

The image job's gates are worth noting:

- **Version agreement.** `scripts/check-version.sh` compares the `version` in `Cargo.toml` with the `churn` entry in `Cargo.lock`, and, when passed a tag, asserts `v$cargo_version` equals it. A mismatch fails with `Cargo.toml is X but Cargo.lock is Y` and the hint to run `cargo check`. This exists because the binary pins `ghcr.io/<owner>/churn-dashboard:<CARGO_PKG_VERSION>`.
- **Tag scheme.** `type=ref,event=branch`, `type=ref,event=pr`, `type=sha,prefix=sha-`, `type=match,pattern=v(.*),group=1`, plus `latest` only on `v*` tags and `ci-smoke` only off-push.
- **Platforms.** `linux/amd64,linux/arm64` on push, `linux/amd64` otherwise, with `load: true` for non-push so the smoke test can run the image locally.
- **Smoke test (PRs only).** The loaded image runs with the same hardening as the Compose service — `--network host`, `--read-only --tmpfs /tmp`, `--init`, `--cap-drop ALL`, `--security-opt no-new-privileges` — then polls `/api/health` for up to 30 s and asserts `curl -fsS http://127.0.0.1:4100/ | grep -q 'id="root"'`, proving the built SPA is actually served. A `trap` removes the container on exit.

### `release.yml`

Triggers on `v*` tags only.

| Job | Steps |
| --- | --- |
| `binaries` (matrix: `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`) | `check-version.sh "$GITHUB_REF_NAME"`, install `cross`, `cross build --locked --release --target …`, copy to `dist/churn-<target>`, `sha256sum` into a `.sha256`, upload artifact |
| `publish` (`needs: binaries`) | `check-version.sh "$GITHUB_REF_NAME"`, verify the dashboard image exists, download artifacts, `softprops/action-gh-release` with generated notes |

The image-existence gate reads the version from `Cargo.toml` and polls `docker manifest inspect ghcr.io/<owner>/churn-dashboard:<version>` up to 60 times at 10 s intervals. Its failure message is explicit: `<image> is missing or not public; publish the image first`. This ordering matters because a release whose matching image is absent or private cannot be installed — the binary pins that tag. `release.yml` and `dashboard-image.yml` both trigger on `v*`, so they race by design and the poll absorbs it.

Static musl binaries are used so the installer runs on any distribution without glibc version constraints.

### `openwiki-update.yml`

Triggers: daily at `08:00` UTC and manual dispatch.

- `actions/checkout` with `fetch-depth: 0` — a shallow clone hides the commit the wiki last documented, and the update would then run against an empty change summary;
- installs `openwiki@0.9.0` plus optional `mermaid@11.16.0` and `jsdom@29.1.1` for diagram validation;
- runs `openwiki code --update --print` with `continue-on-error: true`, provider `openai`, model `gpt-5.6-terra`, and LangSmith tracing/connector keys from secrets;
- deletes `openwiki/.run.json` (`if: ${{ !cancelled() }}`) so transient run state never lands in the commit;
- builds the staged path list dynamically — `openwiki,AGENTS.md,.github/workflows/openwiki-update.yml` plus `CLAUDE.md` only when it exists, because `git add` on a missing path stages nothing;
- opens or updates a `openwiki/update` PR titled `docs: update OpenWiki` via `peter-evans/create-pull-request`;
- annotates the PR URL with a `::notice`, then re-raises the failure with `exit 1` if the OpenWiki step failed.

The PR body records `OpenWiki result: ${{ steps.openwiki.outcome }}` and states that a `failure` outcome intentionally preserves only the pages completed before the failure, so merging makes that partial progress the next baseline. This is exactly the durable-run behaviour described in [Maintenance](#maintenance) below.

Third-party actions in this workflow are pinned to full commit SHAs rather than tags.

## Conventions and gaps

Deliberate choices worth preserving when adding tests:

- **Exact messages, not substrings, where possible.** `security.rs` tests assert the exact problem string, so a reworded diagnostic forces a test update — a feature, since the strings surface to operators.
- **Collect rather than short-circuit.** `verify_torrent_isolation` returning `Vec<String>` lets a test mutate one field and assert one message.
- **Generate fixtures that encode a format.** The Mullvad zip is built with the `zip` crate, not committed, so the parser is tested against the writer's real output.
- **Fake at process boundaries only.** There is no mock framework on the Rust side; the Jellyfin tests use a real socket and the migration test uses a real script on `PATH`.
- **Dashboard upstreams are `vi.fn()` seams** on the real Fastify app, not a mocked HTTP layer.

Known gaps: no component-render tests on the frontend, no coverage thresholds anywhere, no test for `main.rs` argument parsing beyond unit tests in the modules it calls, and nothing exercises `docker compose up` in CI — the smoke test starts only the dashboard image. `mullvad.rs` has no unit tests because `country_for_entry` and parsing are covered through `tests/installer.rs`.

## Maintenance

```bash
scripts/check-version.sh          # Cargo.toml <-> Cargo.lock
scripts/check-version.sh v0.2.2   # ...and the tag
scripts/release.sh --dry-run      # plan a release without changing anything
scripts/release.sh patch          # bump, commit, tag, push
```

<!-- openwiki: broken internal link [/openwiki/installer/update-and-release.md] link "/openwiki/installer/update-and-release.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`scripts/release.sh` refuses to run with uncommitted changes other than `Cargo.toml`/`Cargo.lock`, which keeps release commits clean. See [Release and update flow](/openwiki/installer/update-and-release.md).

## Related pages

<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Backend architecture](/openwiki/dashboard/backend-architecture.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/frontend.md] link "/openwiki/dashboard/frontend.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Dashboard frontend](/openwiki/dashboard/frontend.md)
<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [churn CLI](/openwiki/installer/churn-cli.md)
<!-- openwiki: broken internal link [/openwiki/installer/update-and-release.md] link "/openwiki/installer/update-and-release.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Release and update flow](/openwiki/installer/update-and-release.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Torrent stack and VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md)

---
type: Provisioning Workflow
title: Jellyfin first-run setup from churn
description: How the installer drives Jellyfin's startup wizard, creates or reuses an API key, configures media libraries and tailnet access, restarts Jellyfin, and recreates the dashboard with the key.
tags: [jellyfin, provisioning, first-run, api-key, libraries, tailscale]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-00fefd037200709d249c4609
    resource: repo://src/jellyfin.rs
  - id: openwiki-source-b55a21a31ede1b56cd31a6a6
    resource: repo://src/main.rs
  - id: openwiki-source-8ae7b4423e7384a3657c7a4d
    resource: repo://tests/jellyfin.rs
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Jellyfin first-run setup from churn

After the server stack starts, churn configures Jellyfin over its HTTP API. On a fresh install this creates the first admin account and completes the startup wizard; on every run it ensures a valid API key and the expected library layout, then writes the key to `server/.env`.

The implementation is `src/jellyfin.rs`, orchestrated by `setup_jellyfin` in `src/main.rs`.

## When it runs and which URL it uses

`setup_jellyfin` runs only when the server stack was selected and only when `--dry-run` is false. The base URL is resolved in this order:

1. `JELLYFIN_URL` from the process environment;
2. `JELLYFIN_URL` from `server/.env`;
3. `http://127.0.0.1:<JELLYFIN_PORT>` from the generated `.env` or the default port.

`Jellyfin::new` trims trailing slashes and adds `http://` when the value has no scheme. Requests use a 5-second per-call timeout.

The installer polls `/System/Info/Public` once per second for up to 120 seconds and reports the detected version. Any non-200 answer is an error; a transport failure becomes "could not reach Jellyfin at <url>".

## Existing API key handling

Before provisioning, churn checks for an existing key from the process environment or `server/.env` and validates it with `GET /System/Info`:

- `200` → the key is valid; skip user setup and key creation.
- `401`/`403` → warn and create a new key.
- anything else → abort with the HTTP status.

This makes `churn` safe to rerun after a partial install or a Jellyfin password change.

## First-run wizard

If `StartupWizardCompleted` is false, `provision` runs the wizard in this order:

1. `GET /Startup/User` — Jellyfin creates its initial user lazily here. This request is required first; `POST /Startup/User` returns 404 if the user has never been materialized.
2. `POST /Startup/User` with `{ Name, Password }`. A `204` succeeds; a `403` is tolerated because a previous run may have set the user without completing the wizard.
3. `POST /Startup/Configuration` with server name `Churn`, `en-US` locale and English metadata defaults.
4. `POST /Startup/RemoteAccess` with `EnableRemoteAccess: false` and `EnableAutomaticPortMapping: false`.
5. `POST /Startup/Complete`.

Remote access stays disabled intentionally; LAN/loopback/tailnet access is handled through `LocalNetworkSubnets` instead of Jellyfin's remote-access switch.

### Admin credentials

`jellyfin_credentials` reads `JELLYFIN_ADMIN_USER` and `JELLYFIN_ADMIN_PASSWORD` from the environment or `.env`, but never persists the password:

- Username prompt defaults to `admin`, must be non-empty, at most 64 characters and cannot contain `/`, `\` or `:`.
- Password must be at least 8 characters; the interactive path asks twice and rejects a mismatch.
- With `JELLYFIN_ADMIN_PASSWORD` set (for automation), validation still applies and no prompt is shown.
- The installer prints the admin username but explicitly does not store the password.

## API key creation

`provision` authenticates with `POST /Users/AuthenticateByName` using a `MediaBrowser Client="churn", Device="installer", DeviceId="churn-installer"` authorization header. A 401 includes a hint to check the admin username/password.

`ensure_api_key`:

1. Lists `GET /Auth/Keys`.
2. Reuses the first unreleased key whose app name is `churn`.
3. Otherwise calls `POST /Auth/Keys?app=churn`.
4. Accepts both response styles: Jellyfin 10.11 returns `204` with no body; newer builds may return the created key as JSON.
5. If the body had no key, re-lists keys, filters to usable `churn` keys, sorts by creation date and takes the newest.

The new key is validated with `GET /System/Info` before being accepted, then written with `envfile::upsert` so `server/.env` is updated atomically while unrelated keys survive. A key that Jellyfin immediately rejects aborts with a log-inspection hint.

Jellyfin uses the key later for server-side requests; browser sessions still authenticate with user credentials.

## Library configuration

`ensure_libraries` creates and repairs two libraries:

| Name | Collection type | Path |
| --- | --- | --- |
| Movies | `movies` | `/data/media/movies` |
| Shows | `tvshows` | `/data/media/tv` |

For each library it:

1. Finds a folder by collection type or name.
2. Creates it with `POST /Library/VirtualFolders` when missing, or adds the media path with `POST /Library/VirtualFolders/Paths` when the folder exists but lacks the path.
3. Scans every existing library for a path exactly equal to `/data` and removes it. A `/data` library would index files that are still downloading.
4. Refreshes the library once if anything changed.
5. Re-reads the folders and enables `EnableRealtimeMonitor` in each library's `LibraryOptions` via `POST /Library/VirtualFolders/LibraryOptions`, round-tripping every unknown option unchanged.

The function returns a list of human-readable changes; the installer prints them. A rerun with correct paths returns an empty list and prints "already configured".

## Tailnet and LAN access

`ensure_tailnet_access` reads `GET /System/Configuration/Network` and appends missing entries to `LocalNetworkSubnets`:

```
127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
169.254.0.0/16, 100.64.0.0/10,
::1/128, fc00::/7, fe80::/10, fd7a:115c:a1e0::/48
```

The CGNAT range (`100.64.0.0/10`) and the Tailscale IPv6 range are the key additions: Jellyfin does not consider tailnet addresses local by default, and with remote access disabled it rejects them. The entire network configuration object is sent back unchanged.

Jellyfin applies this only on startup, so when the subnet list changed churn calls `POST /System/Restart` with the API key, then waits up to 120 seconds for the server to go down and come back. `restart_and_wait` deliberately requires seeing an outage before accepting a successful response, otherwise the old process could answer before it restarted.

## Dashboard restart

The dashboard container reads `JELLYFIN_API_KEY` at process start, but churn writes the key only after the stack is already running. `restart_dashboard` therefore calls:

```
docker compose up -d --no-deps --force-recreate dashboard
```

so the container boots with the key instead of running unconfigured.

## Failure behaviour

- Readiness timeout aborts install setup; the stack itself remains running.
- Admin validation errors re-prompt; setting `JELLYFIN_ADMIN_PASSWORD` to an invalid value is a hard error.
- Library or tailnet failures abort setup with the Jellyfin body truncated to 400 characters.
- A failed dashboard recreate is reported as an error after setup changes have already been applied.

## Relevant tests

`tests/jellyfin.rs` runs a local mock HTTP server and covers:

- fresh install creating the user and writing the API key,
- reusing an existing `churn` key,
- library creation at the media root and removal of a `/data` path,
- idempotent library setup,
- real-time monitoring enables only once,
- tailnet subnets added without losing other network config,
- no-op tailnet setup when subnets already exist,
- restart waiting until Jellyfin serves again.

## Related pages

<!-- openwiki: broken internal link [/openwiki/stack-topology/server-stack.md] link "/openwiki/stack-topology/server-stack.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Server stack topology](/openwiki/stack-topology/server-stack.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/auth-and-profiles.md] link "/openwiki/dashboard/auth-and-profiles.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Authentication, sessions and household profiles](/openwiki/dashboard/auth-and-profiles.md)
<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [churn CLI and orchestration](/openwiki/installer/churn-cli.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)

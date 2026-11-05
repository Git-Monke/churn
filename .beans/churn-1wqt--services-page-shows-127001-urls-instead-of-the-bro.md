---
# churn-1wqt
title: Services page shows 127.0.0.1 URLs instead of the browser's host
status: completed
type: bug
priority: normal
tags:
    - services
    - networking
created_at: 2026-11-05T17:22:12Z
updated_at: 2026-11-05T17:44:39Z
---

## Problem

The services page shows each service's internal URL, e.g.
`http://127.0.0.1:8096` for Jellyfin, even when the dashboard was reached over
Tailscale (`http://100.90.93.111:4000`). The links are also unusable from other
machines because they point at the client's own loopback.

The same internal URL is what `/api/services/:id/open` redirects to
(`server/backend/src/routes/services.ts`), so the "open" buttons are broken
outside the host machine too.

## Cause

`SERVICE_DEFAULTS` in `server/backend/src/config.ts` uses `http://127.0.0.1:<port>`,
and `server/backend/src/routes/status.ts` returns `service.url` verbatim. The
request-aware rewrite that already exists for video streaming
(`jellyfinPublicUrlForRequest`, using `x-forwarded-host`, `Forwarded` and `Host`,
falling back to the detected LAN address) is never applied to status or the
service-open redirect.

## Expected

- The address shown and linked on the services page uses the same host the
  browser used to reach churn: `http://100.90.93.111:8096` over Tailscale, the
  LAN IP over LAN, or the MagicDNS name over Tailscale.
- Works behind a reverse proxy via `X-Forwarded-Host`/`Forwarded`.
- An explicit public-URL override still wins when set.
- Internal health probes and upstream API calls must keep using the internal
  `127.0.0.1`/service-name URL — only what the browser sees changes.

## Likely approach

- Add a generic `serviceUrlForRequest(config, serviceId, headers)` next to
  `jellyfinPublicUrlForRequest` in `config.ts` (same `needsPublicHost` logic,
  per-service port preserved).
- Use it in `status.ts` for the `url` field and in `services.ts` for the redirect.
- Consider `SONARR_PUBLIC_URL`/`RADARR_PUBLIC_URL` (or one
  `SERVICES_PUBLIC_*`) override to match `JELLYFIN_PUBLIC_URL`.
- Keep the internal URL available internally (e.g. for health checks/detail text).

## Todos

- [x] Add a per-service request-aware public URL helper in `config.ts`
- [x] Return the browser-facing URL from `GET /api/status`
- [x] Make `/api/services/:id/open` redirect to the browser-facing URL
- [x] Add explicit public-URL overrides for sonarr/radarr (`SONARR_PUBLIC_URL`, `RADARR_PUBLIC_URL`)
- [x] Tests: Host header, X-Forwarded-Host and Tailscale-style 100.x resolution; internal probes unchanged

## Summary of Changes

- `serviceUrlForRequest(config, id, headers)` in `server/backend/src/config.ts` resolves any service URL against the browser's host (prefers `X-Forwarded-Host`, then `Forwarded`, then `Host`, falling back to the detected LAN address), keeping scheme, port and base path. `jellyfinPublicUrlForRequest` now delegates to it.
- Added `publicUrl` to `ServiceConfig`, populated from `JELLYFIN_PUBLIC_URL`, `SONARR_PUBLIC_URL` and `RADARR_PUBLIC_URL`; an explicit value always wins.
- `GET /api/status` now maps each probed service to its browser-facing URL while health probes keep using the internal loopback URLs.
- `/api/services/:id/open` redirects to the browser-facing URL.
- Tests: config unit tests for host/X-Forwarded-Host/tailnet resolution and arr overrides; route tests for status URLs and the open redirect over Tailscale. Docs updated in `server/README.md` and `docs/src/web-ui.md`.

# VPN security tab + runtime leak test

## Context

The torrent stack already fails closed at startup: `vpn-check` proves the public
exit is Mullvad, DNS uses Gluetun's resolver, direct `eth0` egress is blocked,
and the firewall exception is a local address. That proof is only visible in
`docker logs vpn-check`, and the dashboard's Services page only shows
Jellyfin/Sonarr/Radarr. Users have no ongoing, in-dashboard confirmation that
qBittorrent traffic is still confined to the VPN.

Goal: a runtime, on-demand leak test endpoint owned by the torrent stack, and a
VPN tab in the Services page that shows the verdict plus the individual checks
(exit IP/location, DNS, kill switch, IPv6, shared namespace).

Decisions from the user:

- Use a torrent-side check agent (a small always-on container that shares
  Gluetun's namespace), not Docker-socket access from the backend.
- Show exit identity/location, every leak check, container coverage, and check
  metadata.
- Run on tab open and on manual "Run test again"; no background polling.

## Approach

### 1. Torrent stack: `vpn-status` agent

Add a `vpn-status` service to `torrent/docker-compose.yml`:

- Image: the already-pinned `curlimages/curl:8.23.0` (Alpine base, includes
  BusyBox `nc` and `curl`).
- `network_mode: "service:gluetun"` — same namespace as qBittorrent, Prowlarr
  and FlareSolverr.
- Waits for `gluetun` healthy and `vpn-check` completed successfully.
- Mounts `torrent/resolv.conf` at `/etc/resolv.conf`, the shared check library,
  and the status script.
- Runs `busybox nc -l -l -p 8098 -e /scripts/vpn-status.sh` in the foreground;
  each connection executes the handler with the socket on stdin/stdout.
- Gluetun publishes the port host-loopback-only:
  `127.0.0.1:8098:8098`. The agent is never exposed on the LAN.
- Restart policy `unless-stopped`; no own ports/network.

### 2. Shared checks, single source of truth

Extract the reusable checks from `torrent/scripts/vpn-check.sh` into
`torrent/scripts/vpn-lib.sh`:

- HOST_IP/firewall-exception validation (`is_local_ipv4` equivalent).
- resolv.conf validation: all nameservers are `127.0.0.1`.
- Mullvad exit lookup: `https://am.i.mullvad.net/json`, verify
  `"mullvad_exit_ip": true`.
- Direct-egress probe: `curl --interface eth0` to `http://1.1.1.1/` must fail.
- IPv6 disabled check via `/proc/sys/net/ipv6/conf/all/disable_ipv6`.
- Coverage probe: TCP/HTTP connect to `127.0.0.1:8080` (qBittorrent),
  `127.0.0.1:9696` (Prowlarr) and `127.0.0.1:8191` (FlareSolverr). Any HTTP
  response counts as reachable; connection failure is reported as "not
  running", not as a leak.

`vpn-check.sh` keeps its behaviour and log lines, but sources the library and
still exits non-zero with a clear message if any check fails.

`torrent/scripts/vpn-status.sh` has two modes:

- `serve` (entrypoint): starts the persistent BusyBox `nc` listener.
- no args (handler): drains the request, runs the checks live, and writes an
  HTTP response with `Content-Type: application/json` and a JSON payload.

Agent JSON shape (camelCase except the embedded Mullvad payload):

```json
{
  "checkedAt": "2026-01-01T12:00:00Z",
  "durationMs": 1840,
  "secure": true,
  "checks": {
    "mullvadExit": true,
    "killSwitch": true,
    "dns": true,
    "ipv6": true,
    "firewallException": true
  },
  "mullvad": { "...": "raw am.i.mullvad.net/json" },
  "dns": { "nameservers": ["127.0.0.1"] },
  "firewall": { "directEgressBlocked": true, "exception": "192.168.1.10/32" },
  "ipv6": { "disabled": true },
  "coverage": [
    { "id": "qbittorrent", "reachable": true },
    { "id": "prowlarr", "reachable": true },
    { "id": "flaresolverr", "reachable": true }
  ]
}
```

`secure` is false if any of `mullvadExit`, `killSwitch`, `dns`, `ipv6` or
`firewallException` fails. Coverage is informational: a stopped app does not
mean traffic is leaking.

### 3. Churn's static security validation

Update `src/security.rs` so `compose up` still refuses unsafe layouts:

- `vpn-check` must mount `vpn-lib.sh` read-only.
- `vpn-status` must exist, use `network_mode: "service:gluetun"`, mount the
  static Gluetun `resolv.conf`, mount the library and both status-script paths
  read-only, publish no ports, and wait for `vpn-check`.
- If Gluetun publishes a container port `8098`, its host IP must be
  `127.0.0.1`; otherwise the agent must not be published at all.
- Extend the `safe_config()` fixture and add rejection tests.

### 4. Backend: protected `GET /api/vpn`

- Extend `AppConfig` with `vpn: { statusUrl, timeoutMs }`:
  - `VPN_STATUS_URL`, default `http://127.0.0.1:8098`.
  - `VPN_STATUS_TIMEOUT_MS`, default `25000` (checks include external curls),
    clamped to a sane range.
- Add `"vpn"` to `UpstreamServiceId` in `errors.ts`.
- New `backend/src/upstream/vpn.ts`:
  - Fetch `${statusUrl}/status` with `fetchJson`.
  - Validate the required booleans/arrays and reject malformed payloads with
    `UpstreamError("vpn", "invalid_response", ...)`.
  - Map the agent payload to the browser-safe `VpnStatusResponse`.
- `backend/src/routes/vpn.ts`: register the authenticated route, set
  `cache-control: no-store`, return the mapped response.
- Register the route in `server.ts` (normal auth hook applies; no public path).
- Response type (backend + frontend mirror):

```ts
type VpnCheckId =
  | "mullvad_exit"
  | "kill_switch"
  | "dns"
  | "ipv6"
  | "firewall_exception";

interface VpnCheck {
  id: VpnCheckId;
  label: string;
  passed: boolean;
  detail: string;
}

interface VpnCoverageEntry {
  id: "qbittorrent" | "prowlarr" | "flaresolverr";
  name: string;
  reachable: boolean;
}

interface VpnStatusResponse {
  checkedAt: string;
  durationMs: number;
  secure: boolean;
  exit: {
    ip?: string;
    country?: string;
    city?: string;
    hostname?: string;
    organization?: string;
    serverType?: string;
    mullvadExit: boolean;
  };
  checks: VpnCheck[];
  coverage: VpnCoverageEntry[];
  dnsNameservers: string[];
  firewallException?: string;
}
```

Error path: if the agent is not running or unreachable, the existing error
handler returns `502 upstream_error`; the frontend shows a clear "VPN status
agent is not running" message plus `cd torrent && docker compose up -d
vpn-status`.

Add backend tests:

- `GET /api/vpn` returns normalized data and marks `secure` correctly.
- A failed check produces `secure: false` but HTTP 200.
- Malformed agent JSON becomes `502 invalid_response`.
- Unreachable agent becomes `502 upstream_error`.
- Config parsing for `VPN_STATUS_URL` / `VPN_STATUS_TIMEOUT_MS`.

Update existing `AppConfig` fixtures in `backend/test/routes.test.ts`,
`auth.test.ts`, and `activity-feed.test.ts` with the new `vpn` field.

### 5. Frontend: Services tabs + VPN panel

- Add `fetchVpnStatus()` and mirror types in `frontend/src/api/types.ts` /
  `client.ts`.
- `ServicesPage.tsx`: use the existing `Tabs` component with `Services` and
  `VPN` triggers. The VPN panel mounts only while selected, so the query runs on
  tab open.
- New `frontend/src/features/vpn/VpnStatusPanel.tsx`:
  - `useQuery({ queryKey: ["vpn"], queryFn: fetchVpnStatus, staleTime: 60_000,
    refetchOnWindowFocus: false })`.
  - Loading state: skeleton card.
  - Error state: destructive alert with agent hint and a retry button.
  - Success, protected: prominent shield/check card "Your torrents are
    protected by Mullvad" with the exit IP and location.
  - Success, not protected: destructive alert "A VPN leak was detected" listing
    the failing checks.
  - Data points: exit IP, location, Mullvad server hostname, provider/server
    type, DNS resolver, firewall exception, IPv6 state, check time and
    duration.
  - Checks list: pass/fail icon + detail for each of the five checks.
  - Coverage: qBittorrent / Prowlarr / FlareSolverr, each "shares the protected
    namespace" or "not running".
  - "Run test again" button calls `refetch()` and disables while fetching.
- Keep the existing service grid and stale/error alert behaviour unchanged.

### 6. Docs and examples

- `torrent/.env.example`: document optional `VPN_STATUS_URL`/port if added.
- `README.md`: ports table, VPN leak protection section, dashboard VPN tab,
  agent endpoint and how to restart it.
- `server/README.md`: env table (`VPN_STATUS_URL`,
  `VPN_STATUS_TIMEOUT_MS`), API table (`GET /api/vpn`), VPN tab description.
- `docs/src/torrent.md`: service table + VPN section mention `vpn-status`.
- `docs/src/web-ui.md`: Services tabs, VPN tab, env/API entries.

## Files to modify

- `torrent/docker-compose.yml`
- `torrent/scripts/vpn-check.sh`
- `torrent/scripts/vpn-lib.sh` (new)
- `torrent/scripts/vpn-status.sh` (new)
- `torrent/.env.example`
- `src/security.rs`
- `server/backend/src/config.ts`
- `server/backend/src/errors.ts`
- `server/backend/src/types.ts`
- `server/backend/src/upstream/vpn.ts` (new)
- `server/backend/src/routes/vpn.ts` (new)
- `server/backend/src/server.ts`
- `server/backend/test/config.test.ts`
- `server/backend/test/routes.test.ts`
- `server/backend/test/vpn.test.ts` (new; or extend routes.test.ts)
- `server/backend/test/auth.test.ts`
- `server/backend/test/activity-feed.test.ts`
- `server/frontend/src/api/types.ts`
- `server/frontend/src/api/client.ts`
- `server/frontend/src/pages/ServicesPage.tsx`
- `server/frontend/src/features/vpn/VpnStatusPanel.tsx` (new)
- `README.md`
- `server/README.md`
- `docs/src/torrent.md`
- `docs/src/web-ui.md`

## Reuse

- Leak checks: `torrent/scripts/vpn-check.sh` (extracted to `vpn-lib.sh`).
- Compose validation: `src/security.rs` (`check_sidecar`, `check_vpn_gate`,
  `has_read_only_mount`, `is_local_ipv4`).
- Backend fetching/errors: `server/backend/src/http.ts` (`fetchJson`),
  `UpstreamError`, `server.ts` error handler and auth hook.
- Upstream client pattern: `server/backend/src/upstream/qbittorrent.ts`,
  `jellyfin.ts`, `servarr.ts`.
- Frontend UI primitives: `components/ui/tabs.tsx`, `card.tsx`, `alert.tsx`,
  `badge.tsx`, `button.tsx`, `separator.tsx`, `skeleton.tsx`.
- Query patterns: `useQuery` in `pages/LibraryPage.tsx` / `App.tsx`.
- Status page layout: `features/status/ServiceStatusGrid.tsx`.

## Steps

- [x] Create `vpn-lib.sh` with the shared checks and IPv4 validation.
- [x] Refactor `vpn-check.sh` to source it, preserving output and fail-closed
      behaviour.
- [x] Add `vpn-status.sh` (serve + CGI modes) and make it executable.
- [x] Add the `vpn-status` service, volumes and loopback port to compose.
- [x] Update `security.rs` validation and tests for the new sidecar and scripts.
- [x] Add backend config fields, `"vpn"` upstream id, types and upstream client.
- [x] Add `/api/vpn` route and register it.
- [x] Add backend tests and update all `AppConfig` fixtures.
- [x] Add frontend API types/client and the VPN panel component.
- [x] Add Services page tabs and mount the VPN panel on selection.
- [x] Update README, server README and mdBook pages.
- [x] Run `cargo fmt`, `cargo test`, backend `npm run typecheck`, `npm test`,
      frontend `npm run typecheck`, and `npm run build`.

## Verification

- `sh -n torrent/scripts/vpn-lib.sh torrent/scripts/vpn-check.sh
  torrent/scripts/vpn-status.sh` for shell syntax.
- `cd torrent && docker compose config --quiet` and `cargo test` (includes the
  isolation validator).
- Start the torrent stack and verify the agent directly:
  `curl -s http://127.0.0.1:8098/status | jq`.
- Confirm `vpn-check` still passes/fails with the same log messages.
- Backend tests with a stubbed agent cover protected, leaked, malformed and
  unreachable cases.
- with the stack up, open `#/services`, switch to VPN, confirm exit IP/location,
  every check, coverage and manual re-run. Stop `vpn-status` and confirm the
  tab shows the actionable unreachable state.
- Confirm `/api/vpn` returns 401 without a session and does not leak upstream
  URLs or keys.

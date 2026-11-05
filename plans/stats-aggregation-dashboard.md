# Stats aggregation dashboard: qBittorrent totals + disk usage

## Context

Bean: `churn-xmji` (`stats-aggregation-dashboard`).

The dashboard has no stats page today. The narrowed scope is three metrics:

- qBittorrent **total downloaded** (all-time)
- qBittorrent **total uploaded** (all-time)
- **Disk usage** as used / total / free with a visual percentage

Watch-time aggregation is dropped for now (it was never implemented, so there is
nothing to remove).

### qBittorrent API limitation

`GET /api/v2/sync/maindata` exposes `server_state.alltime_dl`,
`server_state.alltime_ul` and `server_state.free_space_on_disk`, but **no total
capacity**. A percentage needs both free and total.

The whole stack mounts the same `${DATA_DIR}` at `/data`, so the disk totals from
Sonarr's `GET /api/v3/diskspace` describe the same filesystem qBittorrent writes
to. The plan uses:

- **total** from Sonarr/Radarr `/api/v3/diskspace` (same `/data` volume)
- **free** from qBittorrent `free_space_on_disk` (authoritative for the
  qBittorrent filesystem), falling back to the arr `freeSpace`
- `used = total - free`, `usedPercent = used / total * 100` (clamped 0–100)

No dashboard container volume mount or compose change is required.

## Decisions

- New **Stats tab inside the existing Services page** (`Services / Stats /
  VPN`), for every authenticated user. No new top-level nav entry, to keep the
  app uncluttered. It is not admin-only: the request is for users to see
  storage use.
- **Donut chart**, not a full pie: used vs. free ring with the percentage used
  in the center. Hand-rolled SVG, no chart library dependency.
- Keep a textual readout next to the chart (`1.2 TB of 2.0 TB used · 800 GB
  free`) and an `aria-label` describing the same numbers.
- Refresh on page load and poll every 60 s; the header Refresh button already
  refetches active queries. No persisted/backend statistics history in this
  iteration.
- Partial upstream failure should degrade one card, not blank the page. The API
  returns 200 with an `errors` list; the UI shows placeholders/notice for the
  affected section. Only an unauthenticated request is rejected.
- No new chart colors: use `--primary` for used, `--muted` for free, and
  `--destructive` when used is above ~85%.

## Approach

### 1. Backend: qBittorrent main data

`server/backend/src/upstream/qbittorrent.ts`

- Add `QbittorrentServerState` with at least:
  `alltime_dl`, `alltime_ul`, `dl_info_data`, `up_info_data`,
  `free_space_on_disk` (all optional numbers).
- Add `QbittorrentMainData { server_state?: QbittorrentServerState }`.
- Add `getMainData()` calling `GET /api/v2/sync/maindata` with the existing
  Bearer headers and timeout. No `rid` parameter: the full state is what the
  stats page needs.
- Do **not** use `dl_info_data` / `up_info_data` as all-time totals; they are
  session values. They are only useful as a future fallback with a clear label.

### 2. Backend: disk capacity from the arrs

`server/backend/src/upstream/servarr.ts`

- Add `ServarrDiskSpace { path: string; label?: string; freeSpace?: number;
  totalSpace?: number }`.
- Add `getDiskSpace(): Promise<ServarrDiskSpace[]>` calling
  `GET /api/v3/diskspace` on the existing client.

Aggregation rule (`server/backend/src/stats.ts`, pure and testable):

1. Fetch Sonarr disk space and root folders (fallback: Radarr if Sonarr has no
   usable entry).
2. Match the diskspace entry whose `path` is a prefix of a root-folder path
   (e.g. `/data` for `/data/media/tv`). If nothing matches, use the entry with
   the largest `totalSpace`.
3. Read qBittorrent `free_space_on_disk`.
4. If free is missing, not finite, or greater than total, use the matched arr
   `freeSpace`.
5. Return `undefined` for disk usage when no positive `totalSpace` is available;
   the UI then shows free space text only instead of a fake percentage.

### 3. Backend: `/api/stats`

New `server/backend/src/routes/stats.ts`, registered in `server.ts` like the
other authenticated routes.

Response shape (mirrored in `server/backend/src/types.ts` and
`server/frontend/src/api/types.ts`):

```ts
interface StatsResponse {
  checkedAt: string;
  qbittorrent?: {
    totalDownloadedBytes: number;
    totalUploadedBytes: number;
  };
  disk?: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number; // one decimal, 0–100
  };
  errors: { source: "qbittorrent" | "disk"; message: string }[];
}
```

- `cache-control: no-store`, matching the status/VPN routes.
- Fetch qBittorrent and disk sources concurrently; record per-source failures in
  `errors` instead of failing the whole endpoint.
- Skip the qBittorrent section when `alltime_dl`/`alltime_ul` are both absent;
  add a qBittorrent error instead.
- Sanitize messages to the `UpstreamError` message; do not leak API keys or
  URLs.

### 4. Frontend: API + Services tab

- `server/frontend/src/api/types.ts`: add `StatsResponse` (and a
  `StatsErrorSource` helper type if useful).
- `server/frontend/src/api/client.ts`: `fetchStats(): Promise<StatsResponse>`
  via the existing `getJson`.
- `server/frontend/src/pages/ServicesPage.tsx`: add a `Stats` `TabsTrigger`
  between Services and VPN and render `<StatsPanel />` in its `TabsContent`.
  No changes to `use-hash-route.ts`, `App.tsx`, or `AppHeader.tsx`.

New `server/frontend/src/features/stats/StatsPanel.tsx`:

- `useQuery({ queryKey: ["stats"], queryFn: fetchStats, refetchInterval:
  60_000, staleTime: 30_000 })`.
- Loading: skeleton cards matching the final layout.
- Hard error with no data: destructive `Alert`.
- Partial `errors`: an informational `Alert` listing unavailable sections;
  metrics with no data show "Unavailable".
- Layout:
  - Section heading "Usage" / "qBittorrent transfer totals and storage on the
    media volume".
  - Two transfer cards: **Downloaded** (arrow-down icon) and **Uploaded**
    (arrow-up icon), both `formatBytes` with a caption "All time".
  - One storage card: donut + used/free/total legend.

New `server/frontend/src/features/stats/StorageDonut.tsx`:

- Props: `totalBytes`, `freeBytes`, `usedBytes`, `usedPercent` (or a single
  `disk` object).
- SVG ring (`viewBox="0 0 120 120"`, radius ~48, stroke ~14), rotated -90°.
  `strokeDasharray` = `usedFraction * circumference` + circumference; track
  uses `--muted`.
- Percentage centered with `text-3xl font-semibold`; below it "used".
- `role="img"` and an `aria-label` such as `Storage 62% used: 1.2 TB used of
  2.0 TB, 800 GB free`.
- Color: `--primary` normally, `--destructive` when `usedPercent >= 85`.
- Keep it presentational; formatting/percent math stays in `stats.ts`/page.

### 5. Byte formatting

`server/frontend/src/lib/format.ts` currently stops at GB, so all-time totals
would read like `1500.0 GB`. Extend `formatBytes` with TB (and PB) using the
same one-decimal style. Check existing call sites still render sensibly; no
behavioral change below 1 TB.

### 6. Tests and validation

Backend:

- `server/backend/test/qbittorrent.test.ts`: `getMainData()` URL/auth and
  passthrough `server_state`.
- `server/backend/test/servarr.test.ts`: `getDiskSpace()` URL/auth.
- New `server/backend/test/stats.test.ts`: pure aggregation
  - downloaded/uploaded mapping
  - disk matching by root-folder prefix and largest-total fallback
  - qBittorrent free preferred; arr free fallback
  - free > total and missing totals
  - percent rounding/clamping at 0 and 100
  - partial source errors
- `server/backend/test/routes.test.ts`: authenticated `/api/stats` success,
  unauthenticated 401, partial failure still 200 with `errors`, `no-store`
  header. Use the existing mocked `fetch` pattern.

Frontend:

- `npm run typecheck` and `npm run build` (no component test harness exists).
- Manually verify the donut at 0%, mid-range, >85%, and with disk unavailable.

## File checklist

Backend:

- [x] `server/backend/src/upstream/qbittorrent.ts` — main data types + client
- [x] `server/backend/src/upstream/servarr.ts` — disk space types + client
- [x] `server/backend/src/stats.ts` — pure aggregation
- [x] `server/backend/src/routes/stats.ts` — `/api/stats`
- [x] `server/backend/src/types.ts` — response types
- [x] `server/backend/src/server.ts` — route registration
- [x] backend tests above

Frontend:

- [x] `server/frontend/src/api/types.ts`, `api/client.ts`
- [x] `server/frontend/src/pages/ServicesPage.tsx` — Stats tab
- [x] `server/frontend/src/features/stats/StatsPanel.tsx`
- [x] `server/frontend/src/features/stats/StorageDonut.tsx`
- [x] `server/frontend/src/lib/format.ts` — TB/PB

No Rust, torrent-stack, compose, or installer changes.

## Resolved decisions

- **Placement:** Stats tab inside the existing Services page.
- **Visibility:** all signed-in users; no admin guard.
- **Disk definition:** shared `/data` volume; total from Sonarr/Radarr
  `/api/v3/diskspace`, free from qBittorrent `free_space_on_disk`. A
  percentage is impossible from qBittorrent alone.

---
# churn-xmji
title: Stats aggregation dashboard
status: completed
type: feature
priority: normal
created_at: 2026-11-05T00:24:12Z
updated_at: 2026-11-05T20:00:55Z
---

Implemented. Stats live under **Services → Stats** for every signed-in user.

## Metrics

- [x] qBittorrent all-time total downloaded (`server_state.alltime_dl`)
- [x] qBittorrent all-time total uploaded (`server_state.alltime_ul`)
- [x] Disk usage: used / free / total and % used

## Data sources

- qBittorrent `GET /api/v2/sync/maindata` → all-time totals and `free_space_on_disk`
- Total capacity from Sonarr `GET /api/v3/diskspace` (fallback Radarr), matched to a root-folder mount (same `/data` volume)
- If qBittorrent's free space is missing or inconsistent, fall back to the arr `freeSpace`

## Visual

- [x] SVG donut chart (used vs. free) with percentage in the center
- [x] Text readout: used / free / total
- [x] Donut switches to `--destructive` at ≥85% used
- [x] `formatBytes` extended to TB/PB

## Summary of Changes

- Added `getMainData()` to the qBittorrent client and `getDiskSpace()` to the arr client.
- Added `server/backend/src/stats.ts` for pure aggregation and `GET /api/stats` (`routes/stats.ts`, registered in `server.ts`).
- The endpoint reads qBittorrent and Sonarr/Radarr concurrently and returns per-source `errors` instead of failing the whole page.
- Added `StatsPanel` and `StorageDonut` under `server/frontend/src/features/stats/`.
- Added a **Stats** tab to `ServicesPage` (Services / Stats / VPN).
- Added backend tests for aggregation, disk selection, both clients, and route behavior.
- Watch-time aggregation remains out of scope.

Plan: `plans/stats-aggregation-dashboard.md`.

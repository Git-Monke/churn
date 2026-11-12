---
# churn-lnul
title: 'Dashboard Prowlarr search: 7/7 indexers finished, 0 results'
status: scrapped
type: bug
priority: low
created_at: 2026-11-12T21:22:10Z
updated_at: 2026-11-12T21:22:10Z
---

## Report

The dashboard's release search shows "7/7 indexers finished, 0 results" and the
assumption was that this was another permission problem.

## Investigation

- Prowlarr's API is reachable and authenticated: `GET /api/v1/indexer` returns
  200 with 7 enabled indexers (1337x, EZTV, LimeTorrents, The Pirate Bay,
  Torrent Downloads, Uindex, YTS).
- Replaying the dashboard's exact request
  `/api/v1/search?query=A%20Parks%20and%20Recreation%20Special%202020&indexerIds=N&type=search&limit=100&categories=2000`
  returns `[]` for all seven indexers. Prowlarr's log confirms the dashboard
  issued exactly those queries.
- The manual search that did return hits was `query=Parks and rec` with **no
  category filter**; it returns 184 TV-category (5000) releases, i.e. episodes
  of the series, not the 2020 special and not a Radarr movie release.
- Sonarr has no series configured and Radarr has exactly one movie
  (`A Parks and Recreation Special (2020)`), which is the item being searched.
- The "7/7 indexers" count comes from `/api/v1/indexer` inside the dashboard; a
  missing/unreadable API key produces "Prowlarr API key is not configured" or
  "could not list its indexers", so the dashboard-to-Prowlarr auth path works.

## Reasons for Scrapping

Not a defect. Prowlarr genuinely returns zero results for the query the
dashboard sends for that movie, so "7/7 finished, 0 results" is accurate. The
manual results came from a different query (`Parks and rec`) and a different
category (TV). The Zotero/Math Content Extractor errors pasted in the dev log
are unrelated browser-extension noise.

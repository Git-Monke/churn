---
type: User Workflow
title: Library browsing, search and requests
description: How the dashboard reads the Jellyfin library, builds continue-watching rows, searches across Sonarr and Radarr, creates requests with quality/root-folder options, tracks requested titles, attributes them to people, and cancels or deletes them.
tags: [library, search, requests, sonarr, radarr, jellyfin, deletion]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-4c488d2c1b0d9c804cce8975
    resource: repo://server/backend/src/media-attribution.ts
  - id: openwiki-source-badc3e460e0fcfc49eb69f0b
    resource: repo://server/backend/src/resume.ts
  - id: openwiki-source-440ba4c9658360688408a1bb
    resource: repo://server/backend/src/routes/library.ts
  - id: openwiki-source-12e114140f9a9ef42b72f488
    resource: repo://server/backend/src/routes/requested.ts
  - id: openwiki-source-3c6bd2a9803b7bb307c406cc
    resource: repo://server/backend/src/routes/requests.ts
  - id: openwiki-source-d54d219d6efb46b16d49ecb0
    resource: repo://server/backend/src/routes/search.ts
  - id: openwiki-source-0f64d48395c1334d28c17508
    resource: repo://server/backend/src/search.ts
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Library browsing, search and requests

This page covers the read-mostly side of the dashboard: what is in the library, what to watch next, how to find something new, how a request is created, and what happens when a title is cancelled or deleted.

## Library and continue watching

`GET /api/library` uses the signed-in user's Jellyfin token, not only the admin API key. It first checks Jellyfin's public system info:

| Condition | Response state |
| --- | --- |
| Jellyfin unreachable or unauthorized | `unreachable` / `unauthorized` with an empty list |
| First-run wizard not complete | `setup_required` |
| No `JELLYFIN_API_KEY` | `unconfigured` |
| Normal | `ok` with mapped items |

Items are mapped by `mapJellyfinItem`, filtered to playable library entries, then decorated with `addedBy` attribution from the attribution store. Jellyfin image URLs are rewritten to `/api/library/images/:itemId?...`, which the backend proxies with a 24-hour cache header. Image query parameters are validated (`type` is `Primary`/`Backdrop`, sizes 1–2000).

`GET /api/library/resume` merges three Jellyfin lists:

- **Resume** — partially watched items, newest first. These become the backbone cards; episodes collapse to the most recently played episode per series.
- **Next Up** — one candidate episode per series. A next-up card is shown only if the series has at least one completed episode (`played` list) and the series is not already represented by a resume card.
- **Played** — completed episodes, used to gate next-up and to order series activity.

Cards are sorted by last activity (resume timestamp or the series' latest completion), capped at 12, and images prefer episode stills / movie backdrops over 2:3 posters. A failing Next Up or Played lookup never hides the resume row.

## Cross-service search

`GET /api/search?q=` requires authentication and a query of 2–120 characters. It runs Sonarr and Radarr lookups in parallel with a timeout of `max(requestTimeoutMs, searchTimeoutMs)`.

For each service the route:

1. Calls the upstream lookup.
2. Lists the local library in parallel, so results can be marked `inLibrary`.
3. Marks `available` using the signed-in user's Jellyfin library when available (TVDB ids for series, TMDB ids for movies).
4. Maps results with provider ids, ratings, genres, seasons and a backend-owned artwork URL.
5. Interleaves the two service result lists by upstream relevance rank.

Artwork is never hot-linked directly. `mediaCoverUrl` only accepts `https` poster URLs on an allowlist (`artworks.thetvdb.com`, `banners.thetvdb.com`, `www.thetvdb.com`, `image.tmdb.org`, `assets.fanart.tv`) with image extensions, and `/api/search/images/:service?url=` proxies the bytes. This prevents the proxy from becoming an SSRF vector.

Series are considered available when Sonarr's statistics show at least one episode file and `episodeFileCount >= totalEpisodeCount`; movies when Radarr reports `hasFile`.

## Request options

`GET /api/requests/options` returns, per arr:

- quality profiles,
- root folders with accessibility and free space,
- defaults chosen by `pickDefaultQualityProfile` and `pickDefaultRootFolder`.

The default quality profile deliberately prefers a profile naming both 720p and 1080p, then 1080p, then 720p, and scores 4K/Ultra-HD profiles negative so a fresh request does not default to 2160p. The default root folder is the first accessible folder.

If either the profile or folder lookup fails, the route still returns the data it has, plus a service state and detail message.

## Creating a request

`POST /api/requests` accepts either:

```json
{ "kind": "movie", "tmdbId": 12345, "options": { "qualityProfileId": 1, "rootFolderPath": "/data/media/movies" } }
```

or the series equivalent with `tvdbId`. Options are optional; defaults come from the request-options response.

The route then:

1. Looks up the title upstream (`tmdb:<id>` or `tvdb:<id>`).
2. Lists the arr library, quality profiles and root folders.
3. Resolves and validates the chosen profile/folder (both must exist; the folder must be accessible).
4. If the title is already in the library, returns `already_exists` and refreshes cached metadata instead of adding a duplicate.
5. Otherwise adds the title **unmonitored with search disabled** (`searchForMovie: false`, `searchForMissingEpisodes: false`, all seasons unmonitored for series).
6. Records cached metadata in the media cache and attribution for the signed-in user.
7. Warms release search in the background (`warmMovie` / `warmSeries`) so the detail page's chooser has data, without starting a download.

This is the contract behind the README statement that a request adds the title to the library but does not itself start a download.

## Requested-library tracking

`GET /api/library/requested` lists titles known to Sonarr and Radarr even when Jellyfin does not have them yet. Each item carries provider ids, metadata, `available`, and `addedBy` attribution. Metadata is cached opportunistically so release search has it without extra upstream calls.

The endpoint is independent of Jellyfin, so it still works while Jellyfin is down.

## Cancellation and deletion

Two paths exist, and the backend tries hard to preserve arr ownership.

### Cancel a requested title

`DELETE /api/library/requested/:service/:id` (and the internal path used by the UI) runs `cancelRequestedTitle`:

1. Finds qBittorrent torrent hashes matching the title and loads the arr identity.
2. Removes every queue record for that series/movie, tolerating 404 because season packs can produce sibling records.
3. Deletes the series/movie from Sonarr/Radarr.
4. Removes attribution.
5. Deletes the matching qBittorrent torrents **after** the arr delete succeeded, so a failed arr delete never touches the download client.
6. Invalidates cached release searches for that title.
7. Refreshes Jellyfin immediately and again after 1.5 seconds (a scan can otherwise miss files deleted mid-scan).

### Delete from the Jellyfin library

`DELETE /api/library/jellyfin/:itemId` loads the item with the user's token (Jellyfin 10.11 rejects API-key-only item lookups), verifies it is a Movie or Series, then:

- If a Sonarr/Radarr title matches by provider id — or, when ids differ, by normalized title plus a compatible year (series ±1 year, movies exact) — it delegates to `cancelRequestedTitle` so the arr remains the owner.
- Otherwise it deletes the Jellyfin item, removes attribution, removes matching qBittorrent torrents by title/year, and returns `{ status: "cancelled", service: "jellyfin" }`.

An ambiguous match (more than one arr title) returns `409 ambiguous_arr_title` rather than deleting the wrong title.

## Attribution

`media-attribution.ts` persists `media-attribution.json` in `CHURN_STATE_DIR` with version 1. Keys are provider identities only:

- `movie:tmdb:<id>`
- `series:tvdb:<id>` (falling back to `series:tmdb:<id>`)

Each entry stores the Jellyfin user id/name and an ISO timestamp. Writes are serialized through a promise chain; a failed write emits a warning rather than failing the request. Attribution is read by the library and requested-library routes and removed during cancellation/deletion.

## Relevant tests

`server/backend/test/routes.test.ts` covers library state handling, continue-watching mapping, requested-library metadata caching, deletion/cancellation of Jellyfin-only and arr-backed titles, qBittorrent cleanup and image proxying. Request validation and option resolution are covered in the same route suite, and title matching helpers are covered by the qBittorrent/shows tests.

## Related pages

<!-- openwiki: broken internal link [/openwiki/dashboard/release-discovery.md] link "/openwiki/dashboard/release-discovery.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Release discovery and ranking](/openwiki/dashboard/release-discovery.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/downloads-and-sync.md] link "/openwiki/dashboard/downloads-and-sync.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Downloads, activity and library sync](/openwiki/dashboard/downloads-and-sync.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/frontend.md] link "/openwiki/dashboard/frontend.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Dashboard frontend](/openwiki/dashboard/frontend.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/auth-and-profiles.md] link "/openwiki/dashboard/auth-and-profiles.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Authentication, sessions and household profiles](/openwiki/dashboard/auth-and-profiles.md)

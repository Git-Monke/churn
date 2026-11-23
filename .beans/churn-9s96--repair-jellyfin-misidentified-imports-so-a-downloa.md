---
# churn-9s96
title: Repair Jellyfin misidentified imports so a downloaded movie shows as playable
status: todo
type: bug
priority: high
created_at: 2026-11-21T16:47:46Z
updated_at: 2026-11-21T16:47:46Z
---

A title can be downloaded and imported correctly (`/data/media/...`, Radarr/Sonarr `hasFile=true`) yet the dashboard never treats it as downloaded: search keeps offering **Request/Requested**, and the movie page sticks on **Waiting for Jellyfin** forever. Jellyfin usually shows the file under the wrong poster/title/overview. Reported by the user 2026-11-21: Jellyfin indexes a movie with the wrong metadata and "the frontend never shows it as downloaded even though it was downloaded and imported (because the movie names don't match)".

## Root cause

churn uses Jellyfin's *metadata* as the identity of the imported file, and Jellyfin identifies by filename guess (TMDB/IMDb lookup). When the guess is wrong, every join fails:

- Search availability: `server/backend/src/routes/search.ts:188` `loadJellyfinAvailability` builds `tmdbIds`/`tvdbIds` from `mapJellyfinItem`; a misidentified item carries a different TMDB id, so `SearchResult.available` is false while Radarr `inLibrary` is true and `server/frontend/src/features/search/SearchResultCard.tsx:47` renders it as "Requested".
- Movie page: `server/backend/src/routes/movies.ts:173` `findJellyfinMovieByTmdb` matches only `ProviderIds.Tmdb`; no match → `imported: true` (`movies.ts:180`) → `MoviePage.tsx` `movieAction` shows "Waiting for Jellyfin" indefinitely instead of Play.
- Import watcher: `server/backend/src/library-scan.ts:533` `isResolved` matches `tvdbId` (`:551`) / `tmdbId` (`:574`) via `findByProvider` (`:585`); a misidentified item never resolves, so it keeps rescanning for the retry window and then gives up.
- Library page reads Jellyfin directly (`routes/library.ts`), so the title also appears under the wrong name — the user sees a phantom entry plus a missing one.
- `server/backend/src/routes/requested.ts:187` `findArrTitleMatch` already falls back to normalized title + year, but that fallback is only used for delete/reconcile, never for availability.

Meanwhile churn already holds both things it needs:

- **Ground truth location**: the arr library folder. `ServarrLookupBase.path` (`server/backend/src/upstream/servarr.ts:89`) is the movie/series folder, arr history gives `movieId`/`seriesId` (`library-scan.ts:344-355`), and Sonarr/Radarr/Jellyfin all mount `MEDIA_DIR` at `/data/media` (`server/docker-compose.yml:14,28,42,66`), so paths compare directly. `library-scan.ts:398` `isDirectDownloadIndexed` already matches Jellyfin items by `Path` overlap (`findItemForContentPath` `:461`, `pathsOverlap` `:480`) — that is why direct downloads heal.
- **Correct identity**: cached at request time in `MovieMetadataCacheEntry` (`server/backend/src/media-cache.ts:10`) / `SeriesMetadataCacheEntry` (`:22`): `title`, `year`, `tmdbId`, `tvdbId`, `imdbId`, written by `movieMetadataEntry`/`seriesMetadataEntry` (`:172`/`:200`) from `routes/requests.ts:232`, and refreshed from the arr on every requested-library load (`routes/requested.ts` `cacheMovieMetadata`).

So the join key is Jellyfin's unreliable guess, while the reliable key (path) and the correct identity (cache) are already present. Fix: locate the item by path, then tell Jellyfin exactly which title it is.

## Plan

1. **Jellyfin identify client** — add `applyRemoteSearch(itemId, identity)` to `server/backend/src/upstream/jellyfin.ts`:
   `POST /Items/RemoteSearch/Apply/{itemId}?replaceAllImages=false` with body
   `{ "ProviderIds": { "Tmdb": "<id>", "Imdb": "<imdbId>" }, "Name": "<title>", "ProductionYear": <year> }`.
   This is the endpoint behind Jellyfin's own **Identify** dialog: the controller sets `item.ProviderIds = searchResult.ProviderIds` and then runs `RefreshFullItem(..., ReplaceAllMetadata = true, SearchResult = result)` (verified in jellyfin v10.11.11 `Jellyfin.Api/Controllers/ItemLookupController.cs:244-278`). Requires elevation — churn's API key is admin (installer creates it in `src/jellyfin.rs`). It re-fetches from TMDB/IMDb by id instead of by name, and writes nothing into the media tree.
2. **Path-first import resolution** — rework `isResolved` in `server/backend/src/library-scan.ts`:
   - resolve the arr resource for the history event (`getMovie`/`getSeries`, `upstream/servarr.ts:417,421`) to get `path`, and load the cached identity from `MediaCache`;
   - locate the Jellyfin item by path overlap (needs `Path` + `ProviderIds`, already requested by `listItemsByType`);
   - path match is what decides "indexed at all"; provider ids only decide whether the identity needs repair;
   - on mismatch call `applyRemoteSearch` **once per item/import** (bounded — never inside the 5s poll loop), then re-read the item and treat the import as resolved. Keep provider-id match as the fast path; keep the existing scan/retry when no item is at the path.
3. **Movie detail fallback** — `routes/movies.ts:332 findJellyfinMovieByTmdb`: when the provider lookup misses and `movie.path` is known, fall back to path overlap so the page flips playable and gets the real `jellyfinId` immediately. The repair then runs from the same path (or on demand) instead of waiting for the watcher window.
4. **Search availability** — after repair the existing `tmdbIds` check passes. While repair is pending/offline, treat `hasFile` + path match as available so search does not advertise a downloaded title as Requestable. Keep the path check cheap: reuse the item list already loaded.
5. **Series** — same path-first resolve on the Series item, identify by `tvdbId` (and `tmdbId` when present); keep the existing seasons+episodes requirement so a half-indexed series still triggers a rescan.
6. **Tests** (`server/backend/test`):
   - `library-scan`: a Jellyfin Movie with the wrong `ProviderIds.Tmdb` sitting at the imported path resolves, and `applyRemoteSearch` is called exactly once with the cached TMDB id; no path match stays unresolved; a provider-id match triggers zero identify calls.
   - `upstream/jellyfin`: `applyRemoteSearch` URL/query/body shape, 204 success, 404 tolerated.
   - `routes/movies`: radarr detail page matches a misidentified item by path and sets `jellyfinId`.
7. **Verify live**: force a misidentification (rename the video file so the name and TMDB guess disagree, or patch `ProviderIds` on an item), import through churn, confirm the identify call rewrites name/year/ids, the movie page becomes Play, and search stops offering Request.

## Alternatives considered

- **NFO-first**: enable Radarr/Sonarr NFO writing and let Jellyfin's local NFO reader identify from `<uniqueid type="tmdb">`. Rejected as the primary fix: the installer deliberately removes NFO savers (`src/jellyfin.rs:523` `drop_nfo_savers`, rationale at `:686-687`: reader lists are left alone because a curated `.nfo` is the user's), so churn would start writing into the media tree and could fight user-curated metadata. It also only prevents future bad guesses, not already-misindexed items. Valid later hardening.
- **Title/year matching everywhere** (like `findArrTitleMatch`): fails exactly in the reported case — Jellyfin's wrong title. Cannot be the fix.
- **`POST /Items/{itemId}` metadata update**: sets display fields but does not re-fetch from TMDB, and Jellyfin's provider identity (what every join uses) may not change. Insufficient.

## Open questions

- Confirm the TMDB internet provider is enabled in the Movie library's `TypeOptions` on existing installs; `EnableInternetProviders: true` is set (`src/jellyfin.rs:521`), but the provider list is not touched.
- Should repair also run on the `hasFile=true && jellyfinId===undefined` detail path (on-demand self-heal) in addition to the watcher? Cheap and makes the bug fixable by opening the title.
- What if Jellyfin merged the file into an existing item at a different path? Path match then finds nothing; falls back to today's behavior (rescan, then give up) — no regression.

## Todos

- [ ] `upstream/jellyfin.ts`: `applyRemoteSearch` (POST Items/RemoteSearch/Apply, elevation, once)
- [ ] `library-scan.ts`: path-first `isResolved`, cached identity, one-shot identity repair
- [ ] `routes/movies.ts`: path fallback in `findJellyfinMovieByTmdb`
- [ ] `routes/search.ts`: `hasFile`/path fallback so availability is not lost while repair is pending
- [ ] series path: path-first resolve + tvdb identify
- [ ] backend tests: identify client, path resolution + single repair, movie detail fallback
- [ ] docs: note identification repair in `server/README.md` / docs
- [ ] live verification with a deliberately misidentified import

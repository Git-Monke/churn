# Added-by tags + “Added by me” library filter

## Context

The library already merges three sources: Jellyfin items, Sonarr/Radarr titles,
and live qBittorrent downloads. It has no idea who asked for a title, so the
household cannot answer “who added this?” or narrow the grid to their own
additions.

This plan implements two existing beans together:

- `churn-hqr4` — Tag media by who added it.
- `churn-o0u5` — Filter library by “added by me”.

The tag is a Churn-owned attribution, not a Sonarr/Radarr tag. It is recorded
when a request is created through Churn and persisted alongside the existing
profile/session state. Titles added directly in Sonarr, Radarr, Jellyfin, or
before this change stay untagged.

### Confirmed decisions

- **Storage:** a versioned JSON file in the existing `CHURN_STATE_DIR`.
- **UI:** an independent “Added by me” toggle that composes with the existing
  All/Movies/Series tabs.
- **Attribution point:** the authenticated user who creates a request through
  `POST /api/requests`. `already_exists` responses do not claim ownership.
- **No backfill:** attribution that was never recorded cannot be recovered.
- **Deletion clears attribution** so a later re-add is owned by the new adder.
- **No download-service coupling:** the tag stores only TMDB/TVDB identity and
  the person. Sonarr/Radarr are metadata and release-search sources; they are
  not downloaders and do not appear in the tag.

### Non-goals

- Tagging titles added outside Churn.
- Filtering by every household member (the toggle is self-only).
- Editing attribution after the fact.
- Writing tags into Sonarr/Radarr.

## Approach

### 1. Attribution store

New `server/backend/src/media-attribution.ts`:

```ts
export interface MediaAddedBy {
  /** Jellyfin user id; stable across renames. */
  id: string;
  /** Display name captured at request time. */
  name: string;
}

export interface MediaIdentity {
  kind: "movie" | "series";
  tmdbId?: number;
  tvdbId?: number;
}

export interface MediaAttributionStore {
  get(identity: MediaIdentity): MediaAddedBy | undefined;
  record(identity: MediaIdentity, addedBy: MediaAddedBy): Promise<void>;
  remove(identity: MediaIdentity): Promise<void>;
}
```

- Canonical key: movies use `movie:tmdb:<id>`, series use `series:tvdb:<id>`.
  Items without the relevant provider id are not tagged.
- File: `<stateDir>/media-attribution.json`, schema
  `{ version: 1, entries: [{ key, addedBy, addedAt }] }`.
- The map is keyed only by provider identity, so no service/arr id is stored and
  no downloader concept leaks into the attribution.
- Load or write a corrupt/missing file as an empty map and log through the
  existing Fastify logger hook.
- Writes are atomic (`<file>.tmp` + rename) and serialized through one promise
  chain so concurrent adds cannot clobber each other.

### 2. Record attribution when a request is added

In `server/backend/src/routes/requests.ts`:

- `POST /api/requests` already runs behind the global auth hook; read
  `request.auth.user` via `requireAuth`.
- Pass the user and store into `addMovieRequest` / `addSeriesRequest`.
- After a successful add (not `already_exists`), record the final resource’s
  TMDB/TVDB identity and `{ id: user.id, name: user.name }`. The arr resource is
  used only to obtain metadata; no service/arr id is stored.
- Attribution persistence is best-effort: the arr add already succeeded, so a
  write failure logs a warning instead of returning an error.
- `already_exists` leaves any existing attribution untouched.

### 3. Enrich API responses

Add `addedBy?: MediaAddedBy` to:

- `RequestedLibraryItem` in `server/backend/src/types.ts` and the frontend API
  types.
- `LibraryItem` in both type files.

Enrichment:

- `server/backend/src/routes/requested.ts`: after mapping Sonarr/Radarr
  resources, attach `attribution.get({ kind, tmdbId, tvdbId })` to each item.
  Pass the store into `registerRequestedLibraryRoutes` and
  `loadRequestedLibrary`.
- `server/backend/src/routes/library.ts`: annotate each mapped Jellyfin item the
  same way, so attribution survives even if the arr title is later removed but
  the media is still in Jellyfin.
- `server/backend/src/server.ts`: create the store once and pass it to both
  route registrations and `registerRequestRoutes`.

### 4. Clear attribution on removal

Because the tag has no arr id, removal resolves the title’s provider ids first:

- In `cancelRequestedTitle` (`routes/requested.ts`), load the movie/series
  before deleting (the existing cleanup already reads it when qBittorrent is
  configured), compute the identity, and call `remove(identity)` after the arr
  delete succeeds.
- In the Jellyfin delete path (`routes/library.ts`), call
  `remove({ kind, tmdbId, tvdbId })` using the Jellyfin item’s provider ids.
- Best-effort cleanup: removal failures are logged but do not fail the delete.
- A tag with no matching library title is harmless; a later Churn add overwrites
  it.

### 5. Frontend merge and filter

- `frontend/src/features/library/library-entries.ts`: add
  `addedBy?: MediaAddedBy` to `LibraryEntry`; fill from the library or requested
  item (first non-null wins) while merging.
- `frontend/src/pages/LibraryPage.tsx`:
  - read the signed-in user with `useAuth()`;
  - add an independent `addedByMe` state;
  - place a small `UserRoundIcon` button next to the search field, with
    `aria-pressed` and the label “Added by me”, visible only when a user is
    known;
  - apply the filter after search and compose it with the existing type tabs:
    `searched → (addedByMe ? mine : all) → type`.
  - tab counts follow the mine-filtered set; show “N of M” in the header as the
    existing search does;
  - when the toggle yields nothing, show a specific empty state with a “Show
    all” action.
- `frontend/src/features/library/LibraryGrid.tsx`: render a subtle
  `Added by {name}` line in the card’s metadata area (truncated, full name in
  the `title` attribute). No attribution → no line.

### 6. Tests

- New `server/backend/test/media-attribution.test.ts`:
  - records and looks up by TMDB/TVDB identity;
  - persists and reloads from the state file;
  - ignores records without a provider id;
  - `remove`;
  - corrupt/missing file starts empty;
  - serialized writes keep both records.
- Extend `server/backend/test/routes.test.ts`:
  - after a successful request, `/api/library/requested` sends `addedBy` with
    the logged-in user;
  - `already_exists` does not overwrite an existing attribution;
  - cancelling a requested title removes its attribution.
- No frontend test suite exists; verify with typecheck and production build.

### 7. Docs

Update `docs/src/web-ui.md`:

- Library section: who gets tagged and what “Added by me” does.
- API table note: library responses may include `addedBy`.
- State section: mention `media-attribution.json` next to `auth-state.json`.

## Files touched

- `server/backend/src/media-attribution.ts` (new)
- `server/backend/src/server.ts`
- `server/backend/src/types.ts`
- `server/backend/src/routes/requests.ts`
- `server/backend/src/routes/requested.ts`
- `server/backend/src/routes/library.ts`
- `server/frontend/src/api/types.ts`
- `server/frontend/src/features/library/library-entries.ts`
- `server/frontend/src/features/library/LibraryGrid.tsx`
- `server/frontend/src/pages/LibraryPage.tsx`
- `server/backend/test/media-attribution.test.ts` (new)
- `server/backend/test/routes.test.ts`
- `docs/src/web-ui.md`

## Verification

```bash
cd server
npm test -w backend
npm run typecheck
npm run build
```

Then manually: sign in as two people, add one movie and one series as each,
confirm the card line, toggle “Added by me” (also combined with the type tabs),
reload to confirm the tag persists across a backend restart, and cancel one
title to confirm it disappears from that person’s filter after re-adding.

## Bean handling

Implement `churn-hqr4` first (store + request recording + response fields + card
line), then `churn-o0u5` (toggle). Both beans ship together and get a
`## Summary of Changes` before being marked completed. Leave all changes in the
working tree for review; no commit until approved.

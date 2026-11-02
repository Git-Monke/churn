# Library scanning phase and fast Jellyfin refresh

> **Superseded (scan trigger only):** the trigger is now Sonarr/Radarr's
> `downloadFolderImported` history event with a resolution check, not the
> qBittorrent completion poll. See `plans/import-triggered-scan.md`. The
> scanning/`scan_failed` card states described here are unchanged.

## Context

When a download finishes, Radarr/Sonarr immediately report the file as available,
but Jellyfin may not have indexed it yet. The Library card therefore flips to
**Available** while `entry.library` is still missing, so the card has no play
link. A hard reload does not help because Jellyfin's index has not changed.

Goal:

- Show a distinct **Scanning** phase when the arr has the file but Jellyfin does
  not expose the library item yet.
- Run an always-on backend poll of qBittorrent (1s) and trigger a Jellyfin
  library scan whenever a download completes, independent of the dashboard.
- Poll Jellyfin much faster while a title is scanning, so the card becomes
  playable as soon as the item is indexed.
- If scanning does not finish within 2 minutes, show a scan problem state.

## Decisions

- The scan trigger runs in the backend on a 1-second qBittorrent poll. The UI
  does not drive or trigger scanning.
- First poll also catches completed torrents whose qBittorrent `completion_on`
  is recent. "Recent" is a constant window (10 minutes), not a user setting.
- One scan per completion. No follow-up scan timer.
- Completions seen in the same poll are coalesced into one refresh; if a
  refresh is already running, the next poll handles any new completion.
- Scanning applies to movies and series.
- Scanning times out after 2 minutes into a `scan_failed` state. There is no
  manual scan endpoint; if Jellyfin indexes later the card still recovers.

## Approach

### Backend: always-on completion watcher

Add `server/backend/src/library-scan.ts` containing:

- `isTorrentDownloadComplete(torrent)` — true when qBittorrent reports
  `progress >= 1`, or `amount_left === 0` with a positive size.
- `refreshJellyfinLibrary(config)` — extracted best-effort helper around
  `createJellyfinClient(...).refreshLibrary()`, shared with the cancel/delete
  path.
- `createLibraryScanWatcher(config, options?)` — a 1-second poller with:
  - `start()`, `stop()`, and a testable `pollOnce()`;
  - `createQbittorrentClient(...).getTorrents()` on each tick;
  - transition detection (`incomplete -> complete`);
  - first-poll detection for completed torrents whose qBittorrent
    `completion_on` is within the recent window;
  - one Jellyfin refresh per poll when at least one completion was detected;
  - no follow-up timer and no activity-feed coupling;
  - state pruning for torrents that disappear;
  - injectable `now`, `refresh`, and interval values for tests;
  - best-effort refresh failures that never terminate the poller.

Extend `QbittorrentTorrent` with optional `completion_on?: number`.

Start the watcher in `server.ts` only when both the qBittorrent and Jellyfin API
keys are configured. Register an `onClose` hook to stop it.

### Frontend: Scanning and failed states

Update `server/frontend/src/features/library/library-entries.ts`:

- Extend `LibraryEntryStatus` with `"scanning"` and `"scan_failed"`.
- When a requested item is `available` but no matching `library` item exists,
  set the status to `"scanning"` instead of falling through to Available.
- Keep existing `available` / `both` / `downloading` / `requested` behavior when
  a Jellyfin item exists or when no arr file is available yet.

Add a small frontend hook, e.g.
`server/frontend/src/features/library/use-library-scan-state.ts`:

- Track the first time each key entered `scanning` (sessionStorage-backed, so a
  reload does not restart the 2-minute timer).
- After 2 minutes, convert the entry to `scan_failed`.
- Clear saved scan timestamps once the Jellyfin item appears or the entry stops
  scanning.
- Expose only the adjusted entries; no retry endpoint is needed.

Update `LibraryGrid.tsx`:

- Show a **Scanning** badge with a spinner while Jellyfin has not indexed the
  item.
- Show a **Scan problem** badge when `scan_failed`; the card stays non-playable
  until Jellyfin indexes it.
- Keep the play link gated on `entry.library`; scanning/failed cards have no
  play link.

### Frontend: real-time polling

Update `LibraryPage.tsx`:

- `/api/library` polls every 2 seconds while any entry is `scanning`, otherwise
  every 60 seconds.
- `/api/library/requested` polls every 5 seconds while activity is present and
  otherwise every 30 seconds.
- When the activity queue shrinks, immediately invalidate/refetch
  `["requested-library"]` so a completed import can move to Scanning without
  waiting for the next 30-second poll.
- Keep the existing activity cadence (0.5s active, 2s idle).

## Files to modify

- `server/backend/src/library-scan.ts` (new)
- `server/backend/src/server.ts`
- `server/backend/src/routes/requested.ts`
- `server/backend/src/upstream/qbittorrent.ts`
- `server/backend/src/upstream/jellyfin.ts` (reuse `refreshLibrary`)
- `server/backend/test/library-scan.test.ts` (new)
- `server/frontend/src/features/library/library-entries.ts`
- `server/frontend/src/features/library/use-library-scan-state.ts` (new)
- `server/frontend/src/features/library/LibraryGrid.tsx`
- `server/frontend/src/pages/LibraryPage.tsx`
- `server/README.md`

## Reuse

- `createJellyfinClient(...).refreshLibrary()` in
  `server/backend/src/upstream/jellyfin.ts`.
- Existing `refreshJellyfinLibrary` logic in
  `server/backend/src/routes/requested.ts` (extract and share).
- Existing `indexTorrents` / `QbittorrentTorrent` types in
  `server/backend/src/torrent-progress.ts` and
  `server/backend/src/upstream/qbittorrent.ts`.
- Existing `LibraryPage` polling and activity query for the fast library
  refetch while scanning.
- Existing merge/status pipeline in `library-entries.ts`; extend it instead of
  creating a parallel card model.
- Existing `Badge` and spinner-capable icon components already used by
  `LibraryGrid.tsx`.

## Steps

- [x] Add `completion_on` to the qBittorrent torrent type.
- [x] Create `library-scan.ts` with the 1-second poller, transition/recent
      completion detection, `start()` / `stop()` / `pollOnce()`.
- [x] Extract and reuse `refreshJellyfinLibrary`; update the cancel/delete path.
- [x] Start and stop the watcher in `server.ts` when both API keys exist.
- [x] Add `scanning` / `scan_failed` statuses and the scan-state hook.
- [x] Update Library badges and play-link gating.
- [x] Tighten Library/requested polling and invalidate requested data when the
      activity queue shrinks.
- [x] Add backend unit tests.
- [x] Update `server/README.md`.
- [x] Run backend tests, full typecheck, and frontend build.

## Verification

Automated:

```bash
cd server
npm test
npm run typecheck
npm run build
```

New backend tests should cover:

- first-seen recent completion triggers a scan;
- first-seen old completion does not trigger a scan;
- `incomplete -> complete` triggers a scan;
- multiple completions in one poll produce one refresh;
- no refresh is repeated for an already-scanned completion;
- missing qBittorrent/Jellyfin keys disable the watcher;
- `stop()` clears the interval.

Manual:

1. Request a movie, then close the dashboard before the download completes.
2. Let qBittorrent finish in the background.
3. Confirm the backend sends `POST /Library/Refresh` without the UI open.
4. Open Library and confirm the card shows **Scanning** rather than
   **Available**.
5. Confirm the card becomes playable without a reload once Jellyfin indexes it
   (within roughly 2 seconds of indexing).
6. Leave a card scanning past 2 minutes and confirm it shows **Scan problem**;
   when Jellyfin eventually indexes the item, the card should recover to
   playable.
7. Repeat with a series episode/download to confirm show cards use the same
   behavior.

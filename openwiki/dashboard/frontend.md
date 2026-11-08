---
type: "Reference"
title: "Dashboard frontend"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-20513498cd9f3ba9b6305542
    resource: repo://server/frontend/package.json
  - id: openwiki-source-28b1db70de814a75afc393ba
    resource: repo://server/frontend/src/api/client.ts
  - id: openwiki-source-4424204ccfbccd65b76ad518
    resource: repo://server/frontend/src/App.tsx
  - id: openwiki-source-483ac110bc92cf7612f5f7d4
    resource: repo://server/frontend/src/hooks/use-hash-route.ts
  - id: openwiki-source-2baa8379e4c557cdf86defd7
    resource: repo://server/frontend/src/index.css
  - id: openwiki-source-9dbcc03cadbf05d477d67a12
    resource: repo://server/frontend/src/lib/playback-preferences.ts
  - id: openwiki-source-ba7eba931a6a81be0a33bf74
    resource: repo://server/frontend/src/main.tsx
  - id: openwiki-source-75d3978fc24e04be4d7d7251
    resource: repo://server/frontend/src/pages/LibraryPage.tsx
  - id: openwiki-source-4082db9482a292e937e2cd38
    resource: repo://server/frontend/src/pages/ShowPage.tsx
  - id: openwiki-source-484f2e9677ebad9673aae438
    resource: repo://server/frontend/vite.config.ts
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---


# Dashboard frontend

`server/frontend` is a React 19 single-page app built with Vite 6, styled with Tailwind CSS 4 and shadcn/Radix components. It is served as static files by the Fastify backend in production and proxied to the backend during development.

The SPA has no router dependency and no server-rendered routes: navigation is entirely hash-based, which lets the backend's static fallback serve `index.html` for every path without route configuration.

## Bootstrapping

`src/main.tsx` installs four global providers and then renders `App`:

- `StrictMode`
- `ThemeProvider` from `next-themes`, with `attribute="class"`, `defaultTheme="dark"` and system themes disabled
- `QueryClientProvider` with defaults `staleTime: 15_000`, `retry: 1`, `refetchOnWindowFocus: true`
- `Toaster` (sonner) inside `App`

`src/index.css` imports Tailwind, `tw-animate-css`, the shadcn Tailwind layer, the Inter and Space Grotesk variable fonts, and defines the design tokens under `@theme` (including the 0-radius base radius).

## Hash routing

`src/hooks/use-hash-route.ts` defines `AppRoute` and parses `window.location.hash`:

| Hash | Route |
| --- | --- |
| empty or `#/library` | `{ page: "library" }` |
| `#/services` | Services tabs |
| `#/search` | Media search |
| `#/people` | Admin profile management |
| `#/library/show/{jellyfin|sonarr}/<id>` | Show detail |
| `#/library/show/{source}/<id>/season/<n>` | Show detail for one season |
| `#/library/movie/{jellyfin|radarr}/<id>` | Movie detail |
| `#/play/<jellyfinItemId>?profile…` | Player |

The module exports `useHashRoute()` plus link builders:

- `showHash(source, id, season?)` builds show links, optionally pinned to a season.
- `playHash(itemId, from?, restart?)`, where `from` carries `{ source, show, season }` so the player can return to the right season, and `restart=1` asks the player to start at 0:00.
- `replaceHash(hash)` for in-place navigation; because `history.replaceState` does not emit `hashchange`, it dispatches one manually.

Unknown hashes fall back to the library.

## Auth gating and page shell

`App.tsx` wraps everything in `AuthProvider` and renders `AppShell`:

1. While the session query is loading, show an `AppLoading` skeleton.
2. Without an authenticated session, render `LoginPage`.
3. Otherwise render `Dashboard`, which maps the current route to a page component.

The status query (`fetchStatus`) polls every 30 seconds and supplies the Jellyfin URL used by library cards. Non-admin users who navigate to `#/people` are redirected to `#/services`. The People page is also only rendered when `session.user.isAdmin` is true.

`AppHeader` renders the Library and "Find something new" navigation, the user menu and an admin-only People link. Show and play routes keep the Library tab visually active.

## Typed API boundary

`src/api/client.ts` is the only place that calls `fetch`. It exports one typed function per endpoint (`fetchLibrary`, `fetchShow`, `grabShowRelease`, `createProfile`, `reportPlaybackProgress`, ...) backed by:

- `requestJson`: sets `accept: application/json`, parses the JSON body, and on non-OK responses reads the `{ error: { code, message } }` envelope.
- A custom `ApiClientError` carrying `status` and `code`.
- A global `churn:unauthorized` event whenever a non-login request returns 401; `AuthProvider` listens for it and clears the session/query cache.

`src/api/types.ts` mirrors the backend response contracts, so page components never parse raw upstream shapes.

## Data-fetching conventions

TanStack Query is used uniformly. Several queries encode deliberate polling policy:

| Surface | Interval | Rationale |
| --- | --- | --- |
| Library | 60 s idle, 2 s while a Jellyfin scan is active | picks up newly indexed episodes quickly |
| Requested library | 30 s idle, 5 s while activity exists | titles move from requested to playable |
| Activity | 500 ms while downloads exist, 2 s when idle | backend snapshot cache absorbs the load |
| Show detail | 10 s, 2 s while Jellyfin is scanning | |
| Show downloads | 500 ms while a download exists, 2 s otherwise | lean qBittorrent-only endpoint |
| Movie detail | 10 s | |
| Status | 30 s | service health grid |
| Search | debounced 350 ms; results retained while the next query loads | smooth typing |
| Request options | 5-minute stale time | profiles/folders change rarely |

Mutations invalidate the relevant query keys or optimistically update them, so grabbing, cancelling or deleting a title refreshes the visible card without a full reload.

## Pages and feature folders

| Page | Main features |
| --- | --- |
| `LoginPage` | Household profile picker, PIN/password entry, first-password setup, admin login toggle |
| `LibraryPage` | Continue watching, on-the-way downloads, filters/search, requested titles, attribution, cancellation |
| `ShowPage` | Season tabs, episode rows, missing/downloading/imported states, release picker, per-episode cancel |
| `MoviePage` | Detail, download progress, release picker, cancel/delete actions |
| `SearchPage` | Debounced cross-service search, request options popover, request creation |
| `ServicesPage` | Services / Stats / VPN tabs |
| `PeoplePage` | Admin-only profile creation, PIN display/reset and deletion |
| `PlayPage` | HLS/direct playback, quality menu, autoplay, skip-intro, progress reporting |

Feature-specific logic lives under `src/features/*` (auth, library, show, movie, player, releases, search, stats, status, title, vpn) and reusable primitives under `src/components/ui` (shadcn components). Pure helper modules such as `continue-watching-items.ts`, `release-tiers.ts`, `episode-watch-state.ts` and `playback-meta.ts` are unit-tested independently of React.

## Playback preferences

`src/lib/playback-preferences.ts` stores two optional preferences in `localStorage`:

- `churn:play:quality` — a `PlaybackQuality` value (`max`, `high`, `medium` or `low`, mapped to quality presets on the player), defaulting to `max`.
- `churn:play:autoplay` — boolean, defaulting to enabled unless explicitly set to `"false"`.

Storage access is wrapped in `try/catch`, so private-browsing or disabled storage never breaks playback.

## Development and build

`server/frontend/vite.config.ts`:

- Enables React and Tailwind plugins.
- Aliases `@` to `src`.
- Binds the dev server to all interfaces on port 5173 (`host: true`) so the UI is reachable from the LAN/tailnet.
- Proxies `/api` to `http://127.0.0.1:${PORT || 4001}` with `changeOrigin: false`, preserving the browser's `Host` header so the backend's same-origin check sees the Vite origin.

The backend dev script also defaults to port 4001 so it can coexist with a Compose dashboard on 4000. Production is built with `npm run build` (`tsc --noEmit && vite build`), and Fastify serves `server/frontend/dist`. The root workspace script builds the frontend first, then the backend.

## Relevant tests

- `src/hooks/use-hash-route.test.ts` — route parsing and link builders.
- `src/features/library/continue-watching-items.test.ts` — resume-row shaping.
- `src/features/show/episode-watch-state.test.ts` — episode availability/download state.
- `src/features/releases/release-tiers.test.ts`, `availability.test.ts` — release grouping and request availability.
- `src/features/player/playback-meta.test.ts`, `use-player-shortcuts.test.ts` — player timing and keyboard shortcuts.

## Related pages

<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Dashboard backend architecture](/openwiki/dashboard/backend-architecture.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/auth-and-profiles.md] link "/openwiki/dashboard/auth-and-profiles.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Authentication, sessions and household profiles](/openwiki/dashboard/auth-and-profiles.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/library-and-requests.md] link "/openwiki/dashboard/library-and-requests.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Library browsing, search and requests](/openwiki/dashboard/library-and-requests.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/playback.md] link "/openwiki/dashboard/playback.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Playback and streaming](/openwiki/dashboard/playback.md)

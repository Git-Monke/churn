# User authentication

## Context

The dashboard is currently anonymous. It binds to `127.0.0.1` and assumes one
user, so every Jellyfin request uses the installer's admin API key. That blocks
the upcoming playback work: Jellyfin playback state is per-user, and a
multi-user dashboard needs each browser to act as a real Jellyfin user.

Video playback is deliberately paused. This plan adds Jellyfin-backed login,
server-side sessions, and a per-user Jellyfin token first. Playback then uses
the logged-in user's token instead of a static token in `.env`.

Decisions made with the user:

- **Jellyfin login**: credentials are validated by Jellyfin; Churn stores no
  accounts or password hashes.
- **Full access for all logged-in users**: any valid Jellyfin user can use the
  current dashboard, including search, requests, release grabs and queue
  details. Jellyfin's own user restrictions still apply to library items because
  library calls use the user's token.
- **In-memory sessions**: HttpOnly cookie + a TTL Map in the backend process.
  Restart logs everyone out; no database.
- **Always required**: no anonymous mode and no auth-disabled fallback.

This makes the Jellyfin account the trust boundary. Anyone with a Jellyfin
account can mutate global Sonarr/Radarr state through Churn; that is accepted
and will be documented.

## Approach

### 1. Backend config

`server/backend/src/config.ts`:

- Add `sessionTtlMs: number`, read from `CHURN_SESSION_TTL_MS`, default 12 hours,
  clamp to 5 minutes–30 days.
- Add `cookieSecure: "auto" | true | false`, read from `CHURN_COOKIE_SECURE`,
  default `auto` (`request.protocol === "https"` or
  `X-Forwarded-Proto: https`).
- Keep the existing Jellyfin API key and Sonarr/Radarr keys. The Jellyfin API
  key is still used for `/api/status`; user-token calls use the session token.
- Update `server/backend/test/config.test.ts` and the `makeConfig` helper in
  `server/backend/test/routes.test.ts`.

### 2. Auth module and session store

New `server/backend/src/auth.ts`:

```ts
interface AuthUser {
  id: string;       // Jellyfin user id
  name: string;
  isAdmin: boolean; // display only; no authorization gate in this step
}

interface AuthContext {
  user: AuthUser;
  accessToken: string;
  sessionId: string; // raw cookie value, needed only to destroy the session
}

interface SessionRecord {
  idHash: string;    // sha256(cookie value); raw id is never stored
  user: AuthUser;
  accessToken: string;
  createdAt: number;
  lastSeenAt: number;
}
```

- `createMemorySessionStore({ ttlMs, now? })` with:
  - `create(user, accessToken)` → crypto-random 32-byte base64url cookie value
    and a session record keyed by its SHA-256 hash;
  - `get(cookieValue)` → record, sliding `lastSeenAt`, deleting expired records;
  - `destroy(cookieValue)`, `destroyAllForUser(userId)`, `size()`;
  - a periodic `setInterval(...).unref()` sweep, cleared on app close.
- In-memory only. No JSON, no database, no session file.
- Cookie name `churn_session`; attributes `HttpOnly; SameSite=Lax; Path=/;
  Max-Age=604800` (7 days), plus `Secure` when enabled. No `Domain`.
- A 7-day cookie with a 12-hour server idle TTL means an idle user gets a 401
  and must sign in again; the stale cookie is then replaced.
- Escape the login body into the Jellyfin request only; never log passwords or
  access tokens.

### 3. Jellyfin authentication client

`server/backend/src/upstream/jellyfin.ts`:

- Add stable device headers used by both login and later playback:
  `X-Emby-Client: Churn`, `X-Emby-Device-Name: Churn Web`,
  `X-Emby-Device-Id: churn-web`, `X-Emby-Client-Version`.
- Add `authenticate(username, password)`:
  `POST /Users/AuthenticateByName` with
  `Authorization: MediaBrowser Client="Churn", Device="Churn Web",
  DeviceId="churn-web", Version="0.1.0"` and body `{ Username, Pw }`.
  Parse `AccessToken`, `User.Id`, `User.Name`,
  `User.Policy.IsAdministrator`.
- Add `logout(accessToken)` → `POST /Sessions/Logout` with the user token, used
  best-effort on sign-out.
- Let callers override the auth token:
  `createJellyfinClient(config, timeoutMs, token = config.apiKey)`.
  Library/show/image calls pass the session token so Jellyfin enforces that
  user's library access and user data.
- Add `JellyfinAuthenticationResult` and `JellyfinUser` types.
- Keep `getPublicInfo()` token-free and `getSystemInfo()` on the API key for
  status.

### 4. Auth routes

New `server/backend/src/routes/auth.ts`, registered in `server.ts`:

```ts
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/session
```

- `POST /api/auth/login` body `{ username: string, password: string }`:
  - reject empty/oversized fields with 400;
  - call Jellyfin `authenticate`;
  - on success create a session, set the cookie, return
    `{ authenticated: true, user, expiresAt }`;
  - on Jellyfin 401/403 return a generic 401
    `{ error: { code: "invalid_credentials", message: "Invalid username or password" } }`;
  - on Jellyfin transport failure return 502 `jellyfin_unreachable`;
  - add a simple in-memory throttle: 10 failures per 15 minutes per
    `IP + lowercased username`, returning 429 with a short message. Reset on
    success. This avoids new dependencies.
- `POST /api/auth/logout`:
  - destroy the session from the cookie, clear the cookie, and best-effort call
    Jellyfin `/Sessions/Logout` with the session token;
  - return 204 even without a valid session.
- `GET /api/auth/session`:
  - with a valid session return `{ authenticated: true, user, expiresAt }`;
  - otherwise return 200 `{ authenticated: false }` so the SPA can render the
    login screen without treating it as an error;
  - `cache-control: no-store`.

### 5. Protection hook and per-user Jellyfin calls

`server/backend/src/server.ts`:

- Register `@fastify/cookie` (new backend dependency; Fastify 5-compatible
  version).
- Decorate `request.auth` (Fastify module augmentation) and attach
  `AuthContext` after a successful lookup.
- Add an `onRequest` hook for `/api/*`:
  - public: `/api/health`, `/api/auth/login`, `/api/auth/session`,
    `/api/auth/logout`;
  - everything else requires the `churn_session` cookie and a live session;
  - missing/expired → 401 `{ error: { code: "unauthenticated", message:
    "Sign in to continue" } }`;
  - on a hit, touch the session and continue.
- CSRF hardening: `SameSite=Lax` plus, for non-GET/HEAD/OPTIONS requests, reject
  a present `Origin` / `Sec-Fetch-Site` that is not same-origin with 403.
- Pass the session into the route modules that need a Jellyfin token, or read
  `request.auth` directly.

`server/backend/src/routes/library.ts`:

- Use `request.auth.accessToken` for `listLibrary()` and the image proxy.
- Keep the existing `setup_required` / `unconfigured` states.
- If Jellyfin rejects the user token (401/403), destroy the session and return
  401 `{ error: { code: "session_expired", message: "Your Jellyfin session
  expired. Sign in again." } }` instead of a misleading library-state notice.

`server/backend/src/routes/shows.ts`:

- Use the user token for `getItem`, `getSeasons` and `getEpisodes`.
- Keep Sonarr matching and download overlays on the Sonarr API key.
- On Jellyfin 401/403, destroy the session and return 401 `session_expired`.

No route gets an admin-only gate: full access for all logged-in users, per the
decision above. `isAdmin` is stored for display only.

### 6. Frontend auth shell

`server/frontend/src/api/{types,client}.ts`:

- Add `AuthUser`, `AuthSessionResponse`, `LoginInput` and `LoginResponse`.
- Add `fetchSession()`, `login()`, `logout()`.
- In `requestJson`, dispatch `window.dispatchEvent(new Event("churn:unauthorized"))`
  on 401 for every path except `/api/auth/login` so the app can drop back to the
  login screen when a session expires.

New `server/frontend/src/features/auth/AuthProvider.tsx` (or
`use-auth.ts` + context):

- Query `["auth-session"]` on mount with `retry: false`.
- Expose `{ session, login, logout, pending }`.
- Listen for `churn:unauthorized` and set the session cache to
  `{ authenticated: false }`, clear cached queries, and let the shell render the
  login page.
- `login` calls the API, replaces the session cache and clears any previous
  user's cached queries.
- `logout` calls the API, clears the query cache, then sets the session cache to
  unauthenticated. Clearing is important so the next user never sees the
  previous user's library/Continue Watching data.

New `server/frontend/src/pages/LoginPage.tsx`:

- Full-page centered card with Churn heading, username/password fields,
  `autoComplete="username"` / `"current-password"`, submit button and inline
  error alert.
- Loading state on submit; disable the form while pending.
- Keep the current hash route untouched so the user lands on the page they
  originally opened after login.
- Reuse `Card`, `Input`, `Label`, `Button`, `Alert` and `Skeleton`.

`server/frontend/src/App.tsx`:

- Wrap the app in the auth provider.
- While the session query is loading, render a minimal full-page skeleton.
- If unauthenticated, render `<LoginPage />` and `Toaster` only.
- If authenticated, keep the existing header/pages/refresh flow and pass the
  user to `AppHeader`.
- Keep route rendering unchanged; per-user data now comes from the cookie.

`server/frontend/src/components/AppHeader.tsx`:

- Show the signed-in user's name and an admin badge when `isAdmin`.
- Add a **Sign out** button that calls `logout`.
- Keep the existing Services / Library / Search nav.

No new frontend dependencies. Login is a gate, not a new hash route, so deep
links and refreshes still work.

### 7. Tests

Backend:

- New `server/backend/test/auth.test.ts`:
  - successful login returns the user and sets an HttpOnly/SameSite cookie;
  - invalid credentials return a generic 401 and do not set a cookie;
  - Jellyfin unreachable returns 502;
  - `/api/auth/session` reports authenticated and unauthenticated states;
  - protected routes return 401 without a cookie;
  - logout clears the cookie and destroys the session;
  - expired sessions return 401 after the TTL (fake timers);
  - login throttle returns 429 after repeated failures;
  - session store unit tests for TTL, sliding touch, hashed ids and destroy.
- Update `server/backend/test/routes.test.ts`:
  - extend `installFetch` to answer `/Users/AuthenticateByName` before the
    test-specific handler;
  - add a helper that logs in and returns the cookie, then add it to each
    protected `app.inject` call (a small `authedInject` wrapper keeps the diff
    contained).
- Add a test that library/show calls use the session token rather than the API
  key, and that a Jellyfin 401 on a user-token call returns `session_expired`
  and destroys the session.
- Keep `server/backend/test/config.test.ts` covering `CHURN_SESSION_TTL_MS` and
  `CHURN_COOKIE_SECURE`.

Frontend: `npm run typecheck` and `npm run build` (no frontend test runner
today).

### 8. Documentation

- `server/README.md`: new auth section (Jellyfin account required, in-memory
  sessions, restart logs everyone out), `CHURN_SESSION_TTL_MS` and
  `CHURN_COOKIE_SECURE` in the env table, auth routes, cookie/TLS notes, and the
  “all logged-in users have full access” warning.
- Root `README.md` and `docs/src/web-ui.md`: the dashboard now requires a
  Jellyfin login; no anonymous mode; restart clears sessions.
- `docs/src/server.md`: update the web-dashboard paragraph and roadmap wording.
- Do not modify `plans/video-playback.md`; when playback resumes, replace its
  installer `JELLYFIN_USER_TOKEN` approach with this session identity.

## Files to modify

Backend

- `server/backend/package.json` — add `@fastify/cookie`.
- `server/backend/src/config.ts` — session TTL and cookie secure settings.
- `server/backend/src/auth.ts` (new) — session store, cookie helpers, login
  throttle.
- `server/backend/src/routes/auth.ts` (new) — login/logout/session.
- `server/backend/src/upstream/jellyfin.ts` — authenticate/logout, token
  override, device headers.
- `server/backend/src/server.ts` — cookie plugin, auth hook, route registration.
- `server/backend/src/routes/library.ts` — user token + session expiry.
- `server/backend/src/routes/shows.ts` — user token + session expiry.
- `server/backend/test/{auth,routes,config}.test.ts` and helpers.

Frontend

- `server/frontend/src/api/{client,types}.ts`
- `server/frontend/src/features/auth/AuthProvider.tsx` (new)
- `server/frontend/src/pages/LoginPage.tsx` (new)
- `server/frontend/src/App.tsx`
- `server/frontend/src/components/AppHeader.tsx`

Docs

- `server/README.md`, `README.md`, `docs/src/web-ui.md`, `docs/src/server.md`.

## Reuse

- Jellyfin auth/device-header shape:
  `src/jellyfin.rs` `AUTH_HEADER` and `authenticate()`.
- Existing Jellyfin client/error mapping:
  `server/backend/src/upstream/jellyfin.ts`, `server/backend/src/errors.ts`,
  `server/backend/src/upstream/states.ts`.
- HTTP helpers: `fetchJson` / `postJson` in `server/backend/src/http.ts`.
- Route registration and error envelope: `server/backend/src/server.ts`.
- Test harness: `buildServer`, `makeConfig`, `installFetch` in
  `server/backend/test/routes.test.ts`.
- Frontend query setup and refresh flow: `server/frontend/src/App.tsx`.
- UI primitives: `Card`, `Input`, `Label`, `Button`, `Alert`, `Skeleton` under
  `server/frontend/src/components/ui/`.

## Steps

- [x] Add `@fastify/cookie`, config values and config tests.
- [x] Add session store, cookie helpers and login throttle in `auth.ts` with
      unit tests.
- [x] Add Jellyfin `authenticate` / `logout` and token override.
- [x] Add `/api/auth/*` routes and register them.
- [x] Add the Fastify auth hook, public-path list, CSRF check and request auth
      decoration.
- [x] Switch library/shows/images to the session token and handle
      `session_expired`.
- [x] Update backend route tests with a login/authenticated-inject helper.
- [x] Add frontend auth types/client, session provider and 401 event handling.
- [x] Add the login page and gate the app shell.
- [x] Add the header user name / sign out.
- [x] Update README/docs and note that the video-playback plan will use this
      identity.

## Verification

Automated:

```bash
cd /home/monke/Projects/churn/server
npm install          # adds @fastify/cookie
npm run typecheck
npm test
npm run build
```

Manual end-to-end (server stack running):

1. Open the dashboard in a fresh browser profile: only the login page renders,
   and `/api/library` returns 401 without a cookie.
2. Sign in with the Jellyfin admin account created by churn; Library, Services
   and Search work, and the header shows the user name.
3. Create a second, non-admin Jellyfin user with access to only part of the
   library; sign in as that user and confirm the Library only shows allowed
   items. Confirm the Sonarr/Radarr actions remain available (accepted full
   access).
4. Sign out: cookie is cleared, cached library data disappears, and the login
   page returns.
5. Restart the backend; the next API call returns 401 and the SPA drops to the
   login page.
6. Use browser devtools to confirm the cookie is `HttpOnly`, `SameSite=Lax`,
   and not visible to JavaScript; confirm login responses are `no-store` and
   password values do not appear in backend logs.
7. Try a wrong password repeatedly and confirm the generic error and eventual
   429 throttle; try a cross-origin POST and confirm it is rejected.
8. With Jellyfin stopped, login shows an unreachable message; with Jellyfin
   running again, login succeeds.
9. Revoke the user token/session in Jellyfin, then trigger a library refresh:
   Churn returns `session_expired` and shows the login page.

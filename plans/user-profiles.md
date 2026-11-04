# User profiles + persistent sessions

## Context

Today Churn has one auth mode: sign in with a Jellyfin username/password, and
the backend keeps the resulting Jellyfin access token in an **in-memory** map
(`server/backend/src/auth.ts:80`, wired at `server/backend/src/server.ts:43`).
Two consequences cause the reported problems:

1. **Every login revokes other sessions.** `DEVICE_ID = "churn-web"` is shared
   by every Churn session (`server/backend/src/upstream/jellyfin.ts:128`).
   Jellyfin revokes all existing sessions for the same user + device on each new
   authentication, so a second login kills the first. Churn then sees a 401 and
   destroys its session (`routes/library.ts:65`, `routes/shows.ts:208`,
   `routes/movies.ts:202`, `routes/playback.ts:261`).
2. **Restarts log everyone out.** Sessions are process memory only, and the
   installer force-recreates the dashboard on every `churn` run
   (`src/main.rs:580`, `src/system.rs:312`).

We are adding household **profiles**. An admin signs in with a Jellyfin account,
creates a profile per person (e.g. Jacob, Barry), and Churn creates a real
Jellyfin user for each profile. The person selects their profile, signs in with
a one-time PIN, and is prompted to set their own password. Distinct Jellyfin
users give per-person watch progress later.

Decisions made with the user:

- **Churn creates the Jellyfin user per profile** (no existing-account linking).
- **First login:** admin-generated short PIN → person sets a stronger password.
- **PIN stays visible** in the admin People page next to every profile that
  still has one, and is cleared after the password is set.
- **Credential login stays available** to every Jellyfin user; only admins see
  profile management. This is additive, not a breaking change.
- **Deleting a profile deletes the Jellyfin user and its history.**
- **Storage:** new `churn-state` Docker volume. `churn uninstall` keeps its
  current behavior and removes it.
- **Lifetime:** sliding idle 12 hours (current semantics), persisted across
  restarts.

## Approach

### 1. Persisted auth state

Replace the memory-only session store with an auth store that owns both profiles
and sessions and persists them to one JSON file.

- New state dir: `CHURN_STATE_DIR`, default `path.join(serverDir, ".churn-state")`
  in dev; container uses `/app/state` (config in `config.ts:188`-`244`).
- File: `<stateDir>/auth-state.json`, versioned:
  ```json
  {
    "version": 1,
    "profiles": [{
      "id": "uuid", "name": "Jacob",
      "jellyfinUserId": "uuid",
      "initialPin": "123456",        // null after password setup
      "createdAt": 0
    }],
    "sessions": [{
      "idHash": "sha256(cookie)",
      "kind": "admin" | "profile" | "direct",
      "profileId": "uuid",           // profile sessions only
      "user": { "id": "jellyfin-uuid", "name": "Jacob", "isAdmin": false },
      "accessToken": "jellyfin-token",
      "deviceId": "per-session-uuid",
      "createdAt": 0, "lastSeenAt": 0
    }]
  }
  ```
- Load synchronously at startup (missing/corrupt file → start empty and log a
  warning), prune sessions older than the 12h idle TTL, and drop sessions whose
  profile no longer exists.
- Writes are atomic (`auth-state.json.tmp` + `rename`, mode `0600`), reusing the
  pattern in `server/backend/src/media-cache.ts:133`. Debounce normal writes
  (~1s); flush `lastSeenAt` at most every ~60s; `await flush()` on
  `onClose` (`server.ts:53`).
- Keep the existing sliding-TTL behavior and hashed cookie ids
  (`auth.ts:76`, `auth.ts:80`-`155`). Keep `createMemorySessionStore` available
  for tests, with the new store layered on it or an options flag.
- Add profile operations: `listProfiles`, `getProfile`, `createProfile`,
  `setProfilePin`, `markPasswordSet`, `deleteProfile`,
  `destroyAllForProfile`.

### 2. Unique Jellyfin device id per Churn session

- Add a `deviceId` field to `SessionRecord`; generate `randomUUID()` at session
  creation (crypto), persist it, and expose it on `AuthContext`.
- Extend `createJellyfinClient()` (`upstream/jellyfin.ts:145`) to accept
  `{ deviceId, deviceName }`; use it in the `Authorization` header for
  `authenticate` and in `X-Emby-Device-Id` for every request.
- Pass `auth.deviceId` from every authenticated route that currently calls
  `createJellyfinClient(service, timeout, auth.accessToken)` (library, shows,
  movies, search, playback, images).
- Result: two people, or the same person in two browsers, get different Jellyfin
  devices, so no login revokes another session. Trade-off: Jellyfin accumulates
  device entries over time; its device cleanup task handles this. The installer
  keeps using `churn-installer`.

### 3. Jellyfin admin client additions

Use the existing admin API key (`config.services.jellyfin.apiKey`) for user
management; Jellyfin API keys are admin-level.

- `createUser(name, password)` → `POST /Users/New` body `{ Name, Password }`;
  returns the new user (needs `Id`).
- `setUserPassword(jellyfinUserId, newPassword, opts)` →
  `POST /users/{id}/Password` legacy path (or `POST /Users/Password?userId=`),
  body `{ CurrentPw?, NewPw }`:
  - self-service first login uses the user's token plus `CurrentPw = PIN`;
  - admin PIN reset uses the API key and omits `CurrentPw`.
- `deleteUser(jellyfinUserId)` → `DELETE /Users/{id}`. Jellyfin revokes the
  user's tokens and removes watch state.
- Extend `JellyfinUser`/response types as needed. Reuse `fetchJson`,
  `fetchWithTimeout`, `upstreamResponseError` (`server/backend/src/http.ts`).

### 4. Auth + profile routes

Keep `POST /api/auth/login` for any Jellyfin user (existing behavior) but create
sessions with `kind: "admin"` when `isAdmin`, otherwise `"direct"`, and a unique
device id.

New public/authenticated routes:

- `GET /api/auth/profiles` (public, `no-store`) → `[{ id, name, passwordSet }]`.
  No PINs, no Jellyfin ids.
- `POST /api/auth/profile-login` (public) body
  `{ profileId, password, newPassword? }`:
  - authenticate against the profile's Jellyfin username with a fresh device id;
  - if `passwordSet` is false and `newPassword` is absent → return
    `200 { passwordSetupRequired: true }` and best-effort logout the probe token;
  - if `newPassword` is present (min 8 chars, not equal to the PIN): change the
    password with the user's token + `CurrentPw = PIN`, then re-authenticate with
    the new password, store only the final token, set
    `initialPin = null` / `passwordSet = true`, create the session;
  - otherwise create the session directly;
  - throttle by `IP | profileId` with the existing `createLoginThrottle`
    (`auth.ts:221`).
- `GET /api/profiles` (admin) → profiles including `initialPin`.
- `POST /api/profiles` (admin) `{ name }`:
  - validate 1-32 chars and uniqueness;
  - generate a 6-digit PIN (`randomInt`, zero-padded string);
  - `createUser(name, pin)`, store the profile with `initialPin` and
    `passwordSet: false`; return `{ profile, pin }`.
- `POST /api/profiles/:id/pin` (admin): generate a new PIN, set it through the
  Jellyfin admin key, mark `passwordSet: false`, store `initialPin`, destroy all
  sessions for that profile, return the PIN.
- `DELETE /api/profiles/:id` (admin): delete the Jellyfin user, delete the
  profile, destroy that profile's sessions. Treat Jellyfin 404 as success.
- `POST /api/auth/logout` and `GET /api/auth/session` stay, returning
  `{ authenticated, user, kind, profileId?, expiresAt }`.

Add `requireAdmin(request)` next to `requireAuth`
(`server/backend/src/auth.ts:66`) and a `kind`/`profileId` on `AuthContext`.

`server.ts:78` `publicApiPaths` is a plain `Set<string>` and ignores HTTP
methods. Replace it with a method-aware predicate so `GET /api/auth/profiles` is
public while `POST /api/profiles` is authenticated. Add tests for this.

### 5. Frontend

- `api/types.ts` / `api/client.ts`: add profile types,
  `fetchProfiles`, `profileLogin`, `fetchManagedProfiles`,
  `createProfile`, `resetProfilePin`, `deleteProfile`; keep `fetchSession`,
  `login`, `logout`. Extend auth types with `kind` and `profileId`.
- `features/auth/AuthProvider.tsx`: expose `login` (credential), `profileLogin`,
  `logout`; keep the `churn:unauthorized` handler and query-cache clearing on
  identity change.
- `pages/LoginPage.tsx`:
  - default view: profile grid ("Who's watching?");
  - select a profile → password form; if `passwordSet` is false, ask for the
    admin PIN and then the new password (two steps) and call `profileLogin`
    with both;
  - "Admin sign in" link toggles the existing username/password form.
- New `pages/PeoplePage.tsx` (admin only): list profiles with PIN (copy button)
  while `initialPin` exists, "password set" status, add-person form, reset PIN,
  delete with confirmation. Use existing `components/ui/{card,input,button,
  dialog,alert,badge}.tsx`; follow `CancelDownloadDialog` for the confirm
  pattern.
- `hooks/use-hash-route.ts`: add `{ page: "people" }` and `#/people`.
- `App.tsx`: render `PeoplePage` for admins; non-admins hitting `#/people` fall
  back to Services.
- `AppHeader.tsx`: show the profile name; add "People" nav for admins and a
  "Switch person" action that logs out to the picker.

### 6. Container / installer

- `server/docker-compose.yml:93`-`104`: add
  `CHURN_STATE_DIR=/app/state` and `churn-state:/app/state`; declare the volume.
- `server/Dockerfile:42`: create and `chown node:node /app/state` alongside
  `.churn-cache`.
- `server/.env.example`: document `CHURN_STATE_DIR`,
  `CHURN_SESSION_TTL_MS` (12h sliding), and the profile flow.
- `.gitignore`: add `.churn-state/`.
- `src/main.rs:743`: update the uninstall note to mention the state volume is
  removed (behavior unchanged).
- Sessions surviving dashboard recreation removes the surprise logout on
  `churn` reruns even though `restart_dashboard()` still runs.

## Files to modify

Backend

- `server/backend/src/auth.ts` — profile records, persisted store, `requireAdmin`,
  `AuthContext.deviceId/kind/profileId`.
- `server/backend/src/config.ts` — `stateDir`, `CHURN_STATE_DIR`.
- `server/backend/src/upstream/jellyfin.ts` — device-id option, create user,
  set password, delete user.
- `server/backend/src/routes/auth.ts` — profile login + password setup, session
  payload.
- New `server/backend/src/routes/profiles.ts` — admin profile CRUD.
- `server/backend/src/server.ts` — persistent store, method-aware public paths,
  route registration, shutdown flush.
- `server/backend/src/routes/{library,shows,movies,search,playback}.ts` — pass
  the per-session device id.
- `server/backend/test/{auth,jellyfin,routes,config}.test.ts` — update and add
  coverage.

Frontend

- `server/frontend/src/api/{types,client}.ts`
- `server/frontend/src/features/auth/AuthProvider.tsx`
- `server/frontend/src/pages/{LoginPage,PeoplePage}.tsx`
- `server/frontend/src/{App.tsx,components/AppHeader.tsx,hooks/use-hash-route.ts}`

Infra / docs

- `server/docker-compose.yml`, `server/Dockerfile`, `server/.env.example`,
  `.gitignore`, `src/main.rs`
- `server/README.md`, `docs/src/web-ui.md`, `docs/src/server.md`, root `README.md`

## Reuse

- Sliding session semantics, hashed cookie ids, cookie hardening:
  `server/backend/src/auth.ts:76`-`197`.
- Login throttle: `createLoginThrottle` (`auth.ts:221`).
- Jellyfin client transport: `fetchJson` / `fetchWithTimeout` /
  `upstreamResponseError` (`server/backend/src/http.ts`).
- `authenticate` / `logout` and `createJellyfinClient` token override
  (`upstream/jellyfin.ts:145`-`203`).
- Admin flag mapping: `mapAuthUser` (`routes/auth.ts:141`).
- Atomic JSON write: `writeJson` (`media-cache.ts:133`).
- Frontend query-cache clears on auth change
  (`features/auth/AuthProvider.tsx:43`-`75`).
- State-dir writability fallback pattern (`server.ts:177`-`190`).

## Steps

- [x] Add `stateDir` config and docs; create the dir on startup.
- [x] Extend the auth store with profile records + atomic persistence + pruning +
      periodic/debounced flush; keep memory mode for tests.
- [x] Add per-session Jellyfin `deviceId` and thread it through every client call.
- [x] Add Jellyfin `createUser` / `setUserPassword` / `deleteUser` client methods.
- [x] Add `requireAdmin`, method-aware public API paths, and profile admin routes.
- [x] Add `profile-login` with PIN-first flow and password setup.
- [x] Return `kind` / `profileId` from login and session routes.
- [x] Wire the store in `server.ts`, flush on close, prune on boot.
- [x] Frontend: API types/client, provider, profile picker, first-login flow,
      People page, header/nav/routing.
- [x] Compose/Dockerfile/env/.gitignore/uninstall note.
- [x] Backend tests: persistence round-trip, TTL pruning, unique device ids,
      profile creation/reset/delete, PIN→password flow, admin authorization,
      public-route method matching, Jellyfin client calls.
- [x] Update README, web-ui, server docs.
- [x] Run `cd server && npm test`, `npm run typecheck`, `npm run build`; run
      `cargo test` for installer changes.

## Verification

Automated:

- `cd server/backend && npx vitest run`
- `cd server && npm run typecheck && npm run build`
- `cargo test`

Manual end-to-end on a dev stack:

1. Start the dashboard; sign in with the Jellyfin admin account.
2. Open People; create "Jacob" and "Barry"; note the PINs shown next to each.
3. In browser A select Jacob, enter the PIN, set a password; confirm the PIN
   disappears and the dashboard opens as Jacob.
4. In browser B select Barry, enter the PIN, set a password.
5. Verify both browsers remain signed in and Jellyfin shows two users with
   separate tokens/devices; watch state is per user.
6. Restart the dashboard (`docker compose restart dashboard`) and confirm both
   sessions still work (12h sliding window).
7. In browser C select Jacob and sign in with the new password while browser A
   stays signed in (unique device ids, no revocation).
8. Admin: reset Jacob's PIN, confirm browser A is signed out, first-login PIN
   flow works again. Delete Barry, confirm his Jellyfin user and history are
   gone.

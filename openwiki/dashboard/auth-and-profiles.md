---
type: Authentication Design
title: Authentication, sessions and household profiles
description: How the dashboard authenticates against Jellyfin, keeps hashed server-side sessions, hardens cookies, throttles failed logins, and manages managed household profiles with one-time PINs.
tags: [authentication, sessions, cookies, security, profiles, jellyfin]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-a69f23dc1ea0a98061c75461
    resource: repo://server/backend/src/auth.ts
  - id: openwiki-source-eb3a4811a02a8c92fe31b44a
    resource: repo://server/backend/src/config.ts
  - id: openwiki-source-aed435a78f5f6dff9e521e33
    resource: repo://server/backend/src/routes/auth.ts
  - id: openwiki-source-ca390e7cf017429a03fb11f3
    resource: repo://server/backend/src/routes/profiles.ts
  - id: openwiki-source-be77ce8f5c96454fdf2b3376
    resource: repo://server/backend/src/server.ts
  - id: openwiki-source-28b1db70de814a75afc393ba
    resource: repo://server/frontend/src/api/client.ts
  - id: openwiki-source-b97626ec6b3e8dffb8e014e1
    resource: repo://server/frontend/src/features/auth/AuthProvider.tsx
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Authentication, sessions and household profiles

The dashboard never has its own password database. Every sign-in is a Jellyfin authentication request, and the resulting Jellyfin access token is held server-side in a session record keyed by a hash of the browser cookie. This keeps upstream URLs and API keys out of the browser while still giving each household member their own Jellyfin identity and watch state.

The implementation is split between:

- `server/backend/src/auth.ts` — session store, cookie policy, throttle, auth helpers.
- `server/backend/src/routes/auth.ts` — login, profile login, logout, session.
- `server/backend/src/routes/profiles.ts` — admin-only profile management.
- `server/backend/src/server.ts` — request middleware that enforces authentication and same-origin writes.

## Login with a Jellyfin account

`POST /api/auth/login` accepts `username` and `password`, validates their length, and calls Jellyfin's authentication endpoint with a freshly generated `deviceId` (a UUID) for that login. Using a unique device id per session is deliberate: Jellyfin can revoke one device session without affecting other sessions belonging to the same user.

The resulting Jellyfin `User` is mapped to `{ id, name, isAdmin }` from `Policy.IsAdministrator`. The session `kind` is `"admin"` for Jellyfin administrators and `"direct"` for other users. Successful login resets the throttle, creates a session, sets the cookie, and returns:

```json
{
  "authenticated": true,
  "user": { "id": "...", "name": "...", "isAdmin": false },
  "kind": "admin",
  "expiresAt": "2026-01-01T12:00:00.000Z"
}
```

Errors are intentionally generic for bad credentials (`401 invalid_credentials`) and distinguish only an unreachable Jellyfin (`502 jellyfin_unreachable`).

## Session store and persistence

Sessions are held in a per-process `Map` but persisted to disk when `stateDir` is configured (the normal container deployment sets `CHURN_STATE_DIR=/app/state`).

- The raw cookie value is never stored. `hashSessionId` stores `sha256(cookieValue)` as `idHash`.
- Each record carries the Jellyfin `accessToken`, a `deviceId`, session `kind`, optional `profileId`, `createdAt` and `lastSeenAt`.
- Persistence uses `auth-state.json` version 1 with mode `0600`, written through a temporary file and atomic `rename`.
- Writes are debounced (1 second) and coalesced through a serialized promise chain; `lastSeenAt` touches are flushed at most once per minute.
- A 5-minute sweep removes idle sessions. Loading persisted state also prunes expired sessions and profile sessions whose profile no longer exists.
- `close()` flushes one final snapshot when the Fastify app shuts down (`app.addHook("onClose", ...)` in `server.ts`).

The store also persists `ProfileRecord`s, which is how managed household profiles survive a dashboard restart.

## Cookie policy and TTLs

The session cookie is named `churn_session` and is always:

- `HttpOnly: true`
- `SameSite: Lax`
- `Path=/`
- `maxAge` = 7 days (`SESSION_COOKIE_MAX_AGE_SECONDS`)

The `Secure` flag is controlled by `CHURN_COOKIE_SECURE`:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Secure when the request protocol is HTTPS or `X-Forwarded-Proto` is `https` |
| `true` / `1` | Always Secure |
| `false` / `0` | Never Secure |

The server-side idle TTL is separate from the cookie's browser lifetime. `CHURN_SESSION_TTL_MS` defaults to 12 hours and is clamped to 5 minutes–30 days (`config.ts`). Every `get()` slides `lastSeenAt`, so an active session keeps extending its idle window; a session that is idle past the TTL is deleted and the next request is unauthenticated.

## Request middleware and CSRF protection

For all `/api/*` paths, `server.ts` installs an `onRequest` hook that:

1. Rejects non-GET/HEAD/OPTIONS requests whose `Origin`/`Sec-Fetch-Site` indicates a different host with `403 cross_origin_request`. Host comparison includes `Host`, `X-Forwarded-Host` and the `Forwarded` header so reverse-proxy deployments keep working.
2. Allows a fixed public allowlist: `GET /api/health`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`, `GET /api/auth/profiles`, `POST /api/auth/profile-login`.
3. Otherwise resolves the cookie in the session store and either attaches a full `AuthContext` to `request.auth` or returns `401 unauthenticated`.

Route handlers use `requireAuth(request)` for any authenticated user and `requireAdmin(request)` for profile management. When Jellyfin itself returns 401 during a downstream call, handlers call `expireSession(request)` (or `auth.destroySession()`) and return `401 session_expired`, which the SPA turns into a fresh login prompt.

## Login throttling

`createLoginThrottle` allows 10 failures per 15-minute window. Keys are:

- `"<ip>|<lowercased username>"` for direct logins.
- `"profile:<ip>|<profileId>"` for household profile logins.

When a key is over the limit the route returns `429 too_many_attempts` with a `Retry-After` header; a successful authentication resets the key. The throttle is in-memory only, so restarting the backend clears it.

## Household profiles

A "profile" is a managed household member. Admins create one with `POST /api/profiles { name }`. The backend:

1. Rejects duplicate names case-insensitively.
2. Requires `JELLYFIN_API_KEY` and creates a Jellyfin user with a generated 6-digit PIN as the initial password.
3. Stores a `ProfileRecord` with the Jellyfin user id and `initialPin`, and returns the PIN **once** in the creation response.
4. Hides the PIN from the public profile list, exposing only `passwordSet: initialPin === null`.

The profile login flow is intentionally two-stage:

- `POST /api/auth/profile-login { profileId, password }` authenticates the profile's Jellyfin user.
- If the profile still has an `initialPin` and the request has no `newPassword`, the probe session is logged out and the response is `{ passwordSetupRequired: true, profile }`.
- The second call includes `newPassword` (minimum 8 characters). The backend changes the Jellyfin password with the PIN as the current password, marks the profile as password-set, logs out the probe session, re-authenticates with the new password, and only then creates the Churn session with `kind: "profile"`.
- Once `initialPin` is null, supplying `newPassword` again is rejected with `400 password_already_set`.

Profile sessions are never admins: the `AuthUser` is constructed with `isAdmin: false`. The SPA additionally redirects non-admin users away from the People page (`App.tsx`).

Profile management endpoints require an admin session:

| Endpoint | Effect |
| --- | --- |
| `GET /api/profiles` | List managed profiles |
| `POST /api/profiles` | Create a Jellyfin user + profile, return the PIN once |
| `POST /api/profiles/:id/pin` | Reset the Jellyfin password to a new PIN and destroy that profile's sessions |
| `DELETE /api/profiles/:id` | Delete the Jellyfin user (404 tolerated) and the profile, destroying its sessions |

## Logout and session expiry

`POST /api/auth/logout` destroys the server-side record, clears the cookie with matching attributes, and best-effort calls Jellyfin's logout using the stored token. Failure to reach Jellyfin does not prevent Churn logout.

On the client, `AuthProvider` treats a `401` from any non-login API call as a session expiry: the API client dispatches `churn:unauthorized`, the auth provider clears the React Query cache and marks the session unauthenticated. The reference UI flow is in `server/frontend/src/features/auth/AuthProvider.tsx` and `server/frontend/src/pages/LoginPage.tsx`.

## Relevant tests

`server/backend/test/auth.test.ts` covers hashed ids, sliding expiry, persisted reloads, per-session device ids, hardened cookies, reverse-proxy origins, throttling, protected routes, profile PIN setup, PIN resets and profile deletion.

## Related pages

<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Dashboard backend architecture](/openwiki/dashboard/backend-architecture.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/frontend.md] link "/openwiki/dashboard/frontend.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Dashboard frontend](/openwiki/dashboard/frontend.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/upstream-integrations.md] link "/openwiki/dashboard/upstream-integrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Upstream integrations and upstream state](/openwiki/dashboard/upstream-integrations.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)

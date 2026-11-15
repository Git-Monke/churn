---
# churn-edlw
title: Reconcile manually created Jellyfin users into churn profiles
status: in-progress
type: feature
priority: normal
tags:
    - jellyfin
    - backend
    - auth
created_at: 2026-11-15T18:49:18Z
updated_at: 2026-11-15T19:07:39Z
---

## Background

Live failure on the demo stack (2026-11-15): adding a person named `Jacob` in **People**
returns `jellyfin returned HTTP 400: Error processing request.`

- Jellyfin log: `System.ArgumentException: A user with the name 'Jacob' already exists.`
  at `UserController.CreateUserByName` — the user exists in Jellyfin's `Users` table
  alongside `admin`, but churn's `auth-state.json` has `"profiles": []`.
- `POST /api/profiles` only checked churn's own store
  (`server/backend/src/routes/profiles.ts:42`), so the duplicate was invisible until
  `POST /Users/New` failed (`server/backend/src/upstream/jellyfin.ts:231-238`).
- Jellyfin's `ExceptionMiddleware` masks `ArgumentException` as a `text/plain` 400 body
  `Error processing request.` in production, which is why the UI text said nothing useful.

### Root cause (verified 2026-11-15)

`Jacob` was created **by churn**, not in Jellyfin's UI. Jellyfin's `Users` row for
`0B5F466B-FA1C-4047-AACD-4D8BB9A9B8FE` has `LastLoginDate = LastActivityDate =
2026-11-12 21:14:29Z` (13:14:29 PST, two minutes after `admin`), a non-administrator policy
row (`Permissions` Kind=0 Value=0), a password, and a single log burst
(`13:14:24`, `13:14:29` `Authentication request for Jacob has succeeded.`) right after
churn finished the Jellyfin setup wizard. The only code path in the stack that creates a
non-admin Jellyfin user is `POST /api/profiles` -> `POST /Users/New`; the Rust installer
only ever creates the admin (`src/jellyfin.rs:234-248`).

churn then lost the record. Profiles live only in `auth-state.json` on the `churn-state`
volume and the backend never re-reads Jellyfin, so a start where that file is missing or
unreadable begins with zero profiles — silently: `loadPersistedState()`
(`server/backend/src/auth.ts:305`) catches the `readFileSync` failure at `:310-313` and
returns `false` with no warning, and the next `flush()` (`:374`) serializes the entire
state back as `"profiles": []`. Jellyfin's database is a bind mount
(`server/config/jellyfin`), so accounts survive anything churn's volume does not. The live
file matches that shape: `"profiles": []` with the oldest surviving session at
2026-11-15 00:19 PST, consistent with an empty load after the 2026-11-13 23:30 dashboard
recreate (`0.2.8`, which added `cache-init` to make exactly these volumes writable and
rewrote `server/.env`).

## Goal

Jellyfin stays the account system; churn's profile store mirrors it. At startup churn
copies the Jellyfin users it does not know about into the store, so an account created
outside churn — or orphaned by a lost state file — becomes usable again without an admin
retyping it, and the masked duplicate 400 has an actionable path.

Scope (m00275): startup sync only. No manual resync endpoint and no People-page sync
button. Read endpoints stay read-only: no `GET` handler may write profile state.

## Design (implemented)

### 1. Client: list Jellyfin users

`server/backend/src/upstream/jellyfin.ts:15-27` — `JellyfinUserPolicy` gained optional
`IsDisabled` next to `IsAdministrator`, and `JellyfinUser` gained optional `HasPassword`
(top-level in Jellyfin's `UserDto`). `listUsers(): Promise<JellyfinUser[]>`
at `:232-241` calls `GET ${config.url}/Users` with the admin key and throws
`UpstreamError("jellyfin", "unauthorized", …)` when no key is configured. No filtering in
the client; the sync decides.

### 2. Sync module

`server/backend/src/profiles.ts`:

- `syncProfiles(store, service, { timeoutMs, onWarning?, onInfo? })` returns
  `{ imported: ProfileRecord[]; skipped: number; error?: string }`. Rules:
  - import iff the user is not an administrator, not disabled, has a password
    (`HasPassword !== false`), has an id and a name, and no stored profile has its
    `jellyfinUserId`. `Policy.IsHidden` is deliberately ignored — see the risk note;
  - a stored profile with the same normalized name (`trim().toLowerCase()`, matching
    `getProfileByName`) but a different id is skipped with a warning — one person, one tile;
  - imports use `createProfile({ name, jellyfinUserId, initialPin: null })`, which the store
    already reads as "password set" (`parseProfileRecord`
    `server/backend/src/auth.ts:150-176`);
  - never throws: a missing key warns `churn: JELLYFIN_API_KEY is not configured; skipping
    the profile sync`, an upstream failure warns
    `churn: profile sync could not read Jellyfin users: <reason>` and sets `error`.
- `syncProfilesAtStartup(...)` retries while `error` is set over
  `STARTUP_SYNC_RETRY_DELAYS_MS = [2s, 5s, 10s, 20s, 30s]` (~67 s), then warns
  `churn: giving up on the profile sync for now; Jellyfin users stay unavailable until the
  next restart`. Success logs `churn: imported N Jellyfin user(s) into the profile store`.
  Retry delays are injectable for tests.

### 3. Wiring

- `server/backend/src/auth.ts:11-19`: Fastify augmentation gained
  `interface FastifyInstance { sessionStore: SessionStore }`;
  `app.decorate("sessionStore", sessionStore)` at `server/backend/src/server.ts:54`.
- `server/backend/src/index.ts:24-31`: after `app.listen`, `void syncProfilesAtStartup(...)`
  with `config.services.jellyfin`, `config.requestTimeoutMs` and `app.log` for warnings and
  info. Fire-and-forget: a dashboard that boots before Jellyfin still serves.

### 4. Store

`SessionStore.createProfile` input widened to `initialPin: string | null`
(`server/backend/src/auth.ts:93-98`). Persistence already round-trips null; the existing
`ProfileRecord.initialPin` type was already `string | null`.

### 5. Duplicate add

`POST /api/profiles` (`server/backend/src/routes/profiles.ts:51-63`) now lists Jellyfin
users after the local name check and answers `409 profile_exists`
(`A Jellyfin user with that name already exists`) instead of forwarding Jellyfin's masked
400. A failed listing does not block creation — `createUser` reports its own error.

Names that the sync deliberately skips (administrators, hidden, disabled) still trigger
this conflict, by design: churn cannot adopt those accounts, but it also must not try to
create a second Jellyfin user with the same name.

### 6. Docs

- `docs/src/web-ui.md:108-115`: adopted profiles are already password-protected, arrive at
  startup, and duplicate names are rejected before churn calls Jellyfin.
- `docs/src/server.md:207-213`: why the backend reconciles at startup.

## Acceptance criteria

- One dashboard restart imports `Jacob` on the live stack; People lists him; adding
  `Jacob` afterwards is rejected locally with 409 `profile_exists` and no `POST /Users/New`.
- A second start imports 0 and leaves the profile set unchanged (idempotent).
- `GET /api/auth/profiles` and `GET /api/profiles` issue no writes and no `GET /Users`.
- Dashboard starts with Jellyfin down: it still serves, the sync warns, and the retries
  import the users once Jellyfin answers.
- A person whose Jellyfin account churn has not adopted (admin/hidden/disabled) gets a 409
  with a readable message instead of `jellyfin returned HTTP 400: Error processing request.`
- `initialPin: null` survives save/load and shows as `passwordSet: true` in the API.

## Tests

- `server/backend/test/profiles.test.ts` (new, 8 tests): imports an unknown user and checks
  the request shape (`GET /Users`, `X-Emby-Token`); adopts a user reported as `IsHidden`;
  skips admin/disabled/passwordless/known id/name collision/nameless entry; idempotent
  second run; missing API key makes no request; upstream 500 reports `error` and imports
  nothing; startup retry succeeds on the second attempt; exhausted retries warn and give
  up.
- `server/backend/test/auth.test.ts`: household fetch stub answers `GET /Users`; new test
  asserts `POST /api/profiles` with a Jellyfin-only name returns 409 `profile_exists` and
  never posts to `/Users/New`.

## Verification (2026-11-15)

- Live probe against the running Jellyfin (10.11.11, churn API key, real user table) with
  the production `syncProfiles`: imported `Jacob`
  (`0b5f466bfa1c4047aacd4d8bb9a9b8fe`, `initialPin: null`), skipped `admin`.
- Built backend started on port 4099 with `CHURN_STATE_DIR=/tmp/churn-sync-probe` and the
  live Jellyfin: logged `churn: imported 1 Jellyfin user(s) into the profile store`;
  `GET /api/auth/profiles` returned `[{"id":"…","name":"Jacob","passwordSet":true}]` and
  `auth-state.json` held the profile with `"initialPin":null`.
- `npx vitest run` 32 files / 416 tests pass; `npm run typecheck` and `npm run build` clean.

## Risks / notes

- Startup sync is a write at boot by design; it never runs inside a GET.
- The boot race is handled by bounded retry, not by failing startup.
- `Policy.IsHidden` must not gate the sync. On the live stack Jellyfin 10.11 returns
  `IsHidden: true` for both `admin` and `Jacob`; the flag only hides an account from
  Jellyfin's own login screen, which churn never renders. An early version skipped it and
  imported zero users against the real server — the probe below is what caught it.
- Users without a Jellyfin password (`HasPassword === false`) are skipped: churn's profile
  login requires a secret. An admin sets a password in Jellyfin, then a restart adopts the
  account.
- No pruning: a profile whose Jellyfin user was deleted stays until an admin removes it.
- One `GET /Users` per start plus one per add; no cost on the read path.

## Open questions

- Prune profiles whose `jellyfinUserId` vanished from Jellyfin, or leave them for an admin
  to remove? Leaving them is safer (no destructive sync) but leaves dead tiles.
- Should the People page mark adopted profiles (for example "added in Jellyfin")?
- Follow-up: `server/backend/src/auth.ts:310-313` still swallows a missing or unreadable
  `auth-state.json`, and `flush()` at `:374` rewrites the file from whatever is in memory.
  Logging loaded profile/session counts at startup and warning on `EACCES` would make the
  next state loss visible instead of silent. Not part of this fix.

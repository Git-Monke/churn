---
# churn-5wck
title: 'Release-search state: ready before the snapshot is written'
status: completed
type: bug
priority: normal
created_at: 2026-11-06T06:58:46Z
updated_at: 2026-11-06T06:58:47Z
---

## Problem

`dashboard image` failed on tag `v0.2.1` in `test/routes.test.ts`:

```
FAIL test/routes.test.ts > cancel requested title > removes persisted release-search snapshots when a series is deleted
AssertionError: expected false to be true
 ❯ test/routes.test.ts:1432:20  expect(existsSync(cacheFile)).toBe(true)
```

`release-search.ts` flipped `state` to `"ready"` as soon as the last indexer settled, but `finishJob` set `job.completedAt` and then `await persist(job)`. A poll in that window saw `ready` with no `series-<id>/s<season>.json` on disk yet — usually fast enough on local tmpfs, slow enough on a CI runner to lose the race.

## Fix

- `persist(job, fetchedAt)` now takes the timestamp instead of reading `job.completedAt`.
- `finishJob` writes the snapshot first, then sets `completedAt` and settles, so `completedAt` means "persisted".
- `buildResponse` requires `allSettled && completedAt !== undefined` for `ready`, so `ready` now implies the snapshot is readable.
- New deterministic regression test `test/release-search-persist.test.ts` gates `fs/promises.writeFile` and asserts the view stays `searching` (and the file stays absent) while the write is open — it fails against the old ordering.

## Summary of Changes

- `server/backend/src/release-search.ts`: `persist()` takes `fetchedAt`;
  `finishJob()` and the no-indexer path set `completedAt` only after the
  snapshot write settles; `buildResponse()` only reports `ready` once the job
  is persisted, not merely when every indexer settled.
- `server/backend/test/release-search-persist.test.ts`: deterministic
  regression test that holds `writeFile` open and asserts the response stays
  `searching` with no snapshot on disk (fails on the old ordering).

Verified: backend typecheck clean, 385 tests pass (three consecutive runs),
including the previously flaky `routes.test.ts` case.

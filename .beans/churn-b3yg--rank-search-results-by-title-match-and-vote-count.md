---
# churn-b3yg
title: Rank search results by title match and vote count
status: completed
type: feature
priority: normal
created_at: 2026-11-12T22:05:16Z
updated_at: 2026-11-12T22:07:09Z
---

The search page round-robins the Sonarr and Radarr lookup output by index
(`interleaveResults`), so rank is whatever TMDB/TVDB relevance said. Measured on
the live instance: Sonarr `the office` returns 20 hits with The Office (US) at
position 9; Radarr `the office` returns 20 zero-vote movies. Both arr resources
already carry `ratings.votes`, so re-ranking is a local change with no new data.

This is the cheap half of churn-mrul: ordering only, not recall.

## Plan

- [x] Score = `titleMatch^2 * (0.55 + 0.45 * log10(votes+10)/6)`; match tiers exact 1.0, title-extends-query 0.97, query-extends-title 0.9, all-token prefix 0.88, substring 0.75, trigram dice >= 0.5 -> 0.5*sim.
- [x] Normalise titles for matching: strip parentheticals, NFKD-fold diacritics, lowercase, punctuation to space, drop leading article.
- [x] Carry votes from Sonarr `ratings.votes` / Radarr `ratings.imdb.votes` into `SearchResult`.
- [x] Replace `interleaveResults` with `rankSearchResults` in the search route; delete `interleaveResults`.
- [x] Show the vote count on the result card so the new order is legible.
- [x] Update tests, docs (`openwiki/dashboard/library-and-requests.md`), typecheck + build.

## Summary of Changes

`server/backend/src/search.ts`: replaced `interleaveResults` with
`rankSearchResults` / `searchScore` / `titleMatchScore` / `popularityScore` /
`normalizeTitle` / `trigramSimilarity`; both mappers now carry `votes`.
`server/backend/src/routes/search.ts:37` ranks the merged list instead of
round-robining. `server/backend/src/types.ts` + `server/frontend/src/api/types.ts`
add `votes`; `server/frontend/src/features/search/SearchResultCard.tsx` shows it.
Verified against live Arr data: `the office` -> The Office (US) 859k first,
`dune` -> Dune 2021, `spiderman` -> Spider-Man 2002. 400 backend tests pass,
both packages typecheck.

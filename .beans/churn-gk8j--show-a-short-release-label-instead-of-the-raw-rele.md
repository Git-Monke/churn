---
# churn-gk8j
title: Show a short release label instead of the raw release name
status: todo
type: feature
priority: normal
created_at: 2026-11-05T23:35:41Z
updated_at: 2026-11-13T06:52:03Z
---

The VersionPicker currently shows the full release name (truncated). Add a friendly label built from the release-name parser: source (Blu-ray, 4K Blu-ray, Web, HDTV, DVD rip) plus flags (Remastered, Extended, Director's cut, Dual audio, English dub, HDR), joined with ' · ', falling back to 'Unknown source' when nothing is known. Season results also get a scope prefix (Full season, Episodes 1–8 only, Seasons 1–3). Needs the backend release parser to expose source/flags.

## Plan

### Approach

Compose the label on the backend, where the parsed release lives. `release-name.ts` already owns source/season/episode facts, and the season-scope prefix needs `seasonNumbers`/`episodeNumbers`, which never reach the browser. The parser gains structured `source` and `flags`; a pure `releaseLabel(parsed)` turns them into display text; `mapRelease` puts the result on `ShowRelease.releaseLabel`; `VersionPicker` renders it and keeps the raw title as the `title` tooltip.

This reverses deviation 4 in `plans/title-header-version-picker.md` ("No friendly release label").

### 1. Parser: expose source and flags — `server/backend/src/release-name.ts`

Extend `ParsedReleaseName`:

```ts
export type ReleaseSource = "bluray" | "web" | "hdtv" | "dvd";
export type ReleaseFlag =
  | "remastered"
  | "extended"
  | "directors-cut"
  | "dual-audio"
  | "english-dub"
  | "hdr";

export interface ParsedReleaseName {
  // existing fields unchanged
  source?: ReleaseSource;
  flags: ReleaseFlag[];
}
```

- Set `flags: []` in both `mapMovieParse` and `mapSeriesParse`.
- `source`: prefer `info.quality?.quality?.source` from the arr `/parse` response (`bluray`, `webdl`, `webrip`, `hdtv`, `dvd`, ...). Normalize by lowercasing and stripping non-letters, then map `bluray|bdremux|remux` → `bluray`, `web*` → `web`, `hdtv|tv|rawhd` → `hdtv`, `dvd` → `dvd`; anything else is unknown.
- Fallback when the arr source is absent: scan the raw title for `blu-ray|bdrip|brrip|remux`, `web[- .]?dl|web[- .]?rip|web`, `hdtv`, `dvd[- .]?rip|dvd`, in that priority.
- Flags scan `tokenize(rawTitle)` minus one contiguous occurrence of the parsed title (and its aliases), so a movie called *The Extended Family* does not read as `Extended`:
  - `remastered|remaster` → `Remastered`
  - `extended` → `Extended`
  - `directors cut` (`tokenize` strips apostrophes) → `Director's cut`
  - `dual audio` → `Dual audio`
  - `english dub|eng dub|dubbed` → `English dub`
  - token matching `/^hdr(10(plus)?)?$/` → `HDR` (covers HDR, HDR10, HDR10+)
- Fixed flag order everywhere: Remastered, Extended, Director's cut, Dual audio, English dub, HDR.

### 2. Label builder — same file

```ts
/** "Full season · 4K Blu-ray · Remastered · HDR" */
export function releaseLabel(parsed: ParsedReleaseName): string;
```

Pieces, in order, joined with `" · "`:

1. Scope prefix for series releases: more than one season → `Seasons 1–3` (reuse `releaseSeasonLabel`); episode numbers present → `Episode 3 only` / `Episodes 1–8 only` (contiguous) / `Episodes 1, 3, 5 only`; otherwise a single-season pack → `Full season`. No prefix when the parsed name has neither season nor episode numbers (movies).
2. Source: `4K Blu-ray` when the source is `bluray` and `tier === 3`, else `Blu-ray`, `Web`, `HDTV`, `DVD rip`; `Unknown source` when the source is unknown.
3. Flags in the fixed order above, when present.

`Unknown source` stays as the first token when flags exist but the source does not: `Unknown source · HDR`. Rationale: the label always names a source, so alternatives stay visually aligned.

### 3. API field — `server/backend/src/types.ts`, `server/backend/src/release-search.ts`

- `ShowRelease` gains optional `releaseLabel?: string`. The legacy Sonarr mapping in `server/backend/src/releases.ts` keeps compiling and working without it; the picker only renders `release-search` results.
- In `mapRelease` (`release-search.ts`), set `releaseLabel: releaseLabel(release.parsed)` next to `seasonLabel`.
- Bump `SNAPSHOT_VERSION` from `2` to `3`. Persisted snapshots have no `source`/`flags`, so without the bump every cached label would read `Unknown source` until a manual refresh; `parseSnapshot` already discards other versions and the next search repopulates the cache.
- Mirror `releaseLabel?: string` in `server/frontend/src/api/types.ts`.

### 4. Render — `server/frontend/src/features/releases/VersionPicker.tsx`

In `ReleaseName`, render `release.releaseLabel ?? release.title` and keep `title={release.title}` so the full name is still available on hover. Both call sites (best match, alternatives) go through this component, so there is no other UI change. `ReleaseMeta` (indexer · age) stays as is.

### 5. Tests — `server/backend/test/release-name.test.ts`

- Parser: arr `quality.quality.source` mapping (`bluray`/`webdl`/`hdtv`/`dvd`); title fallback when source is missing; flags from a name like `...Remastered...Extended...Directors.Cut...Dual.Audio...ENG.DUB...HDR10`; no false `Extended` for a parsed title that contains the word.
- `releaseLabel`: movie `4K Blu-ray · Remastered · HDR`; `Web`; unknown → `Unknown source`; flags without source → `Unknown source · HDR`; full season → `Full season · HDTV`; multi-season → `Seasons 1–3 · Blu-ray`; episode range → `Episodes 1–8 only · Web`; single episode → `Episode 3 only · ...`.
- Update existing `mapArrParseResponse` expectations with `flags: []` / `source`.

### 6. Verification

- `cd server/backend && npx vitest run test/release-name.test.ts test/release-search.test.ts && npm run typecheck`
- `cd server/frontend && npm run typecheck && npm test && npm run build`
- Live: open a movie with a cached search and a season picker. Confirm the best match and an alternative show the short label, hovering shows the full release name, the season picker shows `Full season · ...` / `Episodes n–m only · ...`, and an unknown-quality tier reads `Unknown source`.
- No commit until the user approves.

### Risks / edge cases

- `releaseLabel` depends on arr `/parse` data; a release whose parse is missing is already dropped by `normalizeRelease`, so the fallback only affects a missing `quality.source`, covered by title detection.
- Multi-season scope reuses `seasonRangeFromTitle`, which already handles `S01-07`; labels are only as accurate as that range.
- Title-token removal is best-effort: a flag word that is itself part of an alias title is removed only when the alias matches contiguously.

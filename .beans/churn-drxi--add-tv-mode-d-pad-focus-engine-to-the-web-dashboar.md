---
# churn-drxi
title: Add TV mode (D-pad focus engine) to the web dashboard
status: todo
type: feature
priority: high
tags:
    - tv
    - fire-tv
    - frontend
created_at: 2026-11-06T21:50:59Z
updated_at: 2026-11-06T21:50:59Z
parent: churn-w1rj
---

## Goal

Make the existing dashboard usable with a remote only, inside the same web app —
no forked TV screens.

## Why

This is the piece that removes the "keep two UIs in sync" problem: if TV support
lives in `server/frontend`, there is one UI and TV mode is exercised by the normal
web build.

## Work

- [ ] `src/tv/` module: `remote-keys.ts` (37–40/13/27/back/179/85/227/228 →
      semantic actions) and `spatial-navigation.ts` (pure geometry: nearest
      candidate per direction, row wrap, focus memory) with unit tests.
- [ ] `use-focusable.ts` + `FocusContainer` provider; `preventDefault()` handled
      keys so Vega's built-in spatial navigation stays out of the way.
- [ ] Activation: `?tv=1` → `data-tv` on `<html>` + Tailwind 4 `tv:` variant;
      heuristic fallback for manual testing.
- [ ] 10-foot presentation: 5% overscan padding, larger type scale, hover styles
      behind `@media (hover: hover)`, visible focus ring on every actionable item.
- [ ] TV library layout: rows (Continue Watching / Movies / Series) with a left
      nav rail instead of filter + grid; keep focus memory per row.
- [ ] Radix `DropdownMenu`/`Popover` reachable in TV mode (inline focusable list,
      not an off-screen portal); `Dialog` focus trap + initial focus.
- [ ] Back semantics: player → previous route, show/movie → parent, root →
      confirm-exit event for the shell.
- [ ] Player: extend `usePlayerShortcuts` instead of adding a second key system;
      Select toggles overlay, ←/→ seek, play/pause, back closes overlay;
      register `navigator.mediaSession` handlers; pause on `visibilitychange`.
- [ ] Hide People/Services/VPN and the request/download surfaces in TV mode;
      Search stays library search.

## Verification

`?tv=1` at 1920×1080: library → show → season → play → back works with only
arrow keys + Enter. Focus-graph unit tests (`vitest`) cover direction choice,
row wrap and memory. `npm run typecheck`/`test`/`build` in `server/` stay green.

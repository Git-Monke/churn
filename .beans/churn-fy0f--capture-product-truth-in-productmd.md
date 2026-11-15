---
# churn-fy0f
title: Capture product truth in PRODUCT.md
status: completed
type: task
priority: normal
created_at: 2026-11-15T18:17:48Z
updated_at: 2026-11-15T18:17:52Z
---

## Summary of Changes

Wrote PRODUCT.md at the repo root (impeccable product schema 1) from a four-question interview plus repository evidence.

Confirmed by the product owner:
- Primary user: household members (search, request, watch); the box admin is secondary.
- Differentiator: one interface over the whole pipeline — search, release choice, download progress, library, playback.
- Durable constraints: Linux+Docker with root install; browser talks only to the BFF; Jellyfin owns identity and playable library; bring your own VPN.
- Platform: web. The CLI is a terminal tool, not a native app.

Recorded as current implementation rather than commitment (owner did not confirm as constraints): dashboard binds 127.0.0.1 by default, Jellyfin remote access off, backend keeps no database.

No DESIGN.md written; no visual world recorded. LIVE mode left unconfigured (dev server needs the running service stack).

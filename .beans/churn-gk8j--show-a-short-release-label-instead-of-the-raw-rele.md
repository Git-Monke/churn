---
# churn-gk8j
title: Show a short release label instead of the raw release name
status: todo
type: feature
created_at: 2026-11-05T23:35:41Z
updated_at: 2026-11-05T23:35:41Z
---

The VersionPicker currently shows the full release name (truncated). Add a friendly label built from the release-name parser: source (Blu-ray, 4K Blu-ray, Web, HDTV, DVD rip) plus flags (Remastered, Extended, Director's cut, Dual audio, English dub, HDR), joined with ' · ', falling back to 'Unknown source' when nothing is known. Season results also get a scope prefix (Full season, Episodes 1–8 only, Seasons 1–3). Needs the backend release parser to expose source/flags.

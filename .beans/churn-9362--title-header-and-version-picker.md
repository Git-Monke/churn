---
# churn-9362
title: Title header and version picker
status: completed
type: feature
priority: normal
created_at: 2026-11-05T23:35:31Z
updated_at: 2026-11-06T00:15:51Z
---

Implement plans/title-header-version-picker.md: shared TitleHeader + VersionPicker, wire into movie and show detail pages.

## Checklist
- [ ] lib/format.ts: formatRuntime, formatRelativeAge, formatEtaAbout
- [ ] release-tiers.ts + availability.ts + unit tests
- [ ] use-release-search.ts extracted from ReleaseChooser
- [ ] VersionPicker (all search + download states, season extension points)
- [ ] TitleHeader + Synopsis + TitlePrimaryAction + TitleMenu + DeleteTitleDialog
- [ ] Attribution helper/hook (movies and shows)
- [ ] Movie page rewrite
- [ ] Show page: TitleHeader + VersionPicker season chooser (season selector and episode list unchanged)
- [ ] typecheck / tests / build
- [ ] Visual verification at 1440px and 390px


## Done

Shared TitleHeader, Synopsis, TitlePrimaryAction, TitleMenu, DeleteTitleDialog, VersionPicker, useReleaseSearch and the release tier/availability modules landed, wired into the movie and show pages. The show page then moved on to the season tab/episode list redesign in churn-c5aj.

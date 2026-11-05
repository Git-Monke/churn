# Library page redesign — implementation spec

Redesign the dashboard's Library page (`server/frontend`) for household members browsing for something to watch. This is a visual and structural rewrite of the existing page, not a new feature set. Reuse existing backend routes and data wherever possible; only add backend work where noted.

Before starting, read `AGENTS.md`, `server/README.md`, and the current Library page component(s) and their data hooks. Follow the existing stack and conventions (component library, styling approach, data fetching). Do not introduce a new UI library.

## Goals

1. Order the page by what a household member wants first: resume, then incoming, then the full library.
2. Show status only when it is not the default. Remove the "Available" badge entirely.
3. Remove admin/destructive affordances from the browse view.
4. Fill the viewport width instead of a fixed narrow column.

## Design tokens

Define these as CSS variables (or extend the existing theme) rather than hard-coding them in components.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0E0E10` | Page background |
| `--surface` | `#17171A` | Cards, segmented control, search field |
| `--surface-raised` | `#2E2E34` | Selected segment, inactive toggle border |
| `--track` | `#2A2A30` | Progress-bar track, avatar background |
| `--border` | `#1E1E22` | Header bottom border |
| `--text` | `#EDEAE4` | Primary text |
| `--text-muted` | `#A29E97` | Secondary text, inactive nav |
| `--accent` | `#F2B544` | Progress fills, badges, active nav underline, active toggle border. Use for nothing else. |
| `--on-accent` | `#141210` | Text on accent badges |

Typography: Inter for body (15px base, 14px secondary, 13px tertiary), Space Grotesk 600 for section headings (22px) and the wordmark (24px, lowercase "churn"). Load both from Google Fonts or self-host, whichever matches the project.

Radii: 10px for posters, stills and controls; 12px for "On the way" cards; 6px for badges and small thumbnails.

## Layout

Content container: `max-width: 1400px`, centered, `40px` horizontal padding (reduce to 16px below 640px). Sections stack vertically with `56px` gaps.

### Header

- 68px tall, bottom border `--border`.
- Left: wordmark "churn".
- Nav: **Library** (active: `--text`, 2px `--accent` bottom border) and **Find something new** (the current Search page, renamed). Inactive links use `--text-muted`.
STREAM
- Right: account button showing avatar initial + display name + chevron. It opens a menu that contains **Switch person**, **Sign out**, and, for admins only, **Services**.
- Remove: the tagline, the "Last checked" timestamp, the "Signed in as" text, the "Admin" badge, and the Refresh button. Refresh data automatically (poll or refetch on focus, matching what the app already does).
- Services leaves the main nav. Its route keeps working; it is reached only through the account menu.

### Section 1: Continue watching

- Heading "Continue watching".
- Horizontal row, scrolls on overflow, 20px gap. Each card is 340px wide.
- Card: a 16:9 still (Jellyfin backdrop or episode thumbnail; fall back to the poster) with a centered 52px circular play button (`rgba(14,14,16,0.72)` background), and a 4px progress bar flush along the bottom edge (track `rgba(255,255,255,0.18)`, fill `--accent`, width = played percentage).
- Below the still: title (500 weight); then a muted line. For episodes: `S3 · E5 · 14 min left`. For movies: `48 min left`.
- Clicking the card resumes playback in the existing in-app player at the saved position.
- Data: the signed-in user's resume list from Jellyfin. Use the user's own token, as the library calls already do. If no backend route exposes this yet, add one that proxies Jellyfin's resume-items endpoint for the current user (check which endpoint path the pinned Jellyfin version uses).
- Hide the whole section when the list is empty.

### Section 2: On the way

- Heading "On the way".
- Responsive grid, `repeat(auto-fill, minmax(320px, 1fr))`, 16px gap.
- Card (`--surface`, 14px padding): 56×84 poster thumbnail on the left; on the right, title and ETA on one line (ETA right-aligned, muted, no wrap), a 6px rounded progress bar (track `--track`, fill `--accent`), and a muted line "Requested by {name}".
- Title format: movie title, or `Show · Season N` for season downloads.
- ETA copy: `about 20 min`, `about 2 hr`, or `Queued` when not started. Round generously; never show seconds, seeders, speeds or torrent names here.
- Data: existing qBittorrent progress already used by the current Library page, plus the "added by" attribution already shown on cards.
- Hide the whole section when nothing is downloading or queued.

### Section 3: Library

Toolbar (one row, wraps on narrow screens, 16px gap):

- "Library" heading followed by a muted count, e.g. "6 titles" (reflects active filters).
- Segmented control: **All / Movies / Shows** (`--surface` container, 4px padding; selected segment `--surface-raised` with `--text`, others `--text-muted`; use `aria-pressed`). Rename "Series" to "Shows" everywhere in this view.
- **Added by me** toggle button: transparent background; border `--surface-raised` when off, `--accent` when on; `aria-pressed`.
- Search field: 260px, `--surface` background, search icon, placeholder "Search library", with an accessible label. Filters the grid client-side, as the current search does.

Grid:

- `repeat(auto-fill, minmax(168px, 1fr))`, `28px` row gap, `20px` column gap.
- Card: 2:3 poster (10px radius), then title (500 weight, single line with ellipsis), then a muted line `{year} · {Movie|Show}`.
- Default sort: most recently added first.
- Badges, top-left of the poster, only when true: `N new episodes` for shows with episodes added since the user last watched, or `New` for unwatched titles added recently (pick a threshold such as 7 days and make it a constant). Badge style: `--accent` background, `--on-accent` text, 12px, 600 weight, 6px radius. If the data for a badge is not readily available, leave that badge out rather than approximating it.
- The entire card links to the existing detail view.

Remove from library cards: the "Available" badge, the trash button, the Movie/Series type chip, the chevron, rating, content rating, runtime, network/studio, and the "Added by" line. All of that information (and the delete action) belongs on the detail view; make sure the detail view still shows it and still offers delete. Titles that are requested but not yet playable should appear in "On the way", not in the grid.

## Responsiveness

- Below 640px: header nav and account button wrap; the toolbar wraps onto multiple lines; the search field goes full width.
- The Continue watching row scrolls horizontally; no element causes the page body to scroll sideways.
- Interactive targets are at least 44px tall.

## Accessibility

- Real `<button>`, `<a>` and `<input>` elements; icon-only buttons have `aria-label`.
- Text contrast meets 4.5:1 against its background (the tokens above do).

## Out of scope

- The detail view redesign, Find something new, and Services. Don't restyle them beyond what the shared tokens change automatically.

## Done when

- The Library page matches the layout and tokens above at 1440px and 390px widths.
- Empty states work: no resume items and no downloads hides both top sections, and an empty library shows a short message with a link to Find something new.
- Existing tests pass; add tests for any new backend route.
STREAM

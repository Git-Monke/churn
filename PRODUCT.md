# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: household members of a self-hosted install — the people who search for a
title, request it, and watch it from the dashboard. They install nothing, operate
nothing, and never open a terminal; they open a URL on the LAN or the tailnet and
use the product the way they would use a streaming app.

Secondary: the admin who owns the Linux box — runs `churn` to install, keeps both
stacks up, runs `churn update`, adds household profiles, and owns the VPN.

## Product Purpose

churn turns a bare Linux machine into a complete self-hosted media pipeline and
gives the household one interface over it: search a title, find a release on an
indexer, send that torrent to qBittorrent, and play the result from Jellyfin —
without opening the four service UIs that actually do the work.

Success: a household member goes from "I want to watch this" to playback without
anyone opening a terminal, and the admin does not babysit the wiring between
services.

## Positioning

One interface over the whole pipeline. Sonarr, Radarr, Prowlarr, qBittorrent and
Jellyfin each ship their own UI and assume the user knows which one to open;
churn presents search, release choice, download progress, library state and
playback as a single continuous flow where each step hands off to the next inside
the same surface.

## Operating Context

- Self-hosted Linux host running Docker; two compose stacks (`server`, `torrent`),
on one machine or two.
- Reached over a LAN IP, a Tailscale IP or a MagicDNS name; playback follows the
hostname the dashboard was opened with. Jellyfin remote access is off and the
dashboard binds `127.0.0.1` in the shipped defaults.
- Household profiles: the admin adds a person, which creates a Jellyfin user and a
one-time PIN the person replaces with their own password. Sign-in is a Jellyfin
login; sessions last 12 hours of inactivity and survive restarts.
- Two typed Jellyfin libraries, `Movies` over `/data/media/movies` and `Shows` over
`/data/media/tv`; qBittorrent's in-progress downloads sit outside the media
directory so Jellyfin never indexes them.
- The torrent side runs inside a user-supplied VPN, with public indexers plus
FlareSolverr for Cloudflare-fronted sites.
- Objects the interface handles: movies; shows with seasons and episodes; releases
with quality tiers (480p, 720p, 1080p, 2160p, Other), seeders and size; download
progress and ETA; resume positions; intro and credit segments.

## Capabilities and Constraints

Confirmed behaviour:

- CLI: one-command install, non-interactive install mode, `churn llm-install`
prompt for agents, `churn update` (binary, dashboard image, compose reconcile),
`churn migrate`, VPN leak checks, uninstall.
- Dashboard pages: Services (Services and VPN tabs), Library (movies, shows,
seasons, episodes, downloads), Search, plus movie, show, play, people and login
routes.
- Release search is Prowlarr-first: one search per enabled indexer in parallel,
results stream in per indexer with a `5/9 indexers finished` progress line, then
group by quality tier and sort by seeders then size; only the best-seeded release
shows until **Show more options**. A snapshot is reused until **Search again**.
- Choosing a release sends exactly that torrent straight to qBittorrent, into the
existing show or movie folder; no second arr search and no arr grab.
- Requests add a title to Sonarr/Radarr unmonitored and do not start a download.
- Library: Jellyfin is the only source of playable titles, qBittorrent the only
source of download progress; removal is arr-backed or Jellyfin-only depending on
where the title came from.
- In-app player: streams from Jellyfin, transcodes to HLS only when the browser
cannot decode the source, resumes from the signed-in user, reports progress back
to Jellyfin, and counts down to the next episode at the credits.

Constraints confirmed by the product owner:

- Linux with Docker, root required to install. No other host platform is in scope.
- The browser talks only to the dashboard backend (BFF). The client never calls
Jellyfin, Sonarr, Radarr, Prowlarr or qBittorrent directly.
- Jellyfin is the identity provider and the only source of truth for playable
library content; sessions and library calls are per Jellyfin user.
- Bring your own VPN: churn wires and verifies the tunnel, never supplies or
brokers one.

Current implementation, not a commitment: the backend keeps no database — it reads
the service APIs and persists only release snapshots, cached metadata and Jellyfin
device sessions to disk.

## Brand Commitments

- Name: churn. Lowercase in prose, `churn` as the command.
- Logo: `assets/churn-logo.svg`, used as the wordmark.
- Tagline in use: "for those who hate streaming apps, and love open source."
- Voice in existing docs: plain, concrete, unhedged technical prose that says what
a thing does and what it refuses to do.

## Evidence on Hand

- `README.md` — the install and operate reference for both roles.
- `assets/churn-logo.svg`.
- `docs/` — mdBook source for the user documentation.

No customers, testimonials, benchmarks, press, pricing or third-party case studies
exist. Future work must not fabricate any.

## Product Principles

1. The interface is the product: every pipeline step from search to playback lands
in the dashboard, so a household member never needs a terminal.
2. Jellyfin owns identity and the library; churn is the shell in front of it and
never becomes a second source of truth.
3. One boundary: the browser talks only to the BFF, and every service credential
stays server-side.
4. Wire, don't own: churn configures and verifies the user's services and VPN
instead of replacing them.
5. Repeatable operations: installs, updates and reconciles are idempotent and safe
to rerun, and any user-triggered action that touches the stack earns the same care.

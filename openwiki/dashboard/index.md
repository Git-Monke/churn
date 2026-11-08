# Files

- [Authentication, sessions and household profiles](auth-and-profiles.md) - How the dashboard authenticates against Jellyfin, keeps hashed server-side sessions, hardens cookies, throttles failed logins, and manages managed household profiles with one-time PINs.
- [Dashboard backend architecture](backend-architecture.md) - Composition and request lifecycle of the Fastify backend-for-frontend that serves the churn SPA and brokers all Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent and VPN access.
- [Downloads, activity and library sync](downloads-and-sync.md) - How churn follows a download from Sonarr/Radarr or a direct qBittorrent grab through import, Jellyfin indexing and live activity reporting, including matching heuristics and retry timings.
- [Dashboard frontend](frontend.md)
- [Library browsing, search and requests](library-and-requests.md) - How the dashboard reads the Jellyfin library, builds continue-watching rows, searches across Sonarr and Radarr, creates requests with quality/root-folder options, tracks requested titles, attributes them to people, and cancels or deletes them.
- [Playback and streaming](playback.md) - How the dashboard prepares a playable item, chooses direct play versus HLS transcoding, redirects to Jellyfin with the user's token, reports watch progress, and adds next-episode and IntroDB skip segments.
- [Release discovery and ranking](release-discovery.md) - How churn searches every enabled Prowlarr indexer in parallel, parses and filters release names through the arr parser, groups results by quality tier, persists snapshots, and sends a chosen release straight to qBittorrent.
- [Upstream integrations and upstream state](upstream-integrations.md) - The client layer between the dashboard and Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent and the VPN status agent, including credential discovery, timeouts, error classification and the status/stats/VPN health endpoints.

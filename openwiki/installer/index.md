# Files

- [churn CLI and orchestration](churn-cli.md) - The churn binary's command surface and install pipeline, from argument validation and root/Docker preflight through question collection, Compose writes, stack startup, Jellyfin setup, uninstall and read-only show output.
- [Jellyfin first-run setup from churn](jellyfin-setup.md) - How the installer drives Jellyfin's startup wizard, creates or reuses an API key, configures media libraries and tailnet access, restarts Jellyfin, and recreates the dashboard with the key.
- [Data directory migration](migration.md) - How churn migrate discovers installed stacks and the current DATA_DIR, validates a target, resumes a verified rsync copy, switches .env files with rollback, and optionally deletes the old data.
- [Installer provisioning and environment files](provisioning.md) - How installer questions become answers, how host ports are chosen and reused, how Mullvad WireGuard archives are parsed, how embedded stack assets are materialized, and how .env values are merged.
- [Updates, releases and version pinning](update-and-release.md) - How churn update replaces the binary and dashboard image, how release assets and checksums are produced and verified, how versions stay aligned, and how rollback works.

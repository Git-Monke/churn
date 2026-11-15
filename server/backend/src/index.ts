import { loadConfig } from "./config.js";
import { syncProfilesAtStartup } from "./profiles.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = await buildServer(config, { logger: true });

// Video streams are handed to the browser as absolute Jellyfin URLs, so the
// effective public address matters when playback fails on another device.
app.log.info(
  config.jellyfinPublicUrlExplicit
    ? `video streams resolve to ${config.jellyfinPublicUrl} (JELLYFIN_PUBLIC_URL)`
    : `video streams follow the request host (fallback ${config.jellyfinPublicUrl})` +
        (config.lanAddress ? `, LAN address ${config.lanAddress}` : ""),
);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// Jellyfin owns the accounts; the churn store can lose track of them (an
// unreadable auth-state.json loads as empty and is then rewritten). Reconcile
// on every start so accounts created outside churn, or orphaned, are usable.
void syncProfilesAtStartup(app.sessionStore, config.services.jellyfin, {
  timeoutMs: config.requestTimeoutMs,
  onWarning: (message) => app.log.warn(message),
  onInfo: (message) => app.log.info(message),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}

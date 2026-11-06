import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev API listens on 4001 by default (see the backend `dev` script) so a
// local docker-compose stack, whose dashboard container publishes 4000 on the
// host network, can keep running alongside `npm run dev`. Set `PORT` to point
// both the backend and this proxy somewhere else; production keeps using 4000.
const apiPort = process.env.PORT?.trim() || "4001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Bind all interfaces so the dev UI is reachable from the LAN (and the
    // tailnet). Override with `--host 127.0.0.1` for a loopback-only session.
    host: true,
    port: 5173,
    proxy: {
      // Preserve the browser's Host header so the backend's same-origin CSRF
      // check sees the Vite dev origin instead of the API target.
      "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
});

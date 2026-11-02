import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
      "/api": { target: "http://127.0.0.1:4000", changeOrigin: false },
    },
  },
});

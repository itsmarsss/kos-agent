import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.KOS_API ?? "http://localhost:4317";

// The dashboard is a static SPA; in dev it proxies /api to the kos serve
// backend so there is no CORS or port juggling.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
});

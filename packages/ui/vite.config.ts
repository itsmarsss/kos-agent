import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.KOS_API ?? "http://localhost:4317";

// The dashboard is a static SPA; in dev it proxies /api to the kos serve
// backend so there is no CORS or port juggling.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // The live socket checks its page's origin, so through the proxy it is
      // the API's own, as it is when KOS serves the dashboard itself.
      "/api/socket": {
        target: apiTarget,
        ws: true,
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReqWs", (req) => req.setHeader("origin", new URL(apiTarget).origin)),
      },
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
});

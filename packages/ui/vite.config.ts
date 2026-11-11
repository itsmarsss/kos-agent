import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";
import { defineConfig } from "vite";

const apiTarget = process.env.KOS_API ?? "http://localhost:4317";

// Only the dashboard's own page is passed on as the API's origin: a request
// the browser calls cross-site (another site's page aimed at the dev server)
// keeps its own, so the API still refuses it.
const fromDashboard = (req: IncomingMessage): boolean => req.headers["sec-fetch-site"] !== "cross-site";

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
        configure: (proxy) => proxy.on("proxyReqWs", (proxyReq, req) => fromDashboard(req) && proxyReq.setHeader("origin", new URL(apiTarget).origin)),
      },
      // A change from another site is refused, by its origin: through the proxy the dashboard's is the API's own too.
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReq", (proxyReq, req) => proxyReq.getHeader("origin") && fromDashboard(req) && proxyReq.setHeader("origin", new URL(apiTarget).origin)),
      },
    },
  },
});

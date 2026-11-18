import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vite";

const apiTarget = process.env.KOS_API ?? "http://localhost:4317";

/**
 * The API's write key for this boot, read fresh for each change: the page
 * the dev server serves is its own and holds none, so the proxy adds it,
 * from the file KOS keeps it in for its port (packages/harness/src/kernel/writekey.ts).
 */
function writeKey(): string | undefined {
  const port = Number(new URL(apiTarget).port || 80);
  const file = process.env.KOS_WRITE_KEY_FILE?.trim() || join(homedir(), ".kos", port === 4317 ? "write.key" : `write-${port}.key`);
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

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
        configure: (proxy) =>
          proxy.on("proxyReqWs", (proxyReq, req) => {
            if (!fromDashboard(req)) return;
            proxyReq.setHeader("origin", new URL(apiTarget).origin);
            // The socket takes the key in its address; the dev page has none, so it goes on here.
            const key = writeKey();
            if (key && !proxyReq.path.includes("key=")) proxyReq.path += `${proxyReq.path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
          }),
      },
      // A change from another site is refused, by its origin: through the proxy the dashboard's is the API's own too.
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) =>
          proxy.on("proxyReq", (proxyReq, req) => {
            if (!proxyReq.getHeader("origin") || !fromDashboard(req)) return;
            proxyReq.setHeader("origin", new URL(apiTarget).origin);
            const key = req.method !== "GET" && req.method !== "HEAD" ? writeKey() : undefined;
            if (key) proxyReq.setHeader("x-kos-write", key);
          }),
      },
    },
  },
});

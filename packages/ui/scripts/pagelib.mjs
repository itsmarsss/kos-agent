// The libraries an HTML page may name, built as plain scripts into dist/page-lib/,
// which the shell inlines into the page's frame (it has no network to load them).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: { react: join(root, "pagelib", "react.ts"), charts: join(root, "pagelib", "charts.ts") },
  outdir: join(root, "dist", "page-lib"),
  bundle: true,
  format: "iife",
  minify: true,
  target: "chrome120",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

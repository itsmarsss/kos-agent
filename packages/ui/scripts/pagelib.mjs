// What an artifact's frame is given, built into dist/page-lib/, which the shell inlines into
// the frame (it has no network to load them) and the server's check reads:
//  - the libraries an HTML page may name (react, charts) and each kind's runtime
//    (kos-doc, kos-deck, kos-sheet), as plain scripts;
//  - the bundled fonts (fonts/*.woff2), inlined on demand as data;
//  - frame.css, the kit's stylesheets as the dashboard gives a frame;
//  - tokens.json, KOS's tokens in both themes, read from the dashboard's stylesheet.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "page-lib");
const lib = (name) => join(root, "pagelib", `${name}.ts`);

await build({
  entryPoints: { react: lib("react"), charts: lib("charts"), "kos-doc": lib("doc"), "kos-deck": lib("deck"), "kos-sheet": lib("sheet") },
  outdir: out,
  bundle: true,
  format: "iife",
  minify: true,
  target: "chrome120",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

mkdirSync(join(out, "fonts"), { recursive: true });
cpSync(join(root, "pagelib", "fonts"), join(out, "fonts"), { recursive: true, filter: (src) => !src.endsWith(".md") });

const kit = join(root, "..", "kit", "src");
writeFileSync(join(out, "frame.css"), `${readFileSync(join(kit, "kit.css"), "utf8")}\n${readFileSync(join(kit, "page.css"), "utf8")}`);

/** The custom properties of every top-level rule whose selector is exactly this, later ones winning. */
function block(css, selector) {
  const props = {};
  const escaped = selector.replace(/[[\]"]/g, "\\$&");
  for (const rule of css.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, "g"))) {
    for (const m of rule[1].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) props[m[1]] = m[2].trim();
  }
  if (!Object.keys(props).length) throw new Error(`styles.css has no ${selector} rule`);
  return props;
}
const styles = readFileSync(join(root, "src", "styles.css"), "utf8");
const dark = block(styles, ":root");
writeFileSync(join(out, "tokens.json"), `${JSON.stringify({ dark, light: { ...dark, ...block(styles, ':root[data-theme="light"]') } }, null, 2)}\n`);

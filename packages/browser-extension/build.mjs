// The extension's dist/: the compiled scripts (tsc puts them there), the
// static files beside them, the popup and the consent window bundled with
// what they import (React, motion, and from @kos/shared KOS's face and the
// dashboard's code that moves it) in a chunk the pages share, and the
// toolbar icons, drawn here in the face's blue with its dark eyes, at each
// size Chrome asks for.
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { KOS_SEED, lookOf } from "@kos/shared";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
for (const file of readdirSync(join(root, "static"))) copyFileSync(join(root, "static", file), join(dist, file));

// KaTeX's stylesheet and the fonts it names, for the formulas in KOS's replies. Chrome takes the woff2 of each.
const katex = join(root, "node_modules", "katex", "dist");
mkdirSync(join(dist, "katex", "fonts"), { recursive: true });
copyFileSync(join(katex, "katex.min.css"), join(dist, "katex", "katex.min.css"));
for (const font of readdirSync(join(katex, "fonts")).filter((f) => f.endsWith(".woff2"))) {
  copyFileSync(join(katex, "fonts", font), join(dist, "katex", "fonts", font));
}

// The pages a person sees are bundled: a page cannot import a package by name. The worker stays tsc's own modules.
await build({
  entryPoints: [join(root, "src", "popup.tsx"), join(root, "src", "consent.tsx"), join(root, "src", "panel.tsx")],
  outdir: dist,
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  format: "esm",
  platform: "browser",
  target: "chrome137",
  // React's production build, without its development checks.
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  logLevel: "warning",
});

const kos = lookOf(KOS_SEED);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const [fillR, fillG, fillB] = rgb(kos.fill);
const ink = rgb(kos.ink);

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, tail]);
};

function png(size) {
  const rows = [];
  const c = size / 2;
  const r = size * 0.46;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const d = Math.hypot(dx, dy);
      // Edge softened over a pixel; KOS's blue, a touch lighter at the top.
      const alpha = Math.max(0, Math.min(1, r - d + 0.5));
      const lift = 0.14 * (1 - (y + 0.5) / size);
      let [red, green, blue] = [fillR, fillG, fillB].map((c) => c + (255 - c) * lift);
      // Eyes: two dark upright ovals, larger than the face's own so a 16 px icon still has them.
      for (const ex of [-0.15, 0.15]) {
        const ox = (dx / size - ex) / 0.06;
        const oy = (dy / size + 0.04) / 0.11;
        if (ox * ox + oy * oy <= 1) [red, green, blue] = ink;
      }
      const i = 1 + x * 4;
      row[i] = red;
      row[i + 1] = green;
      row[i + 2] = blue;
      row[i + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(join(dist, `icon${size}.png`), png(size));
console.log(`built ${dist}`);

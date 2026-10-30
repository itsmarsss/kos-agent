// The extension's dist/: the compiled scripts (tsc puts them there), the
// static files beside them, and the icons, drawn here: KOS's face, a violet
// blob with two eyes, at each size Chrome asks for.
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
for (const file of readdirSync(join(root, "static"))) copyFileSync(join(root, "static", file), join(dist, file));

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
      // Edge softened over a pixel; violet lighter at the top.
      const alpha = Math.max(0, Math.min(1, r - d + 0.5));
      const t = (y + 0.5) / size;
      let [red, green, blue] = [167 - 50 * t, 139 - 60 * t, 250 - 20 * t];
      // Eyes: two rounded upright ovals.
      for (const ex of [-0.17, 0.17]) {
        const ox = (dx / size - ex) / 0.065;
        const oy = (dy / size + 0.04) / 0.11;
        if (ox * ox + oy * oy <= 1) [red, green, blue] = [255, 255, 255];
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

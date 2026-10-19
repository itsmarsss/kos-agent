import { deflateSync } from "node:zlib";

import { EYE_DOT_R, EYE_GLINT, EYE_PILL, eyeAt, outline, smoothPolygon, type FaceSpec } from "@kos/shared";

/**
 * A blob's face as a PNG, drawn here rather than by a browser.
 *
 * A Discord webhook takes its avatar as image bytes when it is made, and the
 * dashboard's face is an SVG a browser draws, so the harness draws the same
 * face itself: the body as the smooth outline the dashboard uses, filled,
 * the eyes as dots or pills with a glint, on nothing. Drawn at twice the
 * size and averaged down, so the edge is smooth without a renderer.
 */

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

function rgb(hex: string): [number, number, number] {
  const m = HEX.exec(hex);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [128, 128, 128];
}

/** Whether a point is inside a closed polygon, by the even-odd rule. */
function inside(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** A point rotated about the face's centre by its tilt, the way the dashboard cocks it. */
function tilted(x: number, y: number, degrees: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  const dx = x - 50;
  const dy = y - 52;
  return [50 + dx * Math.cos(a) - dy * Math.sin(a), 52 + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Inside a pill (a rounded rectangle) centred at the origin. */
function inPill(dx: number, dy: number): boolean {
  const hw = EYE_PILL.w / 2 - EYE_PILL.r;
  const hh = EYE_PILL.h / 2 - EYE_PILL.r;
  const cx = Math.max(-hw, Math.min(hw, dx));
  const cy = Math.max(-hh, Math.min(hh, dy));
  return (dx - cx) ** 2 + (dy - cy) ** 2 <= EYE_PILL.r ** 2;
}

/** The colour at a point of the 100-unit face, or nothing. */
function colourAt(spec: FaceSpec, body: ReadonlyArray<readonly [number, number]>, x: number, y: number): "fill" | "ink" | "glint" | undefined {
  // The drawing is tilted, so the point is turned the other way into its frame.
  const [fx, fy] = tilted(x, y, -spec.tilt);
  for (const side of ["l", "r"] as const) {
    const at = eyeAt(side, spec.shape);
    const dx = fx - at.x;
    const dy = fy - at.y;
    if (spec.eyes === "sparkle" && (dx - EYE_GLINT.x) ** 2 + (dy - EYE_GLINT.y) ** 2 <= EYE_GLINT.r ** 2) return "glint";
    if (spec.eyes === "round" ? dx * dx + dy * dy <= EYE_DOT_R * EYE_DOT_R : inPill(dx, dy)) return "ink";
  }
  return inside(body, fx, fy) ? "fill" : undefined;
}

/** The face as RGBA pixels, `size` on a side, drawn at double size and averaged. */
export function facePixels(spec: FaceSpec, size = 128): Uint8Array {
  const body = smoothPolygon(outline(spec.shape));
  const fill = rgb(spec.fill);
  const ink = rgb(spec.ink);
  const out = new Uint8Array(size * size * 4);
  const sub = 2;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < sub; sy += 1) {
        for (let sx = 0; sx < sub; sx += 1) {
          const x = ((px + (sx + 0.5) / sub) / size) * 100;
          const y = ((py + (sy + 0.5) / sub) / size) * 100;
          const what = colourAt(spec, body, x, y);
          if (!what) continue;
          const c: [number, number, number] = what === "fill" ? fill : what === "ink" ? ink : [255, 255, 255];
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = sub * sub;
      const i = (py * size + px) * 4;
      const covered = a / 255;
      // Premultiplied averages, un-premultiplied for the file.
      out[i] = covered ? Math.round(r / covered) : 0;
      out[i + 1] = covered ? Math.round(g / covered) : 0;
      out[i + 2] = covered ? Math.round(b / covered) : 0;
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** RGBA pixels as a PNG: one unfiltered row after another, deflated. */
export function pngOf(pixels: Uint8Array, size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    raw.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** The face as a PNG file, `size` on a side. */
export function facePng(spec: FaceSpec, size = 128): Buffer {
  return pngOf(facePixels(spec, size), size);
}

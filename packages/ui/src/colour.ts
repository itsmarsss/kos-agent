/**
 * Colour maths for the face editor.
 *
 * A face is a hue; the body's saturation and lightness are the blob's own,
 * so every face is matte and bright and none is mustard or murk. The
 * browser's colour picker speaks hex, so a picked colour becomes its hue
 * and a hue becomes the hex the picker should show.
 */

/** The hue of a hex colour, hsl to hex, and perceived lightness: the harness draws with the same ones. */
export { hexOfHsl, hueOfHex, lightnessOfHex } from "@kos/shared";

/** Hue 0 to 359, saturation and value 0 to 100: the picker's own model. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** A hex colour as HSV; a grey keeps the hue it is given, so the picker's strip does not jump. */
export function hsvOfHex(hex: string, hueIfGrey = 0): Hsv | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  // Kept unrounded, hue included, so a colour read in comes back out the same.
  const sector = d === 0 ? null : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const h = sector === null ? hueIfGrey : (((sector * 60) % 360) + 360) % 360;
  return { h, s: max === 0 ? 0 : (d / max) * 100, v: max * 100 };
}

/** HSV back to hex. */
export function hexOfHsv({ h, s, v }: Hsv): string {
  const hh = (((h % 360) + 360) % 360) / 60;
  const sv = Math.min(100, Math.max(0, s)) / 100;
  const vv = Math.min(100, Math.max(0, v)) / 100;
  const c = vv * sv;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = vv - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const to = (n: number): string =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r!)}${to(g!)}${to(b!)}`;
}

/** A hex colour with its saturation scaled, for a face that is unwell or asleep. */
export function desaturateHex(hex: string, by: number): string {
  const hsv = hsvOfHex(hex);
  return hsv ? hexOfHsv({ ...hsv, s: Math.round(hsv.s * by) }) : hex;
}

/**
 * A face's colour, from its name or from what the owner set.
 *
 * The dashboard draws every blob from these numbers, and a surface that
 * cannot draw a face at all (a Discord embed's stripe, say) uses the same
 * ones, so a blob is the same colour wherever it turns up. KOS itself is
 * not left to the hash: a clear blue.
 */

/** What decides a face's colour: a hue, or any colour, which wins over the hue. */
export interface FaceColour {
  hue?: number;
  /** #rrggbb */
  colour?: string;
}

export const KOS_SEED = "kos";
export const KOS_HUE = 214;
/**
 * The body's saturation, in percent: matte but bright. A muted blob reads
 * as a sad one.
 */
export const FILL_SAT = 84;

const HEX = /^#[0-9a-f]{6}$/i;

/** FNV-1a, so a name is the same number on every machine and every render. */
export function hashName(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The body's lightness for a hue, in percent. Raw HSL at one lightness
 * turns yellow to mustard and blue to murk, so the lightness follows the
 * wheel: lifted around yellow and cyan, eased down around blue and violet.
 */
export function lightnessOf(hue: number): number {
  const rad = ((hue - 75) * Math.PI) / 180;
  return Math.round(60 + 4 * Math.cos(rad));
}

/** A hex colour from hue (degrees), saturation and lightness (percent). */
export function hexOfHsl(hue: number, sat: number, light: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = sat / 100;
  const l = light / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r!)}${to(g!)}${to(b!)}`;
}

/** The hue a name gets when none is set: KOS's own blue, or the name's hash. */
export function hueOfName(seed: string): number {
  const name = seed.trim().toLowerCase() || KOS_SEED;
  return name === KOS_SEED ? KOS_HUE : hashName(name) % 360;
}

/** The body as drawn still, #rrggbb: the colour picked, or the hue's own fill. */
export function bodyHexOf(seed: string, look: FaceColour = {}): string {
  if (look.colour && HEX.test(look.colour)) return look.colour.toLowerCase();
  const hue = look.hue !== undefined && Number.isFinite(look.hue) ? ((Math.round(look.hue) % 360) + 360) % 360 : hueOfName(seed);
  return hexOfHsl(hue, FILL_SAT, lightnessOf(hue));
}

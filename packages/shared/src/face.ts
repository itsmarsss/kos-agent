/**
 * A face's colour, from its name or from what the owner set.
 *
 * The dashboard draws every blob from these numbers, and a surface that
 * cannot draw a face at all (a Discord embed's stripe, say) uses the same
 * ones, so a blob is the same colour wherever it turns up. KOS itself is
 * not left to the hash: a clear blue.
 */

import { eyeAt, isConvex, outline, smoothPath, smoothPolygon, type BlobEyes, type BlobGait, type BlobShape, type BlobWhim, type Lobe } from "./blob.js";

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

/** Mulberry32: a stream of numbers in 0..1 from one, the same on every machine. */
function numbersFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The lumps a word may give: two, three and four bulges round the body,
 * each at most this far out. Few and broad, weaker as they get finer, so
 * the outline is a creature's and never a splat.
 */
const LOBE_REACH: ReadonlyArray<readonly [k: number, most: number]> = [
  [2, 0.09],
  [3, 0.07],
  [4, 0.04],
];

/** A word's proportions, from the same hash its silhouette always came from. */
function proportionsOf(word: string): Omit<BlobShape, "lobes"> {
  const g = hashName(`${word}#`);
  return {
    aspect: 0.92 + ((g % 100) / 100) * 0.2,
    squat: ((g >>> 10) % 3) * 0.12,
    spread: 0.88 + (((g >>> 13) % 100) / 100) * 0.22,
  };
}

/**
 * The silhouette a word grows: its proportions and its lumps, the same
 * word the same creature everywhere. Lumps that would dent the body are
 * eased back until it bulges out all round, so any word gives a shape that
 * is organic and never chaotic.
 */
export function shapeOf(text: string): BlobShape {
  const word = text.trim().toLowerCase();
  const next = numbersFrom(hashName(`${word}~`));
  const lobes: Lobe[] = LOBE_REACH.map(([k, most]) => ({ k, amp: most * (0.3 + 0.7 * next()), phase: (next() * 2 * Math.PI) / k }));
  const shape = { ...proportionsOf(word), lobes };
  for (let ease = 1; ease > 0.05; ease *= 0.8) {
    const eased = { ...shape, lobes: lobes.map((l) => ({ ...l, amp: l.amp * ease })) };
    if (isConvex(smoothPolygon(outline(eased)))) return eased;
  }
  return { ...shape, lobes: [] };
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

/** The hue of a hex colour, or null for a grey, which has none, and for anything that is not a hex colour. */
export function hueOfHex(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return null;
  const sector = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((Math.round(sector * 60) % 360) + 360) % 360;
}

/** Perceived lightness 0 to 100, for choosing ink that shows on a colour. */
export function lightnessOfHex(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return Math.round(((0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255) * 100);
}

/** What the owner may set about a face; anything unset comes from the name. */
export interface FaceLook extends FaceColour {
  eyes?: BlobEyes;
  gait?: BlobGait;
  /** A word its silhouette grows from, in place of its name. */
  shape?: string;
}

/** The longest word a silhouette is grown from. */
export const SHAPE_WORD_MAX = 40;

/** A shape word as kept: trimmed, one space between words, no commas, at most SHAPE_WORD_MAX; empty is none. */
export function shapeWordOf(text: string): string | undefined {
  const word = text.replace(/[\s,]+/g, " ").trim().slice(0, SHAPE_WORD_MAX).trim();
  return word || undefined;
}

/** A face, decided: everything the dashboard animates and the harness draws, from the name and what the owner set. */
export interface FaceSpec {
  /** 0 to 359: the hue the whole blob is built from, and that its accents take. */
  hue: number;
  /** The body's colour, #rrggbb: the hue's own matte fill, or any colour the owner picked. */
  fill: string;
  /** The eyes' colour, #rrggbb: dark on a light body, light on a dark one. */
  ink: string;
  /** The picked colour, when the body is one rather than the hue's fill. */
  colour?: string;
  gait: BlobGait;
  eyes: BlobEyes;
  /** Degrees the face is cocked, -3 to 3. */
  tilt: number;
  /** The number its whims come from. */
  seed: number;
  shape: BlobShape;
  /** The word the silhouette grew from, when the owner gave one. */
  shapeWord?: string;
  whim: BlobWhim;
}

export const EYES: BlobEyes[] = ["round", "half", "sparkle"];

/** The eyes as the dashboard draws them: round dots, or pills, with a glint on a sparkle. */
export const EYE_DOT_R = 4;
export const EYE_PILL = { w: 5.4, h: 9.6, r: 2.7 } as const;
export const EYE_GLINT = { x: -1, y: -2.4, r: 1 } as const;

/**
 * What a device needs to draw KOS as the owner set it: the colours, the
 * eyes, the gait and the outline, decided here so no device repeats the
 * hash. KOS sends it to its devices (docs/computer.md); its whims are KOS's
 * own and need no sending.
 */
export interface FaceDrawing {
  fill: string;
  ink: string;
  eyes: BlobEyes;
  gait: BlobGait;
  shape: BlobShape;
}

export function drawingOf(spec: FaceSpec): FaceDrawing {
  return { fill: spec.fill, ink: spec.ink, eyes: spec.eyes, gait: spec.gait, shape: spec.shape };
}

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

/** A drawing as a device reads one off the wire: every part checked, or nothing. */
export function readDrawing(raw: unknown): FaceDrawing | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const s = (typeof r["shape"] === "object" && r["shape"] !== null ? r["shape"] : {}) as Record<string, unknown>;
  const aspect = num(s["aspect"], 0.5, 2);
  const squat = num(s["squat"], 0, 1);
  const spread = num(s["spread"], 0.5, 2);
  const lobes = Array.isArray(s["lobes"]) ? s["lobes"] : undefined;
  const gait = r["gait"];
  if (typeof r["fill"] !== "string" || !HEX.test(r["fill"]) || typeof r["ink"] !== "string" || !HEX.test(r["ink"])) return undefined;
  if (!EYES.includes(r["eyes"] as BlobEyes) || ![0, 1, 2, 3].includes(gait as number)) return undefined;
  if (aspect === undefined || squat === undefined || spread === undefined || !lobes || lobes.length > 8) return undefined;
  const read: Lobe[] = [];
  for (const l of lobes) {
    const lobe = (typeof l === "object" && l !== null ? l : {}) as Record<string, unknown>;
    const k = num(lobe["k"], 1, 8);
    const amp = num(lobe["amp"], 0, 0.3);
    const phase = num(lobe["phase"], -10, 10);
    if (k === undefined || !Number.isInteger(k) || amp === undefined || phase === undefined) return undefined;
    read.push({ k, amp, phase });
  }
  return { fill: r["fill"].toLowerCase(), ink: r["ink"].toLowerCase(), eyes: r["eyes"] as BlobEyes, gait: gait as BlobGait, shape: { aspect, squat, spread, lobes: read } };
}

/**
 * The face drawn still, as an SVG: the same body, eyes and tilt the
 * dashboard animates, held at rest. Written into a blob's folder as
 * face.svg, so anything can reuse it.
 */
export function faceSvg(spec: FaceSpec): string {
  const body = smoothPath(outline(spec.shape));
  const eye = (side: "l" | "r"): string => {
    const at = eyeAt(side, spec.shape);
    const shape =
      spec.eyes === "round"
        ? `<circle r="${EYE_DOT_R}" fill="${spec.ink}"/>`
        : `<rect x="${-EYE_PILL.w / 2}" y="${-EYE_PILL.h / 2}" width="${EYE_PILL.w}" height="${EYE_PILL.h}" rx="${EYE_PILL.r}" fill="${spec.ink}"/>`;
    const glint = spec.eyes === "sparkle" ? `<circle cx="${EYE_GLINT.x}" cy="${EYE_GLINT.y}" r="${EYE_GLINT.r}" fill="#fff"/>` : "";
    return `<g transform="translate(${at.x.toFixed(2)} ${at.y.toFixed(2)})">${shape}${glint}</g>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="rotate(${spec.tilt} 50 52)"><path d="${body}" fill="${spec.fill}"/>${eye("l")}${eye("r")}</g></svg>`;
}

/** The eyes' colour for a hue: a dark ink of the same family. */
export function inkOf(hue: number): string {
  return hexOfHsl(hue, 35, 12);
}

/** Ink for a picked colour: the usual dark ink, or a pale one on a body too dark for it. */
export function inkOn(colour: string, hue: number): string {
  return (lightnessOfHex(colour) ?? 60) < 38 ? hexOfHsl(hue, 30, 92) : inkOf(hue);
}

/**
 * The face a name gets, with what the owner set laid over it. KOS itself is
 * not left to the hash: a clear blue, half eyes, a lively gait, no tilt, and
 * the plain gumdrop unless the owner gives it a word to grow from.
 */
export function lookOf(seed: string, override: FaceLook = {}): FaceSpec {
  const name = seed.trim().toLowerCase() || KOS_SEED;
  const h = hashName(name);
  const kos = name === KOS_SEED;
  const gait = kos ? 1 : (((h >>> 9) % 4) as BlobGait);
  // A second number, so the silhouette and the habits are not the hue's twins.
  const g = hashName(`${name}#`);
  const hue = hueOfName(name);
  const shapeWord = override.shape === undefined ? undefined : shapeWordOf(override.shape);
  const base: FaceSpec = {
    hue,
    fill: hexOfHsl(hue, FILL_SAT, lightnessOf(hue)),
    ink: inkOf(hue),
    gait,
    eyes: kos ? "half" : EYES[(h >>> 12) % 3]!,
    tilt: kos ? 0 : ((h >>> 18) % 7) - 3,
    seed: h,
    shape: shapeWord ? shapeOf(shapeWord) : kos ? { ...proportionsOf(name), lobes: [] } : shapeOf(name),
    ...(shapeWord ? { shapeWord } : {}),
    whim: {
      curiosity: 0.7 + (((g >>> 20) % 50) / 100) * 1,
      blinkiness: 0.7 + (((g >>> 26) % 60) / 100) * 1,
    },
  };
  const set = override.gait !== undefined && [0, 1, 2, 3].includes(override.gait) ? override.gait : gait;
  const colour = override.colour && HEX.test(override.colour) ? override.colour.toLowerCase() : undefined;
  // A picked colour is the body; its hue (a grey keeps the name's) is the accent.
  const setHue = colour ? (hueOfHex(colour) ?? (override.hue !== undefined && Number.isFinite(override.hue) ? override.hue : base.hue)) : override.hue !== undefined && Number.isFinite(override.hue) ? override.hue : base.hue;
  const finalHue = ((Math.round(setHue) % 360) + 360) % 360;
  return {
    ...base,
    hue: finalHue,
    fill: colour ?? hexOfHsl(finalHue, FILL_SAT, lightnessOf(finalHue)),
    ink: colour ? inkOn(colour, finalHue) : inkOf(finalHue),
    ...(colour ? { colour } : {}),
    ...(override.eyes && EYES.includes(override.eyes) ? { eyes: override.eyes } : {}),
    gait: set,
  };
}

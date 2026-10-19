/**
 * The blob's silhouette, as numbers.
 *
 * The dashboard animates it and the harness draws it still (a Discord
 * avatar, say), so the shape lives here where both can reach it: one
 * smooth gumdrop in a 100-unit box, a little wider low down where it sits,
 * flattened underneath as much as its shape says, two eyes a little high,
 * which reads young.
 */

export type BlobEyes = "round" | "half" | "sparkle";
export type BlobGait = 0 | 1 | 2 | 3;

/**
 * The silhouette: what makes one blob a different creature from the next
 * before it moves. A little wider or taller, sitting squat or standing
 * round, eyes close-set or wide. From the name, not set.
 */
export interface BlobShape {
  /** Width over height, 0.92 to 1.12. */
  aspect: number;
  /** How much the bottom flattens, as if sat down, 0 to 0.24. */
  squat: number;
  /** How far apart the eyes sit, 0.88 to 1.1 of the usual. */
  spread: number;
}

/** Its habits: how much it cares about the cursor, and how often it blinks. */
export interface BlobWhim {
  curiosity: number;
  blinkiness: number;
}

export const PLAIN_SHAPE: BlobShape = { aspect: 1, squat: 0.1, spread: 1 };
export const PLAIN_WHIM: BlobWhim = { curiosity: 1, blinkiness: 1 };

export const POINTS = 16;
export const CENTER = { x: 50, y: 52 } as const;
export const RADIUS = 38;

/** The eyes' resting places, in the 100-unit box, before the spread. */
export const EYE_L = { x: 41, y: 48 } as const;
export const EYE_R = { x: 59, y: 48 } as const;

/** Where an eye sits for a shape: spread from the middle. */
export function eyeAt(side: "l" | "r", shape: BlobShape): { x: number; y: number } {
  const base = side === "l" ? EYE_L : EYE_R;
  return { x: CENTER.x + (base.x - CENTER.x) * shape.spread, y: base.y };
}

/**
 * The outline: one smooth gumdrop, a little wider low down where it sits,
 * flattened underneath as much as its shape says, and bent by a wobble, a
 * two-lobed deformation the jelly spring drives. Pure, so a test can hold
 * it still.
 */
export function outline(shape: BlobShape = PLAIN_SHAPE, wobble = 0, phase = 0): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < POINTS; i += 1) {
    const a = (i / POINTS) * Math.PI * 2;
    const down = Math.max(0, Math.sin(a));
    // A gumdrop: the lower half spreads a touch; a wobble pulls two sides out and two in.
    const r = RADIUS * (1 + wobble * Math.cos(2 * (a - phase)));
    const x = CENTER.x + Math.cos(a) * r * shape.aspect * (1 + 0.07 * down);
    const y = CENTER.y + Math.sin(a) * r * (1 - shape.squat * 0.45 * down);
    pts.push([x, y]);
  }
  return pts;
}

/** The cubic Bézier control points a closed Catmull-Rom curve through the points has, one segment per point. */
export function smoothSegments(pts: ReadonlyArray<readonly [number, number]>): Array<[[number, number], [number, number], [number, number], [number, number]]> {
  const n = pts.length;
  const out: Array<[[number, number], [number, number], [number, number], [number, number]]> = [];
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    out.push([
      [p1[0], p1[1]],
      [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      [p2[0], p2[1]],
    ]);
  }
  return out;
}

const f = (n: number): string => n.toFixed(2);

/** A closed, smooth path through the points: Catmull-Rom as cubic Béziers, so no corner ever shows. */
export function smoothPath(pts: ReadonlyArray<readonly [number, number]>): string {
  if (pts.length < 3) return "";
  const segments = smoothSegments(pts);
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (const [, c1, c2, p2] of segments) d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  return `${d} Z`;
}

/** The smooth outline as a dense polygon, for a drawing that fills rather than strokes. */
export function smoothPolygon(pts: ReadonlyArray<readonly [number, number]>, perSegment = 12): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [p1, c1, c2, p2] of smoothSegments(pts)) {
    for (let k = 0; k < perSegment; k += 1) {
      const t = k / perSegment;
      const u = 1 - t;
      out.push([
        u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0],
        u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1],
      ]);
    }
  }
  return out;
}

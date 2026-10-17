/**
 * The blob as a creature rather than an animation.
 *
 * A looping shape tween reads as a screensaver: it repeats, it ignores you,
 * and every blob does the same thing. This drives each face frame by frame
 * instead. The outline is pushed about by slow waves that never line up, so
 * the shape is never the same twice; the body squashes and stretches on a
 * spring, so a hover or a poke moves it the way a jelly moves; the eyes
 * follow the pointer, drift when it is gone, and blink when they feel like
 * it. Mood is expressed through all of that (how fast it breathes, where it
 * looks, what the eyes do) rather than a class swap. The drawing itself is
 * as plain as it can be, a flat shape and two eyes, so the life is in the
 * motion and not in the rendering. One ticker drives every blob on the
 * page, and it stops when the tab is hidden or the last blob leaves.
 */

export type BlobMood = "idle" | "working" | "needs-you" | "error" | "asleep";
export type BlobEyes = "round" | "half" | "sparkle";
export type BlobGait = 0 | 1 | 2 | 3;

export interface BlobParams {
  /** A number from the name: the phases of its waves, so two blobs never move in step. */
  seed: number;
  gait: BlobGait;
  eyes: BlobEyes;
  /** Degrees the face is cocked. */
  tilt: number;
}

/** How a blob moves: how far its outline wanders, how fast, how jittery, and how slowly it breathes. */
export interface GaitSpec {
  amp: number;
  speed: number;
  jitter: number;
  breath: number;
}

export const GAITS: readonly GaitSpec[] = [
  { amp: 0.045, speed: 0.55, jitter: 0.2, breath: 5.5 }, // steady
  { amp: 0.065, speed: 0.95, jitter: 0.45, breath: 4 }, // lively
  { amp: 0.06, speed: 0.35, jitter: 0.1, breath: 7 }, // slow
  { amp: 0.05, speed: 1.35, jitter: 0.75, breath: 3.4 }, // restless
];

export const POINTS = 10;
export const CENTER = { x: 50, y: 52 } as const;
export const RADIUS = 38;

/** The eyes' resting places, in the 100-unit box. */
export const EYE_L = { x: 41, y: 50 } as const;
export const EYE_R = { x: 59, y: 50 } as const;

interface MoodSpec {
  speed: number;
  amp: number;
  /** How open the eyes are, before blinks. */
  open: number;
  /** How big the eyes are. */
  wide: number;
  look: "pointer" | "dart" | "straight";
  hop: boolean;
  /** How far the body sags. */
  droop: number;
}

const MOODS: Record<BlobMood, MoodSpec> = {
  idle: { speed: 1, amp: 1, open: 1, wide: 1, look: "pointer", hop: false, droop: 0 },
  working: { speed: 2.1, amp: 1.25, open: 0.9, wide: 0.95, look: "dart", hop: false, droop: 0 },
  "needs-you": { speed: 1.5, amp: 1.1, open: 1, wide: 1.3, look: "pointer", hop: true, droop: 0 },
  error: { speed: 0.6, amp: 0.5, open: 0.16, wide: 1, look: "straight", hop: false, droop: 4 },
  asleep: { speed: 0.45, amp: 0.7, open: 0.08, wide: 1, look: "straight", hop: false, droop: 1 },
};

function phases(seed: number): [number, number, number] {
  const turn = Math.PI * 2;
  return [((seed % 1000) / 1000) * turn, (((seed >>> 10) % 1000) / 1000) * turn, (((seed >>> 20) % 1000) / 1000) * turn];
}

/**
 * The outline at time t: POINTS points around the centre, each pushed in or
 * out by three waves of unrelated speeds, so the shape wanders without ever
 * repeating. Pure, so a test can hold it still.
 */
export function outline(t: number, seed: number, gait: GaitSpec, ampScale = 1): Array<[number, number]> {
  const [p1, p2, p3] = phases(seed);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < POINTS; i += 1) {
    const a = (i / POINTS) * Math.PI * 2;
    const w =
      Math.sin(t * gait.speed + i * 1.9 + p1) * 0.55 +
      Math.sin(t * gait.speed * 1.73 + i * 3.3 + p2) * 0.3 +
      Math.sin(t * gait.speed * 0.61 - i * 1.1 + p3) * 0.35 * (0.5 + gait.jitter);
    const r = RADIUS * (1 + gait.amp * ampScale * w);
    pts.push([CENTER.x + Math.cos(a) * r, CENTER.y + Math.sin(a) * r]);
  }
  return pts;
}

const f = (n: number): string => n.toFixed(2);

/** A closed, smooth path through the points: Catmull-Rom as cubic Béziers, so no corner ever shows. */
export function smoothPath(pts: ReadonlyArray<readonly [number, number]>): string {
  const n = pts.length;
  if (n < 3) return "";
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d} Z`;
}

/** The pointer, shared by every blob on the page. */
const pointer = { x: 0, y: 0, at: -Infinity, seen: false };
let listening = false;
function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.at = performance.now();
      pointer.seen = true;
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", ensureTicking);
}

interface Parts {
  all: SVGGElement;
  body: SVGPathElement;
  eyeL: SVGGElement;
  eyeR: SVGGElement;
  /** The eye shapes, hidden while the grins show. */
  eyes: SVGElement[];
  /** The upturned arcs the eyes become when it is pleased. */
  grins: SVGElement[];
  mark: SVGTextElement | null;
}

interface Blob {
  svg: SVGSVGElement;
  parts: Parts;
  params: BlobParams;
  gait: GaitSpec;
  mood: BlobMood;
  still: boolean;
  t0: number;
  /** Scale and its velocity: the spring the body moves on. */
  sx: number;
  sy: number;
  vx: number;
  vy: number;
  /** Where the eyes are looking, and where they are headed. */
  lookX: number;
  lookY: number;
  aimX: number;
  aimY: number;
  nextAim: number;
  /** Blinks: when the next starts, and when the current one began. */
  nextBlink: number;
  blinkAt: number;
  hover: boolean;
  happyUntil: number;
  rect: { x: number; y: number; w: number; h: number } | null;
  rectAt: number;
  rand: () => number;
}

/** A small seeded generator, so one blob's whims are its own. */
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const live = new Set<Blob>();
let raf = 0;
let last = 0;

function ensureTicking(): void {
  if (raf || live.size === 0) return;
  if (typeof requestAnimationFrame !== "function") return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
}

function frame(now: number): void {
  raf = 0;
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  for (const b of live) step(b, now, dt);
  if (live.size > 0 && (typeof document === "undefined" || document.visibilityState !== "hidden")) {
    raf = requestAnimationFrame(frame);
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function step(b: Blob, now: number, dt: number): void {
  const mood = MOODS[b.mood];
  const t = ((now - b.t0) / 1000) * mood.speed;
  const breath = 1 + 0.02 * Math.sin((t * Math.PI * 2) / b.gait.breath);
  const happy = now < b.happyUntil;

  // The body: a spring toward how it wants to stand, pushed by hovers and pokes.
  let tx = 1;
  let ty = 1;
  let hopY = 0;
  if (b.hover) {
    tx = 1.06;
    ty = 0.94;
  }
  if (mood.hop) {
    const h = Math.max(0, Math.sin((t * Math.PI * 2) / 1.1));
    hopY = -6 * h;
    const land = Math.max(0, -Math.sin((t * Math.PI * 2) / 1.1));
    tx += 0.08 * land;
    ty -= 0.08 * land;
  }
  if (b.mood === "error") {
    tx = 1.03;
    ty = 0.9;
  }
  const k = 160;
  const damp = Math.exp(-dt * 8);
  b.vx = (b.vx + (tx - b.sx) * k * dt) * damp;
  b.vy = (b.vy + (ty - b.sy) * k * dt) * damp;
  b.sx += b.vx * dt;
  b.sy += b.vy * dt;

  // Where to look: the pointer when it is about, a drift of its own when not.
  if (now - b.rectAt > 400) {
    const r = b.svg.getBoundingClientRect();
    b.rect = r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    b.rectAt = now;
  }
  let leanX = 0;
  const pointerFresh = pointer.seen && now - pointer.at < 6000;
  if (mood.look === "straight") {
    b.aimX = 0;
    b.aimY = 0;
  } else if (mood.look === "pointer" && pointerFresh && b.rect) {
    const cx = b.rect.x + b.rect.w / 2;
    const cy = b.rect.y + b.rect.h / 2;
    const dx = pointer.x - cx;
    const dy = pointer.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, dist / 90);
    b.aimX = (dx / dist) * 3.2 * reach;
    b.aimY = (dy / dist) * 2.4 * reach;
    const near = Math.max(0, 1 - dist / 160);
    leanX = (dx / dist) * 2.5 * near;
  } else if (now > b.nextAim) {
    // A glance of its own: somewhere, then back, at its own pace. Working,
    // it darts about; idle, it wanders.
    const dart = mood.look === "dart";
    b.aimX = (b.rand() * 2 - 1) * (dart ? 3 : 2.4);
    b.aimY = (b.rand() * 2 - 1) * (dart ? 2.2 : 1.6);
    b.nextAim = now + (dart ? 500 + b.rand() * 700 : 2500 + b.rand() * 4500);
  }
  const ease = 1 - Math.exp(-dt * (mood.look === "dart" ? 14 : 9));
  b.lookX += (b.aimX - b.lookX) * ease;
  b.lookY += (b.aimY - b.lookY) * ease;

  // Blinks: now and then, sometimes twice; never while asleep, which is one long blink.
  let blink = 1;
  if (b.mood !== "asleep" && !happy) {
    if (b.blinkAt < 0 && now >= b.nextBlink) b.blinkAt = now;
    if (b.blinkAt >= 0) {
      const p = (now - b.blinkAt) / 150;
      if (p >= 1) {
        b.blinkAt = -1;
        b.nextBlink = now + (b.rand() < 0.25 ? 220 : 2500 + b.rand() * 4000);
      } else {
        blink = 1 - 0.92 * Math.sin(p * Math.PI);
      }
    }
  }
  // Half eyes rest a little lowered: relaxed, not shut.
  const relaxed = b.params.eyes === "half" ? 0.7 : 1;
  const open = clamp(mood.open * relaxed * blink, 0.06, 1.3);
  const wide = mood.wide * (b.hover ? 1.08 : 1);

  // Draw.
  const { parts } = b;
  parts.body.setAttribute("d", smoothPath(outline(t, b.params.seed, b.gait, mood.amp)));
  parts.all.setAttribute(
    "transform",
    `translate(${f(CENTER.x + leanX)} ${f(CENTER.y + hopY + mood.droop)}) scale(${f(b.sx * breath)} ${f(b.sy * (2 - breath))}) translate(${-CENTER.x} ${-CENTER.y})`,
  );
  const eye = (el: SVGGElement, x: number, y: number): void => {
    const slant = b.mood === "error" ? (x < 50 ? 18 : -18) : 0;
    el.setAttribute("transform", `translate(${f(x + b.lookX)} ${f(y + b.lookY)}) rotate(${slant}) scale(${f(wide)} ${f(happy ? wide : wide * open)})`);
  };
  eye(parts.eyeL, EYE_L.x, EYE_L.y);
  eye(parts.eyeR, EYE_R.x, EYE_R.y);
  // Pleased: the eyes become arcs, the way a smile shows on a face with no mouth.
  for (const el of parts.eyes) el.setAttribute("opacity", happy ? "0" : "1");
  for (const el of parts.grins) el.setAttribute("opacity", happy ? "1" : "0");
  if (parts.mark) {
    if (b.mood === "needs-you") {
      parts.mark.setAttribute("transform", `translate(0 ${f(hopY * 0.6 - 2 * Math.max(0, Math.sin(t * 7)))})`);
    } else {
      // A z drifting up and fading, again and again.
      const p = (t / 2.2) % 1;
      parts.mark.setAttribute("transform", `translate(${f(p * 3)} ${f(-p * 10)})`);
      parts.mark.setAttribute("opacity", f(p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85));
    }
  }
}

export interface BlobHandle {
  setMood: (mood: BlobMood) => void;
  hover: (on: boolean) => void;
  /** A poke: it jiggles, and is pleased about it for a moment. */
  poke: () => void;
  dispose: () => void;
}

function part<T extends Element>(svg: SVGSVGElement, name: string): T | null {
  return svg.querySelector<T>(`[data-part="${name}"]`);
}

/**
 * Bring a face to life. The SVG holds the parts (see Face.tsx); this moves
 * them. `still` draws one frame and leaves it, for anyone who asked the
 * browser for less motion.
 */
export function mountBlob(svg: SVGSVGElement, params: BlobParams, mood: BlobMood, options: { still?: boolean } = {}): BlobHandle {
  const all = part<SVGGElement>(svg, "all");
  const body = part<SVGPathElement>(svg, "body");
  const eyeL = part<SVGGElement>(svg, "eye-l");
  const eyeR = part<SVGGElement>(svg, "eye-r");
  if (!all || !body || !eyeL || !eyeR) throw new Error("a blob needs its parts");
  const rand = rng(params.seed);
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  const b: Blob = {
    svg,
    parts: {
      all,
      body,
      eyeL,
      eyeR,
      eyes: Array.from(svg.querySelectorAll<SVGElement>('[data-part="eye"]')),
      grins: Array.from(svg.querySelectorAll<SVGElement>('[data-part="grin"]')),
      mark: part<SVGTextElement>(svg, "mark"),
    },
    params,
    gait: GAITS[params.gait] ?? GAITS[0]!,
    mood,
    still: options.still === true,
    // Started somewhere along its waves, so a row of blobs does not breathe in unison.
    t0: now - rand() * 60000,
    sx: 1,
    sy: 1,
    vx: 0,
    vy: 0,
    lookX: 0,
    lookY: 0,
    aimX: 0,
    aimY: 0,
    nextAim: now + 1000 + rand() * 3000,
    nextBlink: now + 1500 + rand() * 3000,
    blinkAt: -1,
    hover: false,
    happyUntil: 0,
    rect: null,
    rectAt: -Infinity,
    rand,
  };
  step(b, now, 0.016);
  if (!b.still) {
    listen();
    live.add(b);
    ensureTicking();
  }
  return {
    setMood: (m) => {
      if (m === b.mood) return;
      b.mood = m;
      // The mark is in the SVG only for the moods that have one; React swaps it.
      b.parts.mark = part<SVGTextElement>(svg, "mark");
      // A change of mood is felt: a small start.
      b.vy -= 1.2;
      b.vx += 1.2;
      if (b.still) step(b, performance.now(), 0.016);
    },
    hover: (on) => {
      b.hover = on;
      if (on) b.vy -= 0.8;
    },
    poke: () => {
      b.vx += 3.2;
      b.vy -= 3.2;
      b.happyUntil = performance.now() + 1600;
      if (b.still) step(b, performance.now(), 0.016);
    },
    dispose: () => {
      live.delete(b);
    },
  };
}

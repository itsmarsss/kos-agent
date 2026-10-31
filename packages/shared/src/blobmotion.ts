/**
 * The blob as a creature rather than an animation.
 *
 * A proper blob is a clean rounded shape that is alive in how it moves, not
 * in its edge. So the body is one smooth gumdrop, a little wider at the
 * bottom where it sits, and everything lively happens to the whole of it:
 * it breathes, it squashes when you hover, it wobbles like jelly on a
 * spring when you poke it and settles, it fidgets now and then of its own
 * accord, sways while it works, hops when it needs you and sags on an
 * error. The eyes follow the pointer, drift when it is gone, and blink when
 * they feel like it. One ticker drives every blob on the page, and it stops
 * when the tab is hidden or the last blob leaves.
 *
 * Here rather than in the dashboard so that every page that shows KOS's
 * face moves it the same way: the dashboard's, and the extension's popup and
 * consent window. Imported as @kos/shared/blobmotion, apart from the rest of
 * the package, since it needs a page to run in.
 */

export type BlobMood = "idle" | "working" | "needs-you" | "error" | "asleep";
import { CENTER, PLAIN_SHAPE, PLAIN_WHIM, eyeAt, outline, smoothPath, type BlobEyes, type BlobGait, type BlobShape, type BlobWhim } from "./blob.js";

const f = (n: number): string => n.toFixed(2);

export interface BlobParams {
  /** A number from the name: the timing of its whims, so two blobs never move in step. */
  seed: number;
  gait: BlobGait;
  eyes: BlobEyes;
  /** Degrees the face is cocked. */
  tilt: number;
  shape?: BlobShape;
  whim?: BlobWhim;
}

/**
 * How a blob carries itself: how slowly it breathes, how springy it is when
 * pushed, how long a wobble lasts, and how often it fidgets.
 */
export interface GaitSpec {
  breath: number;
  /** Stiffness of the jelly, in 1/s²: higher wobbles faster. */
  spring: number;
  /** How quickly a wobble dies, in 1/s: lower keeps it going. */
  settle: number;
  /** Seconds between fidgets, roughly. */
  fidget: number;
}

export const GAITS: readonly GaitSpec[] = [
  { breath: 5.5, spring: 320, settle: 5, fidget: 7 }, // steady
  { breath: 4, spring: 420, settle: 4, fidget: 4 }, // lively
  { breath: 7, spring: 240, settle: 6, fidget: 10 }, // slow
  { breath: 3.4, spring: 520, settle: 3.5, fidget: 2.5 }, // restless
];

interface MoodSpec {
  speed: number;
  /** How open the eyes are, before blinks. */
  open: number;
  /** How big the eyes are. */
  wide: number;
  look: "pointer" | "dart" | "straight";
  hop: boolean;
  /** Side to side, while it works. */
  sway: number;
  /** How far the body sags. */
  droop: number;
}

const MOODS: Record<BlobMood, MoodSpec> = {
  idle: { speed: 1, open: 1, wide: 1, look: "pointer", hop: false, sway: 0, droop: 0 },
  working: { speed: 1.8, open: 0.92, wide: 0.95, look: "dart", hop: false, sway: 1.6, droop: 0 },
  "needs-you": { speed: 1.4, open: 1, wide: 1.25, look: "pointer", hop: true, sway: 0, droop: 0 },
  error: { speed: 0.6, open: 0.16, wide: 1, look: "straight", hop: false, sway: 0, droop: 4 },
  asleep: { speed: 0.45, open: 0.08, wide: 1, look: "straight", hop: false, sway: 0, droop: 1 },
};

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
  shape: BlobShape;
  whim: BlobWhim;
  gait: GaitSpec;
  mood: BlobMood;
  still: boolean;
  t0: number;
  /** Scale and its velocity: the spring the body stands on. */
  sx: number;
  sy: number;
  vx: number;
  vy: number;
  /** The jelly: a two-lobed wobble and its velocity, and which way it leans. */
  wob: number;
  wv: number;
  wobPhase: number;
  nextFidget: number;
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
  const happy = now < b.happyUntil;

  // Breathing: a little taller then a little wider, the way a soft thing breathes.
  const br = Math.sin((t * Math.PI * 2) / b.gait.breath);
  const breathX = 1 - 0.012 * br;
  const breathY = 1 + 0.022 * br;

  // The body: a spring toward how it wants to stand, pushed by hovers and pokes.
  let tx = 1;
  let ty = 1;
  let hopY = 0;
  if (b.hover) {
    tx = 1.08;
    ty = 0.92;
  }
  if (mood.hop) {
    const h = Math.max(0, Math.sin((t * Math.PI * 2) / 1.1));
    hopY = -7 * h;
    const land = Math.max(0, -Math.sin((t * Math.PI * 2) / 1.1));
    tx += 0.1 * land;
    ty -= 0.1 * land;
  }
  if (b.mood === "error") {
    tx = 1.05;
    ty = 0.88;
  }
  const k = 160;
  const damp = Math.exp(-dt * 8);
  b.vx = (b.vx + (tx - b.sx) * k * dt) * damp;
  b.vy = (b.vy + (ty - b.sy) * k * dt) * damp;
  b.sx += b.vx * dt;
  b.sy += b.vy * dt;

  // The jelly: a wobble that rings and settles, started by a poke, a mood,
  // or a fidget of its own.
  if (now > b.nextFidget && b.mood !== "asleep" && b.mood !== "error") {
    b.wv += 0.5 + b.rand() * 0.4;
    b.wobPhase = b.rand() * Math.PI;
    b.nextFidget = now + (b.gait.fidget * 1000 * (0.6 + b.rand() * 0.8)) / (b.mood === "working" ? 1.6 : 1);
  }
  b.wv = (b.wv - b.wob * b.gait.spring * dt) * Math.exp(-dt * b.gait.settle);
  b.wob += b.wv * dt;

  // Where to look: the pointer when it is about, a drift of its own when not.
  if (now - b.rectAt > 400) {
    const r = b.svg.getBoundingClientRect();
    b.rect = r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    b.rectAt = now;
  }
  let leanX = mood.sway * Math.sin(t * 2.2);
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
    const reach = Math.min(1, dist / 90) * b.whim.curiosity;
    b.aimX = (dx / dist) * 3.2 * reach;
    b.aimY = (dy / dist) * 2.4 * reach;
    const near = Math.max(0, 1 - dist / 160);
    leanX += (dx / dist) * 2.5 * near * b.whim.curiosity;
  } else if (now > b.nextAim) {
    // A glance of its own: somewhere, then back, at its own pace. Working,
    // it darts about; idle, it wanders.
    const dart = mood.look === "dart";
    b.aimX = (b.rand() * 2 - 1) * (dart ? 3 : 2.4);
    // At rest it looks a little up, the way something attentive does.
    b.aimY = (b.rand() * 2 - 1) * (dart ? 2.2 : 1.4) - (dart ? 0 : 0.8);
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
        b.nextBlink = now + (b.rand() < 0.25 ? 220 : (2500 + b.rand() * 4000) / b.whim.blinkiness);
      } else {
        blink = 1 - 0.92 * Math.sin(p * Math.PI);
      }
    }
  }
  const open = clamp(mood.open * blink, 0.06, 1.3);
  const wide = mood.wide * (b.hover ? 1.08 : 1);

  // Draw.
  const { parts } = b;
  parts.body.setAttribute("d", smoothPath(outline(b.shape, clamp(b.wob, -0.14, 0.14), b.wobPhase)));
  // The jelly leans the way it wobbles, a touch, so a wobble is not only an outline.
  const skew = b.wob * 18;
  parts.all.setAttribute(
    "transform",
    `translate(${f(CENTER.x + leanX)} ${f(CENTER.y + hopY + mood.droop)}) scale(${f(b.sx * breathX)} ${f(b.sy * breathY)}) skewX(${f(skew)}) translate(${-CENTER.x} ${-CENTER.y})`,
  );
  const eye = (el: SVGGElement, x: number, y: number): void => {
    const slant = b.mood === "error" ? (x < 50 ? 18 : -18) : 0;
    el.setAttribute("transform", `translate(${f(x + b.lookX)} ${f(y + b.lookY)}) rotate(${slant}) scale(${f(wide)} ${f(happy ? wide : wide * open)})`);
  };
  const atL = eyeAt("l", b.shape);
  const atR = eyeAt("r", b.shape);
  eye(parts.eyeL, atL.x, atL.y);
  eye(parts.eyeR, atR.x, atR.y);
  // Pleased: the eyes become arcs, the way a face with no mouth smiles.
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
  /** A poke: it wobbles like jelly, and is pleased about it for a moment. */
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
  const gait = GAITS[params.gait] ?? GAITS[0]!;
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
    shape: params.shape ?? PLAIN_SHAPE,
    whim: params.whim ?? PLAIN_WHIM,
    gait,
    mood,
    still: options.still === true,
    // Started somewhere along its breath, so a row of blobs does not breathe in unison.
    t0: now - rand() * 60000,
    sx: 1,
    sy: 1,
    vx: 0,
    vy: 0,
    wob: 0,
    wv: 0,
    wobPhase: rand() * Math.PI,
    nextFidget: now + gait.fidget * 1000 * rand(),
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
      // A change of mood is felt: a small start and a wobble.
      b.vy -= 1.2;
      b.vx += 1.2;
      b.wv += 0.8;
      if (b.still) step(b, performance.now(), 0.016);
    },
    hover: (on) => {
      b.hover = on;
      if (on) b.vy -= 0.8;
    },
    poke: () => {
      b.vx += 2.6;
      b.vy -= 2.6;
      b.wv += 2.4;
      b.wobPhase = b.rand() * Math.PI;
      b.happyUntil = performance.now() + 1600;
      if (b.still) step(b, performance.now(), 0.016);
    },
    dispose: () => {
      live.delete(b);
    },
  };
}

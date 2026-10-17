import { createContext, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from "react";

import { GAITS, MOUTHS, EYE_L, EYE_R, mountBlob, outline, smoothPath, type BlobHandle } from "./blob.js";

/**
 * An agent's face: a blob with eyes, alive.
 *
 * A standing agent is a thing you come back to, so it should be a thing you
 * recognise. Its colour, its gait and the set of its eyes all come from its
 * name, so the same agent looks the same in the rail, on its page and in a
 * chip, and two agents never look alike by accident. The owner can set any
 * of those by hand, in the agent's file or, for KOS, in Settings; what they
 * leave unset still comes from the name. The face is what it is doing: it
 * glances about while working, bounces with a mark when it needs you,
 * droops on an error and sleeps when its schedule is paused. It also looks
 * at you, blinks, blushes when you are close and jiggles when poked; that
 * lives in blob.ts. The tab icon is the same face drawn still.
 */

export type Mood = "idle" | "working" | "needs-you" | "error" | "asleep";
export type Eyes = "round" | "half" | "sparkle";
export type Gait = 0 | 1 | 2 | 3;

export interface Look {
  /** 0 to 359: the hue the whole blob is built from. */
  hue: number;
  /** Which of the four gaits it has: steady, lively, slow, restless. */
  wobble: Gait;
  eyes: Eyes;
  /** Seconds per breath, from the gait. */
  breath: number;
  /** Degrees the face is cocked, -3 to 3. */
  tilt: number;
  /** The number its whims come from. */
  seed: number;
}

/** What the owner may set about a face; anything unset comes from the name. */
export interface FaceLook {
  hue?: number;
  eyes?: Eyes;
  gait?: Gait;
}

export const EYES: Eyes[] = ["round", "half", "sparkle"];
export const KOS_SEED = "kos";

/** FNV-1a, so a name is the same number on every machine and every render. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function lookOf(seed: string, override: FaceLook = {}): Look {
  const h = hash(seed.trim().toLowerCase() || KOS_SEED);
  const wobble = ((h >>> 9) % 4) as Gait;
  const base: Look = {
    hue: h % 360,
    wobble,
    eyes: EYES[(h >>> 12) % 3]!,
    breath: GAITS[wobble]!.breath,
    tilt: ((h >>> 18) % 7) - 3,
    seed: h,
  };
  const gait = override.gait !== undefined && [0, 1, 2, 3].includes(override.gait) ? override.gait : wobble;
  return {
    ...base,
    ...(override.hue !== undefined && Number.isFinite(override.hue) ? { hue: ((Math.round(override.hue) % 360) + 360) % 360 } : {}),
    ...(override.eyes && EYES.includes(override.eyes) ? { eyes: override.eyes } : {}),
    wobble: gait,
    breath: GAITS[gait]!.breath,
  };
}

/** The settable part of a look, as the editors hold it. */
export function faceLookOf(look: Look): FaceLook {
  return { hue: look.hue, eyes: look.eyes, gait: look.wobble };
}

/** What a thread is doing, as a face; a paused schedule is asleep whatever the thread says. */
export function moodOf(activity: string | undefined, options: { paused?: boolean } = {}): Mood {
  if (options.paused) return "asleep";
  if (activity === "working") return "working";
  if (activity === "needs-you") return "needs-you";
  if (activity === "error") return "error";
  return "idle";
}

/** KOS's own look, for everything that draws KOS: set in Settings, else the name's. */
export const KosLook = createContext<Look>(lookOf(KOS_SEED));
export function useKosLook(): Look {
  return useContext(KosLook);
}

/**
 * What the owner set about each agent's face, by name, so a face drawn from
 * a name alone (a chip, a row in a rail) still wears what the file says.
 */
export const AgentFaces = createContext<ReadonlyMap<string, FaceLook>>(new Map());

/** Whether the person asked the browser for less motion; the face then holds still. */
function usePrefersStill(): boolean {
  const [still, setStill] = useState(() => (typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false));
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = (): void => setStill(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return still;
}

export interface FaceProps {
  /** What the look is derived from: the agent's name. */
  seed: string;
  /** What the owner set by hand, over the name's. */
  look?: FaceLook;
  /** Pixels across. */
  size?: number;
  mood?: Mood;
  /** For a screen reader; the blob is an image of the agent. */
  label?: string;
}

export function Face({ seed, look: override, size = 24, mood = "idle", label }: FaceProps): ReactElement {
  const faces = useContext(AgentFaces);
  const look = lookOf(seed, override ?? faces.get(seed) ?? {});
  const id = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const handle = useRef<BlobHandle | null>(null);
  const still = usePrefersStill();

  // Alive once mounted, for as long as this look lasts; a new look is a new blob.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    handle.current = mountBlob(svg, { seed: look.seed, gait: look.wobble, eyes: look.eyes, tilt: look.tilt }, mood, { still });
    return () => {
      handle.current?.dispose();
      handle.current = null;
    };
    // Mood is pushed through setMood below, so a change of it does not remount.
  }, [look.seed, look.wobble, look.eyes, look.tilt, still]);
  useEffect(() => {
    handle.current?.setMood(mood);
  }, [mood]);

  const ink = `hsl(${look.hue} 45% 15%)`;
  const style = { "--blob-h": String(look.hue), "--blob-size": `${size}px` } as CSSProperties;
  const first = smoothPath(outline(0, look.seed, GAITS[look.wobble]!));
  return (
    <span
      className={`blob blob--${mood}`}
      style={style}
      role="img"
      aria-label={label ?? `${seed}, ${mood === "needs-you" ? "needs you" : mood}`}
      data-mood={mood}
      onPointerEnter={() => handle.current?.hover(true)}
      onPointerLeave={() => handle.current?.hover(false)}
      onPointerDown={() => handle.current?.poke()}
    >
      <svg ref={svgRef} viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <defs>
          <radialGradient id={`${id}g`} cx="36%" cy="30%" r="72%">
            <stop offset="0" stopColor={`hsl(${look.hue} 90% 82%)`} />
            <stop offset="0.5" stopColor={`hsl(${look.hue} 76% 62%)`} />
            <stop offset="1" stopColor={`hsl(${look.hue} 68% 46%)`} />
          </radialGradient>
          {look.eyes === "half" && (
            <clipPath id={`${id}h`}>
              <rect x="-10" y="-10" width="20" height="12.2" />
            </clipPath>
          )}
        </defs>
        <ellipse data-part="shadow" cx="50" cy="90" rx="23" ry="3.6" fill={`hsl(${look.hue} 50% 18%)`} opacity="0.22" />
        <g data-part="all">
          <path data-part="body" d={first} fill={`url(#${id}g)`} />
          <ellipse data-part="shine" cx="38" cy="33" rx="8.5" ry="5" fill="#fff" opacity="0.5" transform="rotate(-22 38 33)" />
          <g transform={`rotate(${look.tilt} 50 54)`}>
            <ellipse data-part="blush-l" cx="35" cy="58" rx="5.5" ry="2.8" fill="#ff8aa3" opacity="0" />
            <ellipse data-part="blush-r" cx="65" cy="58" rx="5.5" ry="2.8" fill="#ff8aa3" opacity="0" />
            <g data-part="eye-l" transform={`translate(${EYE_L.x} ${EYE_L.y})`} clipPath={look.eyes === "half" ? `url(#${id}h)` : undefined}>
              <ellipse rx="4.4" ry="5.2" fill={ink} />
              <circle cx="-1.5" cy="-1.9" r={look.eyes === "sparkle" ? 1.9 : 1.5} fill="#fff" />
              {look.eyes === "sparkle" && <circle cx="1.7" cy="1.7" r="0.9" fill="#fff" />}
            </g>
            <g data-part="eye-r" transform={`translate(${EYE_R.x} ${EYE_R.y})`} clipPath={look.eyes === "half" ? `url(#${id}h)` : undefined}>
              <ellipse rx="4.4" ry="5.2" fill={ink} />
              <circle cx="-1.5" cy="-1.9" r={look.eyes === "sparkle" ? 1.9 : 1.5} fill="#fff" />
              {look.eyes === "sparkle" && <circle cx="1.7" cy="1.7" r="0.9" fill="#fff" />}
            </g>
            <path data-part="mouth" d={MOUTHS.smile} fill="none" stroke={ink} strokeWidth="2.2" strokeLinecap="round" />
          </g>
        </g>
        {mood === "needs-you" && (
          <text data-part="mark" x="80" y="22" fontFamily="sans-serif" fontSize="22" fontWeight="800" fill="#f5a524" stroke="#1a1208" strokeWidth="0.8" paintOrder="stroke">
            !
          </text>
        )}
        {mood === "asleep" && (
          <text data-part="mark" x="74" y="24" fontFamily="sans-serif" fontSize="17" fontWeight="700" fill={ink} opacity="0">
            z
          </text>
        )}
      </svg>
    </span>
  );
}

/** The four gaits as still outlines, for the icon. */
const BODIES = [
  "M33 5c14 0 26 11 25 26S46 59 31 59 5 48 6 31 19 5 33 5z",
  "M30 6c16-2 29 10 29 25 0 13-9 27-26 28S5 50 5 33C5 18 14 8 30 6z",
  "M32 7c13-1 27 7 27 23 0 16-11 29-27 29S4 48 5 31C6 16 19 8 32 7z",
  "M34 5c12 1 24 12 25 25 1 15-12 29-28 29C15 59 5 47 5 32 5 17 19 4 34 5z",
];

/**
 * The face as a still image: the same look and mood the blob wears, for a
 * place that cannot run a script, the tab icon.
 */
export function faceSvg(look: Look, mood: Mood = "idle"): string {
  const h = look.hue;
  const sat = mood === "error" ? 0.45 : mood === "asleep" ? 0.7 : 1;
  const stop = (s: number, l: number): string => `hsl(${h} ${Math.round(s * sat)}% ${l}%)`;
  const ink = `hsl(${h} 45% 15%)`;
  const eye = (cx: number): string => {
    if (mood === "asleep") return `<path d="M${cx - 3.5} 34h7" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`;
    if (mood === "error") {
      const tilt = cx < 32 ? 20 : -20;
      return `<path d="M${cx - 3.5} 34h7" stroke="${ink}" stroke-width="2" stroke-linecap="round" transform="rotate(${tilt} ${cx} 34)"/>`;
    }
    const r = mood === "needs-you" ? 4 : 3.2;
    if (look.eyes === "half") return `<path d="M${cx - r} 34a${r} ${r} 0 0 1 ${r * 2} 0z" fill="${ink}"/>`;
    const dot = `<circle cx="${cx}" cy="34" r="${r}" fill="${ink}"/>`;
    return look.eyes === "sparkle" ? `${dot}<circle cx="${cx - r * 0.3}" cy="${34 - r * 0.35}" r="${r * 0.38}" fill="#fff"/>` : dot;
  };
  const mouth =
    mood === "working" || mood === "needs-you"
      ? `<circle cx="32" cy="43" r="${mood === "needs-you" ? 2.6 : 2.2}" fill="none" stroke="${ink}" stroke-width="2"/>`
      : mood === "error"
        ? `<path d="M27 46q5-4 10 0" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`
        : `<path d="M${mood === "asleep" ? 29 : 27} 42q${mood === "asleep" ? 3 : 5} 4 ${mood === "asleep" ? 6 : 10} 0" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
  const extra =
    mood === "needs-you"
      ? `<text x="52" y="16" font-family="sans-serif" font-size="16" font-weight="800" fill="#f5a524">!</text>`
      : mood === "asleep"
        ? `<text x="49" y="14" font-family="sans-serif" font-size="13" font-weight="700" fill="${ink}">z</text>`
        : "";
  const body = BODIES[look.wobble] ?? BODIES[0]!;
  const droop = mood === "error" ? ` transform="translate(0 3) scale(1 0.92)" transform-origin="32 46"` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">`,
    `<defs><radialGradient id="g" cx="34%" cy="28%" r="72%"><stop offset="0" stop-color="${stop(88, 80)}"/><stop offset="0.55" stop-color="${stop(74, 60)}"/><stop offset="1" stop-color="${stop(66, 47)}"/></radialGradient></defs>`,
    `<path d="${body}" fill="url(#g)"${droop}/>`,
    `<ellipse cx="24" cy="20" rx="7" ry="4.5" fill="#fff" opacity="0.55" transform="rotate(-22 24 20)"/>`,
    `<g transform="rotate(${look.tilt} 32 40)">${eye(25)}${eye(39)}${mouth}</g>`,
    extra,
    `</svg>`,
  ].join("");
}

export function faceDataUrl(look: Look, mood: Mood = "idle"): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(faceSvg(look, mood))}`;
}

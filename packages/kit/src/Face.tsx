import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

import { EYE_DOT_R, EYE_GLINT, EYE_PILL, FILL_SAT, KOS_SEED, desaturateHex, eyeAt, lightnessOf, lookOf as specOf, outline, smoothPath, type BlobShape, type BlobWhim, type FaceDrawing, type FaceLook } from "@kos/shared";
import { GAITS, mountBlob, type BlobHandle } from "@kos/shared/blobmotion";

export { FILL_SAT, KOS_SEED, lightnessOf };

/**
 * An agent's face: a flat blob with two eyes, alive.
 *
 * A blob is a thing you come back to, so it should be a thing you
 * recognise. Its colour, its outline, its gait and the set of its eyes all
 * come from its name, so the same agent looks the same in the rail, on its
 * page and in a chip, and two agents never look alike by accident. The
 * owner can set any of those by hand, in the agent's file or, for KOS, in
 * Settings; what they leave unset still comes from the name.
 *
 * The drawing is as plain as it can be: one matte shape, two eyes, no mouth,
 * no shine. Everything else is motion, in blob.ts: it looks at you, blinks,
 * leans in when you are close, jiggles when poked, and its eyes say the
 * mood (wide when it needs you, shut when asleep, slanted on an error,
 * arcs when pleased). The tab icon is the same face drawn still.
 *
 * A device draws a KOS as that KOS sent its face (a FaceDrawing: colours,
 * eyes, gait, outline); the habits and the tilt still come from the name.
 */

export type Mood = "idle" | "working" | "needs-you" | "error" | "asleep";
export type Eyes = "round" | "half" | "sparkle";
export type Gait = 0 | 1 | 2 | 3;

export interface Look {
  /** 0 to 359: the hue the whole blob is built from, and that its accents take. */
  hue: number;
  /** The body's colour: the hue's own matte fill, or any colour the owner picked. */
  fill: string;
  /** The eyes' colour: dark on a light body, light on a dark one. */
  ink: string;
  /** The picked colour, when the body is one rather than the hue's fill. */
  colour?: string;
  /** Which of the four gaits it has: steady, lively, slow, restless. */
  wobble: Gait;
  /** round dots; half, pills resting a little lowered; sparkle, pills with a glint. */
  eyes: Eyes;
  /** Seconds per breath, from the gait. */
  breath: number;
  /** Degrees the face is cocked, -3 to 3. */
  tilt: number;
  /** The number its whims come from. */
  seed: number;
  /** Its silhouette: round or tall, standing or squat, eyes close or wide, lumpy its own way. */
  shape: BlobShape;
  /** The word the silhouette grew from, when the owner gave one. */
  shapeWord?: string;
  /** Its habits: how it takes to the cursor, how often it blinks. */
  whim: BlobWhim;
}

export type { FaceLook };

export const EYES: Eyes[] = ["round", "half", "sparkle"];

/** The body's colour, matte but bright: the saturation and lightness curve are the harness's too. */
export function fillOf(hue: number, sat = 1): string {
  return `hsl(${hue} ${Math.round(FILL_SAT * sat)}% ${lightnessOf(hue)}%)`;
}
/** The body as drawn still: a picked colour loses saturation the same way a hue would. */
function fillFor(look: Look, sat: number): string {
  return look.colour ? (sat < 1 ? desaturateHex(look.colour, sat) : look.colour) : fillOf(look.hue, sat);
}

/**
 * The face a name gets, decided in the shared package so the harness draws
 * the same one; here it gains what only the animation needs.
 */
export function lookOf(seed: string, override: FaceLook = {}): Look {
  const spec = specOf(seed, override);
  return {
    hue: spec.hue,
    fill: spec.fill,
    ink: spec.ink,
    ...(spec.colour ? { colour: spec.colour } : {}),
    wobble: spec.gait,
    eyes: spec.eyes,
    breath: GAITS[spec.gait]!.breath,
    tilt: spec.tilt,
    seed: spec.seed,
    shape: spec.shape,
    ...(spec.shapeWord ? { shapeWord: spec.shapeWord } : {}),
    whim: spec.whim,
  };
}

/** The settable part of a look, as the editors hold it. */
export function faceLookOf(look: Look): FaceLook {
  return { hue: look.hue, ...(look.colour ? { colour: look.colour } : {}), eyes: look.eyes, gait: look.wobble, ...(look.shapeWord ? { shape: look.shapeWord } : {}) };
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

/** A look worn as a KOS sent it: its drawing over what its name gives. */
export function wearing(look: Look, drawing: FaceDrawing): Look {
  return { ...look, fill: drawing.fill, ink: drawing.ink, eyes: drawing.eyes, wobble: drawing.gait, shape: drawing.shape };
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
  /** The face as a KOS sent it, over both: what a device draws. */
  drawing?: FaceDrawing | undefined;
  /** Pixels across. */
  size?: number;
  mood?: Mood;
  /** For a screen reader; the blob is an image of the agent. */
  label?: string;
}

export function Face({ seed, look: override, drawing, size = 24, mood = "idle", label }: FaceProps): ReactElement {
  const faces = useContext(AgentFaces);
  const named = lookOf(seed, override ?? faces.get(seed) ?? {});
  const look = drawing ? wearing(named, drawing) : named;
  // A drawing sent again is the same face: read by what it says, so a new copy of it is not a new blob.
  const drawn = drawing ? JSON.stringify(drawing) : "";
  const svgRef = useRef<SVGSVGElement>(null);
  const handle = useRef<BlobHandle | null>(null);
  const still = usePrefersStill();

  // Alive once mounted, for as long as this look lasts; a new look is a new blob.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    handle.current = mountBlob(svg, { seed: look.seed, gait: look.wobble, eyes: look.eyes, tilt: look.tilt, shape: look.shape, whim: look.whim }, mood, { still });
    return () => {
      handle.current?.dispose();
      handle.current = null;
    };
    // Mood is pushed through setMood below, so a change of it does not remount.
    // The habits follow the seed, and the shape the seed or the word given it.
  }, [look.seed, look.shapeWord, look.wobble, look.eyes, look.tilt, drawn, still]);
  useEffect(() => {
    handle.current?.setMood(mood);
  }, [mood]);

  const ink = look.ink;
  const style = { "--blob-h": String(look.hue), "--blob-size": `${size}px` } as CSSProperties;
  const first = smoothPath(outline(look.shape));
  const eyes = [
    ["eye-l", eyeAt("l", look.shape)],
    ["eye-r", eyeAt("r", look.shape)],
  ] as const;
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
        <g data-part="all">
          <path data-part="body" d={first} fill={look.fill} />
          <g transform={`rotate(${look.tilt} 50 54)`}>
            {eyes.map(([name, at]) => (
              <g key={name} data-part={name} transform={`translate(${at.x} ${at.y})`}>
                {look.eyes === "round" ? (
                  <circle data-part="eye" r={EYE_DOT_R} fill={ink} />
                ) : (
                  <rect data-part="eye" x={-EYE_PILL.w / 2} y={-EYE_PILL.h / 2} width={EYE_PILL.w} height={EYE_PILL.h} rx={EYE_PILL.r} fill={ink} />
                )}
                {look.eyes === "sparkle" && <circle data-part="eye" cx={EYE_GLINT.x} cy={EYE_GLINT.y} r={EYE_GLINT.r} fill="#fff" />}
                <path data-part="grin" d="M-3.8 1.4q3.8-4.8 7.6 0" fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" opacity="0" />
              </g>
            ))}
          </g>
        </g>
        {mood === "needs-you" && (
          <text data-part="mark" x="80" y="22" fontFamily="sans-serif" fontSize="20" fontWeight="800" fill="#f5a524">
            !
          </text>
        )}
        {mood === "asleep" && (
          <text data-part="mark" x="74" y="24" fontFamily="sans-serif" fontSize="16" fontWeight="700" fill={ink} opacity="0">
            z
          </text>
        )}
      </svg>
    </span>
  );
}

/**
 * The face as a still image: the same silhouette, look and mood the blob
 * wears, held at one moment, for a place that cannot run a script: the tab
 * icon.
 */
export function faceSvg(look: Look, mood: Mood = "idle"): string {
  const sat = mood === "error" ? 0.45 : mood === "asleep" ? 0.7 : 1;
  const ink = look.ink;
  const eye = (side: "l" | "r"): string => {
    const { x: cx, y: cy } = eyeAt(side, look.shape);
    if (mood === "asleep") return `<path d="M${cx - 4} ${cy}h8" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
    if (mood === "error") {
      const tilt = side === "l" ? 18 : -18;
      return `<path d="M${cx - 4} ${cy}h8" stroke="${ink}" stroke-width="2.4" stroke-linecap="round" transform="rotate(${tilt} ${cx} ${cy})"/>`;
    }
    const tall = mood === "needs-you" ? 1.25 : 1;
    if (look.eyes === "round") return `<circle cx="${cx}" cy="${cy}" r="${4.2 * tall}" fill="${ink}"/>`;
    const w = 5.6;
    const hh = 10 * tall;
    const pill = `<rect x="${cx - w / 2}" y="${cy - hh / 2}" width="${w}" height="${hh}" rx="${w / 2}" fill="${ink}"/>`;
    return look.eyes === "sparkle" ? `${pill}<circle cx="${cx - 1}" cy="${cy - hh / 4}" r="1.1" fill="#fff"/>` : pill;
  };
  const extra =
    mood === "needs-you"
      ? `<text x="78" y="24" font-family="sans-serif" font-size="24" font-weight="800" fill="#f5a524">!</text>`
      : mood === "asleep"
        ? `<text x="74" y="22" font-family="sans-serif" font-size="19" font-weight="700" fill="${ink}">z</text>`
        : "";
  const body = smoothPath(outline(look.shape));
  const droop = mood === "error" ? ` transform="translate(0 4) scale(1 0.92)" transform-origin="50 60"` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 92 92" width="64" height="64">`,
    `<path d="${body}" fill="${fillFor(look, sat)}"${droop}/>`,
    `<g transform="rotate(${look.tilt} 50 54)">${eye("l")}${eye("r")}</g>`,
    extra,
    `</svg>`,
  ].join("");
}

export function faceDataUrl(look: Look, mood: Mood = "idle"): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(faceSvg(look, mood))}`;
}

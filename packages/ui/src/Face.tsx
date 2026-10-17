import type { CSSProperties, ReactElement } from "react";

/**
 * An agent's face: a blob with eyes.
 *
 * A standing agent is a thing you come back to, so it should be a thing you
 * recognise. Its colour, its shape, how it wobbles and the set of its eyes
 * all come from its name, so the same agent looks the same in the rail, on
 * its page and in a chip, and two agents never look alike by accident. The
 * face is what it is doing: it glances about while working, bounces with a
 * mark when it needs you, droops on an error and sleeps when its schedule
 * is paused. All of it is CSS; nothing here runs per frame.
 */

export type Mood = "idle" | "working" | "needs-you" | "error" | "asleep";

export interface Look {
  /** 0 to 359: the hue the whole blob is built from. */
  hue: number;
  /** Which of the four morph gaits it has. */
  wobble: 0 | 1 | 2 | 3;
  eyes: "round" | "half" | "sparkle";
  /** Seconds per breath; a slow one reads as calm, a quick one as keen. */
  breath: number;
  /** Degrees the face is cocked, -3 to 3. */
  tilt: number;
}

/** FNV-1a, so a name is the same number on every machine and every render. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function lookOf(seed: string): Look {
  const h = hash(seed.trim().toLowerCase() || "kos");
  const eyes: Look["eyes"][] = ["round", "half", "sparkle"];
  return {
    hue: h % 360,
    wobble: ((h >>> 9) % 4) as Look["wobble"],
    eyes: eyes[(h >>> 12) % 3]!,
    breath: 5 + ((h >>> 15) % 5),
    tilt: ((h >>> 18) % 7) - 3,
  };
}

/** What a thread is doing, as a face; a paused schedule is asleep whatever the thread says. */
export function moodOf(activity: string | undefined, options: { paused?: boolean } = {}): Mood {
  if (options.paused) return "asleep";
  if (activity === "working") return "working";
  if (activity === "needs-you") return "needs-you";
  if (activity === "error") return "error";
  return "idle";
}

export interface FaceProps {
  /** What the look is derived from: the agent's name. */
  seed: string;
  /** Pixels across. */
  size?: number;
  mood?: Mood;
  /** For a screen reader; the blob is an image of the agent. */
  label?: string;
}

export function Face({ seed, size = 24, mood = "idle", label }: FaceProps): ReactElement {
  const look = lookOf(seed);
  const style = {
    "--blob-h": String(look.hue),
    "--blob-size": `${size}px`,
    "--blob-dur": `${look.breath}s`,
    "--blob-tilt": `${look.tilt}deg`,
  } as CSSProperties;
  return (
    <span
      className={`blob blob--${mood} blob--w${look.wobble} blob--${look.eyes}`}
      style={style}
      role="img"
      aria-label={label ?? `${seed}, ${mood === "needs-you" ? "needs you" : mood}`}
      data-mood={mood}
    >
      <span className="blob-body" />
      <span className="blob-shine" />
      <span className="blob-face">
        <span className="blob-eyes">
          <span className="blob-eye blob-eye--l" />
          <span className="blob-eye blob-eye--r" />
        </span>
        <span className="blob-mouth" />
      </span>
      {mood === "needs-you" && <span className="blob-mark" aria-hidden="true">!</span>}
      {mood === "asleep" && <span className="blob-zzz" aria-hidden="true">z</span>}
    </span>
  );
}

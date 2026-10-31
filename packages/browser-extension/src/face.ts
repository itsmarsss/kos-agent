import { EYE_DOT_R, EYE_GLINT, EYE_PILL, KOS_SEED, eyeAt, lookOf, outline, smoothPath } from "@kos/shared";
import { mountBlob, type BlobHandle, type BlobMood } from "@kos/shared/blobmotion";

/**
 * KOS's face, alive, as the dashboard draws it: the same parts in the same
 * SVG, moved by the same code, so the popup and the consent window show the
 * KOS the owner knows from the dashboard and from the Mac. It breathes, its
 * eyes follow the pointer and blink, it squashes under the pointer and
 * wobbles when poked; asked for less motion, it holds still.
 */
export interface KosFace {
  el: HTMLSpanElement;
  setMood(mood: BlobMood): void;
  /** Stops moving it, for a face leaving the page. */
  dispose(): void;
}

export function kosFace(size: number, mood: BlobMood): KosFace {
  const look = lookOf(KOS_SEED);
  const eye = (side: "l" | "r"): string => {
    const at = eyeAt(side, look.shape);
    const shape =
      look.eyes === "round"
        ? `<circle data-part="eye" r="${EYE_DOT_R}" fill="${look.ink}"/>`
        : `<rect data-part="eye" x="${-EYE_PILL.w / 2}" y="${-EYE_PILL.h / 2}" width="${EYE_PILL.w}" height="${EYE_PILL.h}" rx="${EYE_PILL.r}" fill="${look.ink}"/>`;
    const glint = look.eyes === "sparkle" ? `<circle data-part="eye" cx="${EYE_GLINT.x}" cy="${EYE_GLINT.y}" r="${EYE_GLINT.r}" fill="#fff"/>` : "";
    const grin = `<path data-part="grin" d="M-3.8 1.4q3.8-4.8 7.6 0" fill="none" stroke="${look.ink}" stroke-width="2.4" stroke-linecap="round" opacity="0"/>`;
    return `<g data-part="eye-${side}" transform="translate(${at.x} ${at.y})">${shape}${glint}${grin}</g>`;
  };
  // The mark the dashboard draws over a face that needs the owner: the consent window's.
  const mark = mood === "needs-you" ? `<text data-part="mark" x="80" y="22" font-family="sans-serif" font-size="20" font-weight="800" fill="#f5a524">!</text>` : "";
  const el = document.createElement("span");
  el.className = "blob";
  el.style.setProperty("--blob-size", `${size}px`);
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "KOS");
  el.innerHTML =
    `<svg viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true"><g data-part="all">` +
    `<path data-part="body" d="${smoothPath(outline(look.shape))}" fill="${look.fill}"/>` +
    `<g transform="rotate(${look.tilt} 50 54)">${eye("l")}${eye("r")}</g></g>${mark}</svg>`;
  const svg = el.querySelector("svg")!;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const handle: BlobHandle = mountBlob(svg, { seed: look.seed, gait: look.gait, eyes: look.eyes, tilt: look.tilt, shape: look.shape, whim: look.whim }, mood, { still });
  el.addEventListener("pointerenter", () => handle.hover(true));
  el.addEventListener("pointerleave", () => handle.hover(false));
  el.addEventListener("pointerdown", () => handle.poke());
  return { el, setMood: (m) => handle.setMood(m), dispose: () => handle.dispose() };
}

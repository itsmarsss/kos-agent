/** A colour as red, green and blue (0 to 255) and alpha (0 to 1). */
export type Rgba = [number, number, number, number];

/**
 * Any CSS colour a browser computes (rgb, hsl, oklch, color-mix, color(),
 * a named colour) as sRGB bytes: painted on a pixel of a canvas and read
 * back, so no syntax has to be parsed here. Undefined where there is no
 * canvas or the value is not a colour.
 *
 * Self-contained, so a frame can be given it as source: the bridge
 * (artifactdoc.ts) and the check's probe (artifactprobe.ts) each serialise
 * it. Its canvas and what it has read are kept on the window between calls.
 */
export function colourOf(css: string): Rgba | undefined {
  const w = globalThis as unknown as { __kosColour?: { cx: CanvasRenderingContext2D | null; seen: Map<string, Rgba | undefined> } };
  if (!w.__kosColour) {
    const canvas = typeof document === "undefined" ? undefined : document.createElement("canvas");
    if (canvas) canvas.width = canvas.height = 1;
    w.__kosColour = { cx: canvas?.getContext("2d", { willReadFrequently: true }) ?? null, seen: new Map() };
  }
  const { cx, seen } = w.__kosColour;
  if (seen.has(css)) return seen.get(css);
  let out: Rgba | undefined;
  if (cx && css) {
    // Two sentinels: a value the canvas refuses leaves either one in place.
    cx.fillStyle = "#010203";
    cx.fillStyle = css;
    const first = cx.fillStyle;
    cx.fillStyle = "#040506";
    cx.fillStyle = css;
    if (first === cx.fillStyle) {
      cx.clearRect(0, 0, 1, 1);
      cx.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = cx.getImageData(0, 0, 1, 1).data;
      out = [r, g, b, Math.round((a / 255) * 1000) / 1000];
    }
  }
  seen.set(css, out);
  return out;
}

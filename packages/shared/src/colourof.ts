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

/**
 * Whether a page's ground is KOS's: its --bg, or near enough that the page
 * meant it (an agent's "paper" a few steps off). The kit's own surfaces
 * (--panel, --panel-2, given as `kit`) are a ground of the page's own, to
 * within 2 a channel, however close they sit to --bg. Otherwise the cut is a
 * CIE76 distance in Lab under 3.75: a tunable chosen against KOS's
 * palettes and the artifacts written so far, not a perceptual law.
 * Self-contained, with no inner functions, so a frame can be given its
 * source beside colourOf.
 */
export function sameGround(c: Rgba, bg: Rgba, kit: Rgba[] = []): boolean {
  if (kit.some((k) => Math.abs(k[0] - c[0]) <= 2 && Math.abs(k[1] - c[1]) <= 2 && Math.abs(k[2] - c[2]) <= 2)) return false;
  const lab: number[][] = [];
  for (const x of [c, bg]) {
    const v = [x[0], x[1], x[2]].map((n) => (n / 255 <= 0.04045 ? n / 255 / 12.92 : ((n / 255 + 0.055) / 1.055) ** 2.4));
    const xyz = [(v[0]! * 0.4124 + v[1]! * 0.3576 + v[2]! * 0.1805) / 0.95047, v[0]! * 0.2126 + v[1]! * 0.7152 + v[2]! * 0.0722, (v[0]! * 0.0193 + v[1]! * 0.1192 + v[2]! * 0.9505) / 1.08883].map((t) =>
      t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116,
    );
    lab.push([116 * xyz[1]! - 16, 500 * (xyz[0]! - xyz[1]!), 200 * (xyz[1]! - xyz[2]!)]);
  }
  return Math.hypot(lab[0]![0]! - lab[1]![0]!, lab[0]![1]! - lab[1]![1]!, lab[0]![2]! - lab[1]![2]!) < 3.75;
}

/**
 * The toolbar icon in a KOS's own face: its outline filled with its colour,
 * and two eyes larger than the face's own so a 16 px icon still has them,
 * as the packaged icons draw them. Takes the outline already worked out,
 * so it needs nothing but a canvas: the worker draws with it, and a page can too.
 */

export interface IconFace {
  fill: string;
  ink: string;
  /** The outline as an SVG path in the face's 100-unit box. */
  body: string;
  /** Where the eyes sit, in the same box. */
  eyes: readonly { x: number; y: number }[];
}

/** The part of the 100-unit box a face fills, as the dashboard's tab icon frames it. */
const FRAME = { x: 4, y: 4, size: 92 } as const;
const EYE = { rx: 5.5, ry: 10 } as const;

export function iconPixels(face: IconFace, size: number): ImageData {
  const ctx = new OffscreenCanvas(size, size).getContext("2d")!;
  ctx.scale(size / FRAME.size, size / FRAME.size);
  ctx.translate(-FRAME.x, -FRAME.y);
  ctx.fillStyle = face.fill;
  ctx.fill(new Path2D(face.body));
  ctx.fillStyle = face.ink;
  for (const eye of face.eyes) {
    ctx.beginPath();
    ctx.ellipse(eye.x, eye.y, EYE.rx, EYE.ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return ctx.getImageData(0, 0, size, size);
}

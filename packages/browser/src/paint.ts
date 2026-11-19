import jpeg from "jpeg-js";
import { PNG } from "pngjs";

/**
 * A picture of KOS's own browser painted over where it may show a secret
 * (boxes.ts), in the host: the page never sees it done. Taken as a PNG, so
 * the boxes are painted on the pixels drawn, then sent as a JPEG as every
 * picture is.
 */

/** The most pixels a picture is painted on: a page's picture is a few, and decoding one far larger holds the host's memory. */
const MAX_PIXELS = 40_000_000;

/** The PNG `data` (base64) with each box `boxesIn` gives for its size (x, y, width, height, in its pixels) painted black, as a JPEG at `quality`. */
export function paintedJpeg(data: string, boxesIn: (image: { width: number; height: number }) => number[], quality: number): string {
  const bytes = Buffer.from(data, "base64");
  // Read from the header first (width and height at bytes 16 and 20), so nothing too large is decoded.
  if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > MAX_PIXELS) throw new Error("the picture is too large to mask, so it is not pictured");
  const png = PNG.sync.read(bytes);
  const { width, height } = png;
  const boxes = boxesIn({ width, height });
  const px = png.data;
  for (let i = 0; i + 3 < boxes.length; i += 4) {
    const x0 = Math.max(0, Math.floor(boxes[i]!));
    const y0 = Math.max(0, Math.floor(boxes[i + 1]!));
    const x1 = Math.min(width, Math.ceil(boxes[i]! + boxes[i + 2]!));
    const y1 = Math.min(height, Math.ceil(boxes[i + 1]! + boxes[i + 3]!));
    for (let y = y0; y < y1; y++) px.fill(0, (y * width + x0) * 4, (y * width + x1) * 4);
  }
  // Alpha back to opaque: a JPEG has none, and the fill cleared it.
  for (let a = 3; a < px.length; a += 4) px[a] = 255;
  return Buffer.from(jpeg.encode({ data: px, width, height }, quality).data).toString("base64");
}

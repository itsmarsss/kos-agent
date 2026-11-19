import { partOf, tabMap, webOrigin, type Reach, type Send } from "./frames.js";
import { secretBoxes, viewportNow } from "./inpage.js";

/**
 * Where a picture of a page may show a secret, found without changing the
 * page, and the picture painted over there.
 *
 * Masking a page by restyling it (a style element, an attribute, a CSS
 * highlight) is seen by the page's own script: a page could plant words it
 * guesses at, watch which were masked, and learn a filled value. So nothing
 * in the page changes. In a world of KOS's own in each frame, the boxes that
 * may show a secret are measured (inpage.secretBoxes); a child frame's are
 * placed where its frame is drawn; and the picture is painted over them
 * after it is taken, by whoever holds its pixels (KOS's host for its own
 * browser, the extension in the owner's Chrome). The page is measured on
 * both sides of the picture, and a page that moved meanwhile is measured
 * and pictured again, or not pictured at all.
 */

/** A frame's viewport as inpage.viewportNow reads it, in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
}

/** The boxes to paint over, four numbers each (x, y, width, height) in the main frame's viewport, and that viewport. */
export interface SecretBoxes {
  boxes: number[];
  view: Viewport;
}

/** The objects a measuring makes, let go of together. */
const GROUP = "kos-boxes";

const failed = (): Error => new Error("the page could not be measured to mask");

/** A page-side function's answer by value, run on a node in a world, or in the world itself with no node. */
async function run<T>(send: Send, world: number, fn: (...args: never[]) => unknown, args: unknown[], node?: number): Promise<T> {
  let objectId: string | undefined;
  if (node !== undefined) {
    const resolved = await send("DOM.resolveNode", { backendNodeId: node, executionContextId: world, objectGroup: GROUP });
    objectId = (resolved["object"] as { objectId?: string } | undefined)?.objectId;
    if (!objectId) throw failed();
  }
  const answer = await send("Runtime.callFunctionOn", {
    functionDeclaration: fn.toString(),
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    ...(objectId ? { objectId } : { executionContextId: world }),
  });
  if (answer["exceptionDetails"]) throw failed();
  return (answer["result"] as { value?: T } | undefined)?.value as T;
}

/** Boxes in one frame's viewport, moved into another's. */
type Place = (boxes: number[]) => number[];

/** The upright box a quad covers, as left, top, right and bottom. */
function bounds(quad: readonly number[]): [number, number, number, number] {
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Boxes in a frame's viewport, placed where its element's content box is
 * drawn in the viewport of the top frame of the session the element is in,
 * and cut to it; none when it is not drawn. `view` is the frame's viewport,
 * none to paint the whole box over (a frame not measured). A frame turned,
 * skewed or mirrored is not placed box by box: all of it is painted over.
 */
async function placeIn(send: Send, owner: number, view: Viewport | undefined): Promise<Place> {
  const model = await send("DOM.getBoxModel", { backendNodeId: owner }).catch(() => undefined);
  const quad = (model?.["model"] as { content?: number[] } | undefined)?.content;
  if (!quad || quad.length < 8) return () => [];
  const [left, top, right, bottom] = bounds(quad);
  const whole = (): number[] => (right > left && bottom > top ? [left, top, right - left, bottom - top] : []);
  if (!view || !upright(quad)) return whole;
  const sx = (right - left) / Math.max(1, view.width);
  const sy = (bottom - top) / Math.max(1, view.height);
  return (boxes) => {
    const out: number[] = [];
    for (let i = 0; i + 3 < boxes.length; i += 4) {
      const x = Math.max(left, left + boxes[i]! * sx);
      const y = Math.max(top, top + boxes[i + 1]! * sy);
      const r = Math.min(right, left + (boxes[i]! + boxes[i + 2]!) * sx);
      const b = Math.min(bottom, top + (boxes[i + 1]! + boxes[i + 3]!) * sy);
      if (r > x && b > y) out.push(x, y, r - x, b - y);
    }
    return out;
  };
}

/** Whether a quad (clockwise from its first corner) is an upright rectangle drawn the right way round, to half a pixel. */
export function upright(q: readonly number[]): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.5;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q as [number, number, number, number, number, number, number, number];
  return near(y0, y1) && near(x1, x2) && near(y2, y3) && near(x3, x0) && x1 > x0 && y3 > y0;
}

/** A world of the measurer's own in a frame, made through the session that holds it (its part, `via`, and that part's `send`); undefined where none is made. */
export type WorldOf = (frame: string, via: string, send: Send) => Promise<number | undefined>;

/**
 * The boxes a picture of the tab must be painted over, or undefined when it
 * need not be: on a tab `held` to a secret, every text box of every frame
 * reachable; in a frame `patternsFor` its origin gives patterns (a blank
 * one by the nearest web origin above it), its text boxes and each echo of
 * them. A frame in another process is measured through its own session, its
 * boxes placed through each frame element between it and the page. A child
 * frame where a box is moving, or drawn turned or mirrored, or one no
 * session or world reaches, is painted over whole wherever anything is to
 * be painted; the main frame must be measured and still, or this throws.
 */
export async function boxesOf(reach: Reach, worldOf: WorldOf, held: boolean, patternsFor: (origin: string) => string[]): Promise<SecretBoxes | undefined> {
  const touched = new Set<Send>([reach.send]);
  try {
    const map = await tabMap(reach);
    const { main, frames, parts } = map;
    const patterns = new Map<string, string[]>();
    for (const frame of frames.keys()) patterns.set(frame, patternsFor(webOrigin(map, frame)));
    const needed = held || [...patterns.values()].some((p) => p.length > 0);
    if (!needed) return undefined;
    const views = new Map<string, Viewport>();
    const worldIn = async (frame: string): Promise<{ send: Send; world: number } | undefined> => {
      const part = partOf(map, frame);
      if (!part) return undefined;
      touched.add(part.send);
      const world = await worldOf(frame, frames.get(frame)?.via ?? "", part.send);
      return world === undefined ? undefined : { send: part.send, world };
    };
    const viewOf = async (frame: string): Promise<Viewport | undefined> => {
      if (!views.has(frame)) {
        const at = await worldIn(frame);
        if (at) views.set(frame, await run<Viewport>(at.send, at.world, viewportNow, []));
      }
      return views.get(frame);
    };
    // Each frame's boxes into the main frame's viewport: through its element in its parent's part, then through the frame that part is.
    const places = new Map<string, Promise<Place>>();
    const toMain = (frame: string, measured = true): Promise<Place> => {
      const key = `${frame}:${measured}`;
      let got = places.get(key);
      if (!got) {
        got = (async (): Promise<Place> => {
          if (frame === main) return (b) => b;
          const unreached = map.unreached.get(frame);
          const outer = unreached ? unreached.via : frames.get(frames.get(frame)?.parent ?? "")?.via;
          const holder = outer === undefined ? undefined : parts.get(outer);
          if (outer === undefined || !holder) throw failed();
          const owner = unreached?.owner ?? (await holder.send("DOM.getFrameOwner", { frameId: frame }))["backendNodeId"];
          if (typeof owner !== "number") throw failed();
          const local = await placeIn(holder.send, owner, measured ? await viewOf(frame) : undefined);
          // The part's boxes are in the viewport of the frame it is; the tab's are the main frame's.
          const up = outer === "" ? (b: number[]): number[] => b : await toMain(outer);
          return (b) => up(local(b));
        })();
        places.set(key, got);
      }
      return got;
    };
    const boxes: number[] = [];
    const everything = [0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
    for (const part of parts.values()) {
      for (const [frame, frameRoots] of part.roots) {
        const own = patterns.get(frame) ?? [];
        if (!held && own.length === 0) continue;
        const at = await worldIn(frame);
        if (!at) {
          if (frame === main) throw failed();
          boxes.push(...(await toMain(frame, false))(everything));
          continue;
        }
        const found = await Promise.all(frameRoots.map((root) => run<{ boxes: number[]; moving: boolean }>(at.send, at.world, secretBoxes, [own], root)));
        // A box moving may be drawn somewhere other than where it was measured: the main frame is not pictured, a child frame is painted over whole.
        if (found.some((f) => f.moving)) {
          if (frame === main) throw new Error("the page is moving where it may show a secret, so it is not pictured");
          boxes.push(...(await toMain(frame, false))(everything));
          continue;
        }
        const place = await toMain(frame);
        for (const f of found) boxes.push(...place(f.boxes));
      }
    }
    // A frame in a process no session reaches is not looked into: what it shows is painted over whole.
    for (const frame of map.unreached.keys()) boxes.push(...(await toMain(frame, false))(everything));
    const view = await viewOf(main);
    if (!view) throw failed();
    return { boxes, view };
  } finally {
    await Promise.all([...touched].map((send) => send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined)));
  }
}

/** Whether two measurings found the same boxes, to a pixel. */
export function sameBoxes(a: SecretBoxes, b: SecretBoxes): boolean {
  if (a.boxes.length !== b.boxes.length) return false;
  const views = [a.view, b.view] as const;
  if (views[0].x !== views[1].x || views[0].y !== views[1].y || views[0].scale !== views[1].scale || views[0].width !== views[1].width || views[0].height !== views[1].height) return false;
  return a.boxes.every((v, i) => Math.abs(v - b.boxes[i]!) <= 1);
}

/** Pictures taken again, at most, of a page that moves between its measurings. */
const TRIES = 3;

/**
 * A picture taken by `shoot` between two measurings of the page that agree,
 * the first of them `first` when it was just made, with the boxes to paint
 * over; no boxes when nothing need be. A page that keeps moving is not
 * pictured.
 */
export async function steadyShot<S>(measure: () => Promise<SecretBoxes | undefined>, shoot: () => Promise<S>, first?: SecretBoxes): Promise<{ shot: S; boxes?: SecretBoxes }> {
  let before = first ?? (await measure());
  for (let i = 0; i < TRIES; i++) {
    const shot = await shoot();
    if (!before) return { shot };
    const after = await measure();
    if (after && sameBoxes(before, after)) return { shot, boxes: after };
    before = after;
  }
  throw new Error("the page kept moving while it was pictured, so it is not pictured");
}

/** Room left around each box, in CSS pixels: a caret, a focus ring, an edge rounded off. */
const PAD = 3;

/**
 * The boxes in a picture's pixels, whole pixels and cut to it. `cover` is
 * the CSS size the picture shows from the drawn part's corner: by default
 * the visual viewport (a picture of the tab as it is drawn); a picture
 * clipped to a size of its own says so.
 */
export function pixelBoxes(s: SecretBoxes, image: { width: number; height: number }, cover?: { width: number; height: number }): number[] {
  const css = cover ?? { width: s.view.width / s.view.scale, height: s.view.height / s.view.scale };
  const kx = image.width / Math.max(1, css.width);
  const ky = image.height / Math.max(1, css.height);
  const out: number[] = [];
  for (let i = 0; i + 3 < s.boxes.length; i += 4) {
    const x = Math.max(0, Math.floor((s.boxes[i]! - s.view.x - PAD) * kx));
    const y = Math.max(0, Math.floor((s.boxes[i + 1]! - s.view.y - PAD) * ky));
    const r = Math.min(image.width, Math.ceil((s.boxes[i]! + s.boxes[i + 2]! - s.view.x + PAD) * kx));
    const b = Math.min(image.height, Math.ceil((s.boxes[i + 1]! + s.boxes[i + 3]! - s.view.y + PAD) * ky));
    if (r > x && b > y) out.push(x, y, r - x, b - y);
  }
  return out;
}

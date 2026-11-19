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

/** A command to the tab's debugger. */
export type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

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

export type Frames = Map<string, { origin: string; parent?: string; loader: string }>;

/** The tab's frames as the browser holds them, with the main frame's id. */
export async function frameTree(send: Send): Promise<{ main: string; frames: Frames }> {
  type Tree = { frame?: { id?: string; securityOrigin?: string; loaderId?: string }; childFrames?: Tree[] };
  const frames: Frames = new Map();
  const walk = (t: Tree | undefined, parent?: string): void => {
    const id = t?.frame?.id;
    if (!id) return;
    frames.set(id, { origin: t.frame?.securityOrigin ?? "", loader: t.frame?.loaderId ?? "", ...(parent ? { parent } : {}) });
    for (const child of t.childFrames ?? []) walk(child, id);
  };
  const tree = (await send("Page.getFrameTree"))["frameTree"] as Tree | undefined;
  walk(tree);
  return { main: tree?.frame?.id ?? "", frames };
}

type DomNode = { backendNodeId?: number; nodeType?: number; frameId?: string; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode };

/** The page's documents and shadow roots, open and closed, by the frame each is in, and each node's frame, from the browser's own tree. */
export async function domTree(send: Send, main: string): Promise<{ frameOf: Map<number, string>; roots: Map<string, number[]> }> {
  const frameOf = new Map<number, string>();
  const roots = new Map<string, number[]>();
  const walk = (n: DomNode | undefined, frame: string): void => {
    if (!n) return;
    if (n.backendNodeId !== undefined) frameOf.set(n.backendNodeId, frame);
    if ((n.nodeType === 9 || n.nodeType === 11) && n.backendNodeId !== undefined) roots.set(frame, [...(roots.get(frame) ?? []), n.backendNodeId]);
    for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(child, frame);
    if (n.contentDocument && n.frameId) walk(n.contentDocument, n.frameId);
  };
  walk((await send("DOM.getDocument", { depth: -1, pierce: true }))["root"] as DomNode | undefined, main);
  return { frameOf, roots };
}

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

/** A child frame's boxes placed in the main frame's viewport, where its element's content box is drawn, and cut to it; none when it is not drawn. */
async function placer(send: Send, world: number, frame: string): Promise<(boxes: number[]) => number[]> {
  const owner = (await send("DOM.getFrameOwner", { frameId: frame }))["backendNodeId"];
  if (typeof owner !== "number") throw failed();
  const model = await send("DOM.getBoxModel", { backendNodeId: owner }).catch(() => undefined);
  const quad = (model?.["model"] as { content?: number[] } | undefined)?.content;
  if (!quad || quad.length < 8) return () => [];
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const [left, top, right, bottom] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  // A frame turned, skewed or mirrored is not placed box by box: all of it is painted over.
  if (!upright(quad)) return () => (right > left && bottom > top ? [left, top, right - left, bottom - top] : []);
  const view = await run<Viewport>(send, world, viewportNow, []);
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

/**
 * The boxes a picture of the tab must be painted over, or undefined when it
 * need not be: on a tab `held` to a secret, every text box of every frame
 * reachable; in a frame `patternsFor` its origin gives patterns (an
 * about:blank one by the page's), its text boxes and each echo of them. A
 * child frame where a box is moving, or drawn turned or mirrored, is
 * painted over whole. A frame of another process, which no world reaches, is
 * passed over; the main frame must be measured and still, or this throws.
 */
export async function boxesOf(send: Send, worldOf: (frame: string) => Promise<number | undefined>, held: boolean, patternsFor: (origin: string) => string[]): Promise<SecretBoxes | undefined> {
  try {
    const { main, frames } = await frameTree(send);
    const top = frames.get(main)?.origin ?? "";
    const { roots } = await domTree(send, main);
    const boxes: number[] = [];
    let needed = false;
    for (const [frame, frameRoots] of roots) {
      const origin = frames.get(frame)?.origin ?? "";
      const patterns = patternsFor(/^https?:/i.test(origin) ? origin : top);
      if (!held && patterns.length === 0) continue;
      needed = true;
      const world = await worldOf(frame);
      if (world === undefined) {
        if (frame === main) throw failed();
        continue;
      }
      const place = frame === main ? (b: number[]): number[] => b : await placer(send, world, frame);
      const found = await Promise.all(frameRoots.map((root) => run<{ boxes: number[]; moving: boolean }>(send, world, secretBoxes, [patterns], root)));
      // A box moving may be drawn somewhere other than where it was measured: the main frame is not pictured, a child frame is painted over whole.
      if (found.some((f) => f.moving)) {
        if (frame === main) throw new Error("the page is moving where it may show a secret, so it is not pictured");
        boxes.push(...place([0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]));
        continue;
      }
      for (const f of found) boxes.push(...place(f.boxes));
    }
    if (!needed) return undefined;
    const world = await worldOf(main);
    if (world === undefined) throw failed();
    return { boxes, view: await run<Viewport>(send, world, viewportNow, []) };
  } finally {
    await send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
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

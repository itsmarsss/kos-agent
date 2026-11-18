import type { PointHow } from "./overlay.js";

/**
 * Where KOS's cursor goes for a command KOS sends a tab. Its hands press,
 * move, scroll and drag with the pointer at a point; they focus a field to
 * type and scroll to an element by the element, whose middle is the point
 * once it is in view; keys and text say KOS is typing where it is.
 */
export type Aim = { at: { x: number; y: number }; how: PointHow } | { node: { backendNodeId: number } } | { typing: true };

const KEY_DOWN = new Set(["keyDown", "rawKeyDown", "char"]);
const BY_NODE = new Set(["DOM.focus", "DOM.scrollIntoViewIfNeeded"]);

export function aimOf(method: string, params: Record<string, unknown>): Aim | undefined {
  const { x, y, type } = params;
  if ((method === "Input.dispatchMouseEvent" || method === "Input.dispatchDragEvent") && typeof x === "number" && typeof y === "number") {
    const at = { x, y };
    if (method === "Input.dispatchDragEvent") return { at, how: "drag" };
    if (type === "mousePressed") return { at, how: "press" };
    // A move with a button held, or the release ending it, is a drag: followed, not glided.
    const held = typeof params["buttons"] === "number" && params["buttons"] > 0;
    if (type === "mouseReleased" || (type === "mouseMoved" && held)) return { at, how: "drag" };
    return { at, how: "move" };
  }
  if (BY_NODE.has(method) && typeof params["backendNodeId"] === "number") return { node: { backendNodeId: params["backendNodeId"] } };
  if (method === "Input.insertText" || (method === "Input.dispatchKeyEvent" && KEY_DOWN.has(String(type)))) return { typing: true };
  return undefined;
}

/** The middle of the first of an element's boxes with any area, as DOM.getContentQuads gives them. */
export function middleOf(quads: unknown): { x: number; y: number } | undefined {
  if (!Array.isArray(quads)) return undefined;
  const quad = quads.find((q): q is number[] => Array.isArray(q) && q.length === 8 && Math.abs((q[4]! - q[0]!) * (q[5]! - q[1]!)) > 1);
  if (!quad) return undefined;
  return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
}

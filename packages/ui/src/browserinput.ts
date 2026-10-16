/**
 * The owner's hand on KOS's browser.
 *
 * The live view draws the page at whatever size the window allows; the
 * browser wants coordinates in its own viewport. These turn what happens
 * on the canvas into the stream's input messages, so a click lands where
 * it was aimed and a keystroke arrives as the key it was.
 */

export interface MouseInput {
  type: "input_mouse";
  eventType: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: string;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

export interface KeyInput {
  type: "input_keyboard";
  eventType: "keyDown" | "keyUp" | "char";
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
}

export type BrowserInputMessage = MouseInput | KeyInput;

/** The stream's modifier bits: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
export function modifierBits(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/**
 * A point on the drawn frame, as a point in the browser's viewport. The
 * frame is drawn to fit the canvas, centred, so there may be letterboxing
 * on one axis; a point in the bars is clamped to the nearest edge.
 */
export function toViewport(
  point: { x: number; y: number },
  canvas: { width: number; height: number },
  frame: { width: number; height: number },
): { x: number; y: number } {
  if (!frame.width || !frame.height || !canvas.width || !canvas.height) return { x: 0, y: 0 };
  const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
  const drawnW = frame.width * scale;
  const drawnH = frame.height * scale;
  const offX = (canvas.width - drawnW) / 2;
  const offY = (canvas.height - drawnH) / 2;
  const x = Math.max(0, Math.min(frame.width, (point.x - offX) / scale));
  const y = Math.max(0, Math.min(frame.height, (point.y - offY) / scale));
  return { x: Math.round(x), y: Math.round(y) };
}

const BUTTONS: Record<number, string> = { 0: "left", 1: "middle", 2: "right" };

export function mouseMessage(
  eventType: "mousePressed" | "mouseReleased" | "mouseMoved",
  at: { x: number; y: number },
  e: { button: number; detail?: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): MouseInput {
  const out: MouseInput = { type: "input_mouse", eventType, ...at, modifiers: modifierBits(e) };
  if (eventType !== "mouseMoved") {
    out.button = BUTTONS[e.button] ?? "left";
    out.clickCount = Math.max(1, e.detail ?? 1);
  }
  return out;
}

export function wheelMessage(at: { x: number; y: number }, e: { deltaX: number; deltaY: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): MouseInput {
  return { type: "input_mouse", eventType: "mouseWheel", ...at, deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY), modifiers: modifierBits(e) };
}

/**
 * A key press, as the messages the browser needs: a keyDown, and for a
 * printable key with no shortcut modifier, the character it types, since the
 * down alone does not put a letter in a field.
 */
export function keyMessages(
  eventType: "keyDown" | "keyUp",
  e: { key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): KeyInput[] {
  const modifiers = modifierBits(e);
  const out: KeyInput[] = [{ type: "input_keyboard", eventType, key: e.key, code: e.code, modifiers }];
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (eventType === "keyDown" && printable) out.push({ type: "input_keyboard", eventType: "char", text: e.key, modifiers });
  return out;
}

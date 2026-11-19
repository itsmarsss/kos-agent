import { boxesOf, domTree, frameTree, pixelBoxes, steadyShot, type Send } from "@kos/browser/boxes";
import { fillable, frameShown, hasKeyboard, holds, isFocused, putValue, selectAll } from "@kos/browser/inpage";
import { copyKey } from "@kos/browser/keys";

import { CallError } from "./protocol.js";

/**
 * A saved secret filled into the owner's Chrome (docs/secrets.md, Protocol).
 *
 * KOS sends one field's value in one call, secret.fill, after its own
 * checks; the extension checks again on its side, by what Chrome itself says
 * of the tab (its frames, their origins, the document), never the page's
 * word: the page is on the origin approved, the field is in the frame
 * approved and is one the secret may go into, nothing hides it, and no
 * service worker runs the page. It puts the value in through the native
 * setter in a world of its own that KOS cannot reach, sees that the field
 * holds it without reading it back, marks the field, and answers that it
 * did, nothing more. The value is held for the call alone.
 *
 * Until the document changes the tab is held to the field: no script step
 * (browser.eval), no copying, cutting, selecting all or pasting, no drag, and no
 * typing or editing in a marked field; every picture of it has every text
 * box painted over, and KOS may send the patterns of the values a page may
 * echo for them to be painted over too (secret.picture), the page itself
 * never changed for it.
 */

/** The world the extension's own checks and fills run in: neither the page's nor KOS's hands', so KOS's commands cannot reach it (relay.ts Worlds). */
export const SECRET_WORLD = "kos-secret";
/** The objects a fill makes, let go of together. */
const GROUP = "kos-secret";

/** Where a secret may go in a form (SecretSlot in packages/browser/src/taint.ts, which a test holds this to). */
export const SLOTS = [
  "password",
  "username",
  "card-number",
  "card-expiry",
  "card-exp-month",
  "card-exp-year",
  "card-cvc",
  "card-name",
  "address-line1",
  "address-line2",
  "address-city",
  "address-region",
  "address-postal",
  "address-country",
  "token",
  "text",
] as const;
export type Slot = (typeof SLOTS)[number];

/** Slots whose value is a secret: their fields are marked and masked. A username, a name or an address is filled and left be. */
const SECRET: ReadonlySet<Slot> = new Set(["password", "card-number", "card-expiry", "card-exp-month", "card-exp-year", "card-cvc", "token", "text"]);
/** Slots held to by their digits, however a page spaces them. */
const DIGITS: ReadonlySet<Slot> = new Set(["card-number", "card-cvc"]);

export const isSecret = (slot: Slot): boolean => SECRET.has(slot);
export const isDigits = (slot: Slot): boolean => DIGITS.has(slot);

/** One field's fill as KOS sends it: the field (by backend node), its frame, the document and the origins approved, the slot, and the value. */
export interface SecretPut {
  node: number;
  frame: string;
  doc: string;
  origin: string;
  frameOrigin: string;
  slot: Slot;
  value: string;
}

/** The longest value a field is given: a note may be long, a password or a card is not. */
const VALUE_MAX = 8_192;
/** A frame's origin as a fill checks it: http or https and a host. */
const CHECKED_ORIGIN = /^https?:\/\/[^/\s]+$/;

/** A page a secret may be filled on: https, or http on this machine, as a secret's sites are (secrets/records.ts checkOrigin). */
export function fillsOn(origin: string): boolean {
  if (!CHECKED_ORIGIN.test(origin)) return false;
  const url = new URL(origin);
  return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** A fill's parameters, read and checked; a refusal names what is wrong, never the value. */
export function readPut(params: Record<string, unknown>): SecretPut {
  const { node, frame, doc, origin, frameOrigin, slot, value } = params;
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
  if (!Number.isInteger(node) || !text(frame) || !text(doc) || !text(origin) || !text(frameOrigin)) throw new CallError("bad_request", "a fill names its field, frame, document and origins");
  if (!(SLOTS as readonly unknown[]).includes(slot)) throw new CallError("bad_request", "a fill names the kind of field it goes into");
  if (typeof value !== "string" || value.length === 0 || value.length > VALUE_MAX) throw new CallError("bad_request", "a fill carries a value of 1 to 8192 characters");
  return { node: node as number, frame, doc, origin, frameOrigin, slot: slot as Slot, value };
}

/** Patterns at most, per origin and in all, and the longest one: a value's pattern is a few dozen characters a character. */
const MASK_PATTERNS = 500;
const MASK_PATTERN_CHARS = 200_000;

/** The patterns a picture is masked by, per origin (secret.picture), read and checked. */
export function readMasks(v: unknown): Record<string, string[]> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new CallError("bad_request", "masks are patterns by origin");
  const out: Record<string, string[]> = {};
  let count = 0;
  for (const [origin, patterns] of Object.entries(v)) {
    if (!CHECKED_ORIGIN.test(origin) || !Array.isArray(patterns)) throw new CallError("bad_request", "masks are patterns by origin");
    if (!patterns.every((p) => typeof p === "string" && p.length > 0 && p.length <= MASK_PATTERN_CHARS)) throw new CallError("bad_request", "a mask is a pattern");
    count += patterns.length;
    out[origin] = patterns as string[];
  }
  if (count > MASK_PATTERNS) throw new CallError("bad_request", `masks hold at most ${MASK_PATTERNS} patterns`);
  return out;
}

/** A field a secret is in: its frame and its backend node. */
export interface Marked {
  frame: string;
  node: number;
}

/**
 * A tab a secret was filled into, as the extension keeps it (in session
 * storage, so it outlives the worker's sleeps and a new session on the
 * tab): the main frame's document it holds for, the fields in it, and the
 * addresses (less their fragment) of documents a secret was in, which one
 * come back to may hold again as the page restores what was typed.
 */
export interface TabTaint {
  loader: string;
  nodes: Marked[];
  urls: string[];
}

const urlKey = (url: string): string => url.split("#")[0] ?? "";

/** The taint with one more field marked in the document `loader` at `url`: a new document's starts afresh, its addresses kept. */
export function marked(taint: TabTaint | undefined, loader: string, url: string, field: Marked): TabTaint {
  const next: TabTaint = taint?.loader === loader ? { ...taint, nodes: [...taint.nodes] } : { loader, nodes: [], urls: [...(taint?.urls ?? [])] };
  if (!next.nodes.some((n) => n.frame === field.frame && n.node === field.node)) next.nodes.push(field);
  const key = urlKey(url);
  if (key && !next.urls.includes(key)) next.urls = [...next.urls, key];
  return next;
}

/**
 * The taint once its document moved to `url` by itself (pushState, a
 * fragment): the document keeps its secret at the new address, and history
 * keeps both, so a step back or forward to either holds again. Undefined
 * when nothing changes: another document's move, or an address it has.
 */
export function movedWithin(taint: TabTaint | undefined, loader: string, url: string): TabTaint | undefined {
  const key = urlKey(url);
  if (!taint || !loader || taint.loader !== loader || !key || taint.urls.includes(key)) return undefined;
  return { ...taint, urls: [...taint.urls, key] };
}

/** Where taints are kept in session storage, by tab. */
export const TAINTS_KEY = "taints";

/** The taints session storage kept, read back: anything not of their shape is dropped. */
export function readTaints(v: unknown): Map<number, TabTaint> {
  const out = new Map<number, TabTaint>();
  if (typeof v !== "object" || v === null) return out;
  for (const [tab, t] of Object.entries(v as Record<string, unknown>)) {
    const taint = t as Partial<TabTaint> | undefined;
    if (!Number.isInteger(Number(tab)) || typeof taint?.loader !== "string" || !Array.isArray(taint.nodes) || !Array.isArray(taint.urls)) continue;
    const nodes = taint.nodes.filter((n): n is Marked => typeof n?.frame === "string" && Number.isInteger(n?.node));
    out.set(Number(tab), { loader: taint.loader, nodes, urls: taint.urls.filter((u): u is string => typeof u === "string") });
  }
  return out;
}

/**
 * What a tab holds now: the fields marked in its document, or, on a
 * document a secret was in come back to, the whole page with no field
 * known. Undefined when it holds none.
 */
export function heldNow(taint: TabTaint | undefined, loader: string, url: string): { nodes: Marked[] } | undefined {
  if (!taint) return undefined;
  if (loader && taint.loader === loader) return { nodes: taint.nodes };
  return taint.urls.includes(urlKey(url)) ? { nodes: [] } : undefined;
}

/** What a field holding a secret is said to hold, as KOS's hands say it (HIDDEN_VALUE in packages/browser/src/snapshot.ts). */
const HIDDEN_VALUE = "(hidden)";

/** Roles whose value is what is typed in them (VALUED in packages/browser/src/snapshot.ts, less the slider). */
const TEXT_ROLES: ReadonlySet<string> = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

type AxAnswer = { nodeId?: string; backendDOMNodeId?: number; role?: { value?: unknown }; childIds?: string[]; value?: { type?: string; value?: unknown } };

/**
 * The page's accessibility tree with each field a secret is in said to hold
 * "(hidden)", and what is inside it (the browser's own editor, whose text is
 * the value) left out: the tree says what a field holds. On a page a secret
 * was in come back to (`held` with no fields), which field holds it again is
 * not known, so every text box is.
 */
export function hiddenValues(method: string, answer: Record<string, unknown>, held: { nodes: readonly Marked[] } | undefined): Record<string, unknown> {
  if (method !== "Accessibility.getFullAXTree" || !held || !Array.isArray(answer["nodes"])) return answer;
  const filled = new Set(held.nodes.map((m) => m.node));
  const hides = (n: AxAnswer): boolean => (held.nodes.length === 0 ? TEXT_ROLES.has(String(n.role?.value ?? "")) : n.backendDOMNodeId !== undefined && filled.has(n.backendDOMNodeId));
  const nodes = answer["nodes"] as AxAnswer[];
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const inside: string[] = [];
  for (const n of nodes) {
    if (!hides(n)) continue;
    if (n.value) n.value = { type: n.value.type ?? "string", value: HIDDEN_VALUE };
    inside.push(...(n.childIds ?? []));
    n.childIds = [];
  }
  const dropped = new Set<string>();
  for (let id = inside.pop(); id !== undefined; id = inside.pop()) {
    if (dropped.has(id)) continue;
    dropped.add(id);
    inside.push(...(byId.get(id)?.childIds ?? []));
  }
  return dropped.size ? { ...answer, nodes: nodes.filter((n) => n.nodeId === undefined || !dropped.has(n.nodeId)) } : answer;
}

/** Whether a key event copies, cuts, selects all or pastes, or carries an editing command that takes text out (keys.copyKey in KOS's hands). */
function copies(params: Record<string, unknown>): boolean {
  const commands = Array.isArray(params["commands"]) ? params["commands"].filter((c): c is string => typeof c === "string") : [];
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const vk = typeof params["windowsVirtualKeyCode"] === "number" ? params["windowsVirtualKeyCode"] : 0;
  return copyKey(str(params["key"]), str(params["code"]), vk, typeof params["modifiers"] === "number" ? params["modifiers"] : 0, commands);
}

/** Whether a key event carries any editing command: refused while a filled field has the keyboard, which a paste or an undo would change. */
export function editsField(method: string, params: Record<string, unknown>): boolean {
  return method === "Input.dispatchKeyEvent" && Array.isArray(params["commands"]) && params["commands"].length > 0;
}

/**
 * Why a command may not reach a tab holding a secret, if it may not, in
 * words for "<what> is refused": KOS's script step, which runs in the
 * page's own world by its unique id and in its console's mode (Page.evaluate
 * in packages/browser/src/page.ts), a copy, a cut or a select-all, and a
 * drag, any of which could carry the value out.
 */
export function heldRefusal(method: string, params: Record<string, unknown>): string | undefined {
  if (method === "Runtime.evaluate" && (params["replMode"] === true || params["uniqueContextId"] !== undefined)) return "running a script in the page";
  if (method === "Input.dispatchKeyEvent" && copies(params)) return "copying, cutting, selecting all or pasting";
  if (method === "Input.dispatchDragEvent" || (method === "Input.setInterceptDrags" && params["enabled"] === true)) return "dragging";
  return undefined;
}

/** Whether a command types text where the keyboard is: inserted, or a key that makes a character. */
export function typesText(method: string, params: Record<string, unknown>): boolean {
  if (method === "Input.insertText") return true;
  if (method !== "Input.dispatchKeyEvent") return false;
  return params["type"] === "char" || (params["type"] === "keyDown" && typeof params["text"] === "string" && params["text"].length > 0);
}

/** Words for a refusal on a tab holding a secret. */
export const FILLED_PAGE =
  "a secret was filled into this page, so a script in it, copying, cutting, selecting all or pasting, dragging, and typing or editing in a filled field are refused until a new page loads";

/** A command to the tab's debugger. */
export type { Send };

/** A world of the extension's own in a frame; undefined where Chrome makes none (a frame of another process). */
async function worldIn(send: Send, frame: string): Promise<number | undefined> {
  const made = await send("Page.createIsolatedWorld", { frameId: frame, worldName: SECRET_WORLD, grantUniveralAccess: false }).catch(() => undefined);
  const id = made?.["executionContextId"];
  return typeof id === "number" ? id : undefined;
}

type PageFn = (this: Element, ...args: never[]) => unknown;

/** A page-side function run on an element in a world of the extension's, its answer by value; undefined when the element is gone. */
async function callOn<T>(send: Send, world: number, node: number, fn: PageFn, args: unknown[] = []): Promise<{ value: T } | undefined> {
  const resolved = await send("DOM.resolveNode", { backendNodeId: node, executionContextId: world, objectGroup: GROUP }).catch(() => undefined);
  const objectId = (resolved?.["object"] as { objectId?: string } | undefined)?.objectId;
  if (!objectId) return undefined;
  const answer = await send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true });
  // Never the page's words: an error could name what it was given.
  if (answer["exceptionDetails"]) throw new CallError("field", "the field could not be checked");
  return { value: (answer["result"] as { value?: T } | undefined)?.value as T };
}

/**
 * One field's fill, checked by what Chrome says of the tab and put in by
 * the extension (see the head of this file). `mark` is called just before
 * the value goes in, for a secret's field: one that took part of it holds
 * a secret too. Throws a CallError that never holds the value: `changed`,
 * `origin`, `field`, `unreachable`, `worker` or `focus`.
 */
export async function fillField(send: Send, put: SecretPut, mark: (field: Marked) => void): Promise<void> {
  try {
    await fillNow(send, put, mark);
  } catch (err) {
    if (err instanceof CallError) throw err;
    // The debugger's words are not passed on: one about a call could quote what it carried.
    throw new CallError("changed", "the page changed while the secret went in; look again");
  } finally {
    await send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
  }
}

async function fillNow(send: Send, put: SecretPut, mark: (field: Marked) => void): Promise<void> {
  const { main, frames } = await frameTree(send);
  const top = frames.get(main);
  if (!top || top.loader !== put.doc) throw new CallError("changed", "the page changed since it was approved; look again and ask again");
  if (top.origin !== put.origin || !fillsOn(top.origin)) throw new CallError("origin", `the page is on ${top.origin || "no site"} now, not ${put.origin}, which was approved`);
  const here = frames.get(put.frame);
  if (!here || here.origin !== put.frameOrigin || !CHECKED_ORIGIN.test(here.origin)) throw new CallError("origin", `the field's frame is on ${here?.origin || "no site"}, not ${put.frameOrigin}, which was approved`);
  const { frameOf } = await domTree(send, main);
  const nodeFrame = frameOf.get(put.node);
  if (nodeFrame === undefined) throw new CallError("unreachable", "the field is in a frame KOS cannot reach (another process, as many payment frames are); hand the tab to the owner");
  if (nodeFrame !== put.frame) throw new CallError("origin", "the field is not in the frame that was approved");
  const worlds = new Map<string, number>();
  const world = async (frame: string): Promise<number> => {
    let id = worlds.get(frame);
    if (id === undefined) {
      id = await worldIn(send, frame);
      if (id === undefined) throw new CallError("unreachable", "the extension cannot look into the frame the field is in");
      worlds.set(frame, id);
    }
    return id;
  };
  const on = async <T>(frame: string, node: number, fn: PageFn, args: unknown[] = []): Promise<T> => {
    const got = await callOn<T>(send, await world(frame), node, fn, args);
    if (!got) throw new CallError("changed", "the field is gone from the page (it changed); look again");
    return got.value;
  };
  // A field in a frame the page hides (a honeypot) is as hidden as a field that is.
  for (let at = put.frame; at !== main; ) {
    const parent = frames.get(at)?.parent;
    const owner = (await send("DOM.getFrameOwner", { frameId: at }))["backendNodeId"];
    if (!parent || typeof owner !== "number") throw new CallError("unreachable", "the field is in a frame the extension cannot reach");
    await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: owner }).catch(() => undefined);
    if (!(await on<boolean>(parent, owner, frameShown))) throw new CallError("field", "the field is in a frame that is hidden or out of view");
    at = parent;
  }
  // KOS clears no site's data in the owner's Chrome, so a worker that runs the page could catch what it sends.
  for (const frame of new Set([put.frame, main])) {
    const controlled = await send("Runtime.evaluate", { expression: "Boolean(navigator.serviceWorker && navigator.serviceWorker.controller)", contextId: await world(frame), returnByValue: true });
    if ((controlled["result"] as { value?: unknown } | undefined)?.value !== false) {
      throw new CallError("worker", "a service worker runs this page and could catch what is sent; KOS clears no site's workers in your Chrome, so the owner fills this one themselves");
    }
  }
  await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: put.node }).catch(() => undefined);
  const secret = isSecret(put.slot);
  const why = await on<string>(put.frame, put.node, fillable, [put.slot, secret]);
  if (why) throw new CallError("field", `the field: ${why}`);
  if (secret) mark({ frame: put.frame, node: put.node });
  const args = [put.value, isDigits(put.slot)];
  let held = await on<boolean>(put.frame, put.node, putValue, args);
  if (!held) {
    // The page wants keys: typed only while the field has the keyboard, checked on both sides of the typing.
    await send("DOM.focus", { backendNodeId: put.node });
    await on(put.frame, put.node, selectAll);
    if (!(await on<boolean>(put.frame, put.node, hasKeyboard))) throw new CallError("focus", "the field would not keep the keyboard (the page moved it elsewhere); nothing was typed");
    await send("Input.insertText", { text: put.value });
    if (!(await on<boolean>(put.frame, put.node, hasKeyboard))) throw new CallError("focus", "the keyboard moved off the field while it was typed into; look at the page before anything else");
    held = await on<boolean>(put.frame, put.node, holds, args);
  }
  if (!held) throw new CallError("field", "the field did not take it as given (it may format or limit what goes in); look to see what it holds");
  // Still the document it went into: one that went meanwhile took it nowhere KOS can say.
  if ((await frameTree(send)).frames.get(main)?.loader !== put.doc) throw new CallError("changed", "the page changed while the secret went in; look again");
}

/** Whether any of a tab's marked fields has the focus. */
export async function focusedOn(send: Send, nodes: readonly Marked[]): Promise<boolean> {
  try {
    for (const { frame, node } of nodes) {
      const world = await worldIn(send, frame);
      // A frame the extension cannot look into is taken to have the field focused.
      if (world === undefined) return true;
      if ((await callOn<boolean>(send, world, node, isFocused))?.value === true) return true;
    }
    return false;
  } finally {
    await send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
  }
}

/** A picture as the tab's debugger gives it: base64, and its format. */
export interface Shot {
  data: string;
  format: "png" | "jpeg";
}

/** Paints each box (x, y, width, height, in its pixels, which `boxesIn` gives for its size) black on a picture, in the same format. */
export type Paint = (shot: Shot, boxesIn: (image: { width: number; height: number }) => number[]) => Promise<string>;

/**
 * A picture of a tab that may show a secret, taken by `shoot`, with the
 * page never changed (packages/browser/src/boxes.ts): on a tab `held` to a
 * secret, every text box of every frame the extension reaches; and where
 * KOS sent `masks`, in each frame given its origin's patterns (an
 * about:blank one by the page's), its text boxes and every place the page
 * echoes one; all measured in a world of the extension's own on both sides
 * of the picture, and painted over on it by `paint`. Throws when it cannot
 * mask, so no picture is taken rather than one that shows a secret.
 */
export async function maskedShot(send: Send, held: boolean, masks: Record<string, string[]> | undefined, shoot: () => Promise<Shot>, paint: Paint): Promise<string> {
  const worlds = new Map<string, number>();
  const world = async (frame: string): Promise<number | undefined> => {
    if (!worlds.has(frame)) {
      const id = await worldIn(send, frame);
      if (id !== undefined) worlds.set(frame, id);
    }
    return worlds.get(frame);
  };
  try {
    const measure = (): ReturnType<typeof boxesOf> => boxesOf(send, world, held, (origin) => masks?.[origin] ?? []);
    const { shot, boxes } = await steadyShot(measure, shoot);
    if (!shot.data) throw new Error("no picture");
    return boxes ? await paint(shot, (image) => pixelBoxes(boxes, image)) : shot.data;
  } catch (err) {
    throw err instanceof CallError ? err : new CallError("cdp", "the page could not be masked, so it is not pictured");
  }
}

import { fillable, frameShown, hasKeyboard, holds, isFocused, maskField, maskRoot, putValue, selectAll, unmaskAll } from "@kos/browser/inpage";

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
 * (browser.eval), no copying, cutting or selecting all, no drag, and no
 * typing into a marked field; every picture of it has the marked fields
 * made unseeable, and KOS may send the patterns of the values a page may
 * echo for them to be painted over too (secret.picture).
 */

/** The world the extension's own checks and fills run in: neither the page's nor KOS's hands', so KOS's commands cannot reach it (relay.ts Worlds). */
export const SECRET_WORLD = "kos-secret";
/** The objects a fill or a mask makes, let go of together. */
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

type AxAnswer = { nodeId?: string; backendDOMNodeId?: number; childIds?: string[]; value?: { type?: string; value?: unknown } };

/**
 * The page's accessibility tree with each field a secret is in said to hold
 * "(hidden)", and what is inside it (the browser's own editor, whose text is
 * the value) left out: the tree says what a field holds.
 */
export function hiddenValues(method: string, answer: Record<string, unknown>, held: readonly Marked[]): Record<string, unknown> {
  if (method !== "Accessibility.getFullAXTree" || held.length === 0 || !Array.isArray(answer["nodes"])) return answer;
  const filled = new Set(held.map((m) => m.node));
  const nodes = answer["nodes"] as AxAnswer[];
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const inside: string[] = [];
  for (const n of nodes) {
    if (n.backendDOMNodeId === undefined || !filled.has(n.backendDOMNodeId)) continue;
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

/** Modifier bits as Input.dispatchKeyEvent takes them: Ctrl and Meta. */
const COPY_MODIFIERS = 2 | 4;
const COPY_KEYS = new Set(["a", "c", "x"]);
const COPY_COMMANDS = new Set(["copy", "cut", "selectall"]);

/** Whether a key copies, cuts or selects all: Ctrl or Meta with A, C or X, or an editing command that does. */
function copies(params: Record<string, unknown>): boolean {
  const commands = Array.isArray(params["commands"]) ? params["commands"] : [];
  if (commands.some((c) => typeof c === "string" && COPY_COMMANDS.has(c.toLowerCase()))) return true;
  const modifiers = typeof params["modifiers"] === "number" ? params["modifiers"] : 0;
  if ((modifiers & COPY_MODIFIERS) === 0) return false;
  const key = typeof params["key"] === "string" ? params["key"].toLowerCase() : "";
  const code = typeof params["code"] === "string" ? params["code"] : "";
  const vk = params["windowsVirtualKeyCode"];
  return COPY_KEYS.has(key) || /^Key[ACX]$/.test(code) || vk === 65 || vk === 67 || vk === 88;
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
  if (method === "Input.dispatchKeyEvent" && copies(params)) return "copying, cutting or selecting all";
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
  "a secret was filled into this page, so a script in it, copying, cutting or selecting all, dragging and typing into a filled field are refused until a new page loads";

/** A command to the tab's debugger. */
export type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

type Frames = Map<string, { origin: string; parent?: string; loader: string }>;

/** The tab's frames as Chrome holds them, with the main frame's id. */
async function frameTree(send: Send): Promise<{ main: string; frames: Frames }> {
  type Tree = { frame?: { id?: string; parentId?: string; securityOrigin?: string; loaderId?: string }; childFrames?: Tree[] };
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

/** The page's documents and shadow roots, open and closed, by the frame each is in, from Chrome's own tree. */
async function domTree(send: Send, main: string): Promise<{ frameOf: Map<number, string>; roots: Map<string, number[]> }> {
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

/** A world of the extension's own in a frame; undefined where Chrome makes none (a frame of another process). */
async function worldIn(send: Send, frame: string): Promise<number | undefined> {
  const made = await send("Page.createIsolatedWorld", { frameId: frame, worldName: SECRET_WORLD, grantUniveralAccess: false }).catch(() => undefined);
  const id = made?.["executionContextId"];
  return typeof id === "number" ? id : undefined;
}

type PageFn = (this: Element, ...args: never[]) => unknown;

/** A page-side function run on an element in a world of the extension's, its answer by value; undefined when the element is gone. */
async function callOn<T>(send: Send, world: number, node: number, fn: PageFn | ((this: Document | ShadowRoot, ...args: never[]) => unknown), args: unknown[] = []): Promise<{ value: T } | undefined> {
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

/**
 * A picture of a tab that may show a secret, taken by `shoot` with the
 * marked fields made unseeable (or, on a page a secret was in come back
 * to, every text box of its main frame), and, where KOS sent `masks`, every
 * text box of each frame given its origin's patterns unseeable and each
 * place the page echoes one painted over (inpage.maskRoot): a frame on no
 * web origin (about:blank) is given the page's. Put back afterwards. Throws
 * when it cannot mask, so no picture is taken rather than one that shows a
 * secret.
 */
export async function maskedShot<T>(send: Send, held: { nodes: Marked[] } | undefined, masks: Record<string, string[]> | undefined, shoot: () => Promise<T>): Promise<T> {
  const worlds = new Map<string, number>();
  const world = async (frame: string): Promise<number | undefined> => {
    if (!worlds.has(frame)) {
      const id = await worldIn(send, frame);
      if (id !== undefined) worlds.set(frame, id);
    }
    return worlds.get(frame);
  };
  const unmasked = (): Error => new CallError("cdp", "the page could not be masked, so it is not pictured");
  try {
    const { main, frames } = await frameTree(send);
    const needsRoots = masks !== undefined || (held !== undefined && held.nodes.length === 0);
    const { roots } = needsRoots ? await domTree(send, main) : { roots: new Map<string, number[]>() };
    if (masks) {
      const top = frames.get(main)?.origin ?? "";
      for (const [frame, frameRoots] of roots) {
        const origin = frames.get(frame)?.origin ?? "";
        const patterns = masks[/^https?:/.test(origin) ? origin : top];
        if (!patterns) continue;
        const id = await world(frame);
        if (id === undefined) {
          if (frame === main) throw unmasked();
          continue;
        }
        for (const root of frameRoots) if (!(await callOn(send, id, root, maskRoot, [patterns]))) throw unmasked();
      }
    }
    if (held && held.nodes.length === 0) {
      const id = await world(main);
      const mainRoots = roots.get(main) ?? [];
      if (id === undefined || mainRoots.length === 0) throw unmasked();
      for (const root of mainRoots) if (!(await callOn(send, id, root, maskRoot, [[]]))) throw unmasked();
    }
    for (const { frame, node } of held?.nodes ?? []) {
      const id = await world(frame);
      if (id === undefined) throw unmasked();
      // A field gone from the page holds nothing to show.
      await callOn(send, id, node, maskField);
    }
    return await shoot();
  } catch (err) {
    throw err instanceof CallError ? err : unmasked();
  } finally {
    for (const id of worlds.values()) await send("Runtime.callFunctionOn", { functionDeclaration: unmaskAll.toString(), executionContextId: id }).catch(() => undefined);
    await send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
  }
}

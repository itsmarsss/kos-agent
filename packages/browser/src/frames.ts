/**
 * A tab's frames across the processes they run in.
 *
 * A frame of another site runs in a process of its own (most payment frames
 * on the web: Stripe, Adyen, Braintree, PayPal), which the tab's debugging
 * session does not reach: its element is in the tab's tree, with the frame's
 * id and no document, and the frame is absent from the tab's frame tree.
 * Chrome attaches each such frame as a session of its own (Target.setAutoAttach,
 * flattened), its target's id the frame's. A tab is read here as the parts
 * its sessions hold, each part's frames and DOM, joined where a frame's
 * element sits in its parent's part. A node's backend id is its process's
 * own, so a node is named with its part (`via`): "" for the tab's session,
 * else the id of the frame whose session holds it.
 */

/** A command to one session of the tab's debugger. */
export type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * A tab as its debugger reaches it: the tab's own session, and the session
 * of each of its frames that runs in a process of its own, by that frame's
 * id. Undefined for a frame no session reaches, or one not to be reached.
 */
export interface Reach {
  send: Send;
  frame(id: string): Send | undefined;
  /** The frames of other processes attached now, by id, where the browser keeps them: their trees are read without the DOM (frameTrees). */
  frames?(): string[];
}

/** A frame of the tab: its origin and document as the browser holds them, the frame it is in, and the part it is in. */
export interface FrameInfo {
  origin: string;
  loader: string;
  parent?: string;
  via: string;
}

/** One session's part of the tab: each node's frame, and each frame's documents and shadow roots, open and closed. */
export interface Part {
  send: Send;
  frameOf: Map<number, string>;
  roots: Map<string, number[]>;
}

export interface TabMap {
  main: string;
  frames: Map<string, FrameInfo>;
  /** By `via`. */
  parts: Map<string, Part>;
  /** Frames in a process of their own that no session reached: the part their element is in, and that element. */
  unreached: Map<string, { via: string; owner: number }>;
}

/** Sessions read for one tab, at most: a page of a hundred cross-site frames is read in part, the rest unreached. */
const PARTS_MAX = 16;

type Tree = { frame?: { id?: string; parentId?: string; securityOrigin?: string; loaderId?: string }; childFrames?: Tree[] };
type DomNode = { backendNodeId?: number; nodeType?: number; frameId?: string; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode };

/** One session's frames, as its frame tree has them, and its root: the root's parent, for a frame of another process, is in another part. */
export async function ownFrames(send: Send, via: string): Promise<{ root: string; own: Map<string, FrameInfo> }> {
  const own = new Map<string, FrameInfo>();
  const walk = (t: Tree | undefined, parent?: string): void => {
    const id = t?.frame?.id;
    if (!id) return;
    const above = parent ?? t.frame?.parentId;
    own.set(id, { origin: t.frame?.securityOrigin ?? "", loader: t.frame?.loaderId ?? "", via, ...(above ? { parent: above } : {}) });
    for (const child of t.childFrames ?? []) walk(child, id);
  };
  const tree = (await send("Page.getFrameTree"))["frameTree"] as Tree | undefined;
  walk(tree);
  return { root: tree?.frame?.id ?? "", own };
}

/**
 * One session's DOM, from its own tree (pierced): each node's frame, each
 * frame's documents and shadow roots, and the elements of frames whose page
 * is in another process (`own` is the session's own frames).
 */
export async function partDom(send: Send, root: string, own: ReadonlyMap<string, unknown>): Promise<{ frameOf: Map<number, string>; roots: Map<string, number[]>; elsewhere: { frame: string; owner: number }[] }> {
  const frameOf = new Map<number, string>();
  const roots = new Map<string, number[]>();
  const elsewhere: { frame: string; owner: number }[] = [];
  const walk = (n: DomNode | undefined, frame: string): void => {
    if (!n) return;
    if (n.backendNodeId !== undefined) frameOf.set(n.backendNodeId, frame);
    if ((n.nodeType === 9 || n.nodeType === 11) && n.backendNodeId !== undefined) roots.set(frame, [...(roots.get(frame) ?? []), n.backendNodeId]);
    for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(child, frame);
    if (n.contentDocument && n.frameId) walk(n.contentDocument, n.frameId);
    // A frame's element with no document here, and not this session's: its page is in another process.
    else if (n.frameId && !own.has(n.frameId) && n.backendNodeId !== undefined) elsewhere.push({ frame: n.frameId, owner: n.backendNodeId });
  };
  walk((await send("DOM.getDocument", { depth: -1, pierce: true }))["root"] as DomNode | undefined, root);
  return { frameOf, roots, elsewhere };
}

/** The tab's frames and parts, each session's read in turn from the tab's down. Throws when the tab's own session cannot be read. */
export async function tabMap(reach: Reach): Promise<TabMap> {
  const frames = new Map<string, FrameInfo>();
  const parts = new Map<string, Part>();
  const unreached = new Map<string, { via: string; owner: number }>();
  // A session is taken as a frame's only when its own tree is rooted at that frame: one that answers for another (a browser that sends the frame's commands to the tab) is not.
  const read = async (send: Send, via: string): Promise<string> => {
    const { root, own } = await ownFrames(send, via);
    if (via && root !== via) return root;
    for (const [id, f] of own) if (!frames.has(id)) frames.set(id, f);
    const { frameOf, roots, elsewhere } = await partDom(send, root, own);
    parts.set(via, { send, frameOf, roots });
    for (const { frame, owner } of elsewhere) {
      const child = parts.size < PARTS_MAX ? reach.frame(frame) : undefined;
      const [hadFrames, hadParts] = [new Set(frames.keys()), new Set(parts.keys())];
      const got = child ? await read(child, frame).catch(() => undefined) : undefined;
      if (got === frame) continue;
      // Read in part, or not at all: none of it is taken as read.
      for (const id of [...frames.keys()]) if (!hadFrames.has(id)) frames.delete(id);
      for (const id of [...parts.keys()]) if (!hadParts.has(id)) parts.delete(id);
      unreached.set(frame, { via, owner });
    }
    return root;
  };
  const main = await read(reach.send, "");
  return { main, frames, parts, unreached };
}

/**
 * The tab's frames by their trees alone, no DOM read: the tab's own, and
 * each attached frame of another process the reach lists. Enough to say
 * which origins a tab holds; `complete` is false where the reach cannot
 * list its frames of other processes, so some may be missing.
 */
export async function frameTrees(reach: Reach): Promise<{ main: string; frames: Map<string, FrameInfo>; complete: boolean }> {
  const { root, own } = await ownFrames(reach.send, "");
  const frames = new Map(own);
  for (const id of reach.frames?.() ?? []) {
    const send = reach.frame(id);
    const got = send ? await ownFrames(send, id).catch(() => undefined) : undefined;
    if (got?.root !== id) continue;
    for (const [frame, info] of got.own) if (!frames.has(frame)) frames.set(frame, info);
  }
  return { main: root, frames, complete: reach.frames !== undefined };
}

/** The part whose session holds a frame, by the map; undefined for a frame not in it. */
export function partOf(map: TabMap, frame: string): Part | undefined {
  const via = map.frames.get(frame)?.via;
  return via === undefined ? undefined : map.parts.get(via);
}

/** The nearest web origin at or above a frame: a blank or sandboxed frame is held to the page it is in. */
export function webOrigin(map: Pick<TabMap, "frames">, frame: string): string {
  for (let at: string | undefined = frame; at; at = map.frames.get(at)?.parent) {
    const origin = map.frames.get(at)?.origin ?? "";
    if (/^https?:/i.test(origin)) return origin;
  }
  return "";
}

/** Hosts of challenge frames, with the paths that are the challenge where the host serves other things too. */
const CHALLENGES: readonly { host: string; path?: RegExp }[] = [
  { host: "challenges.cloudflare.com" },
  { host: "www.google.com", path: /^\/recaptcha\// },
  { host: "www.recaptcha.net" },
  { host: "recaptcha.net" },
  { host: "hcaptcha.com" },
  { host: "arkoselabs.com" },
  { host: "funcaptcha.com" },
  { host: "captcha-delivery.com" },
  { host: "geetest.com" },
  { host: "px-cdn.net" },
  { host: "px-cloud.net" },
];

/** Whether a frame's address is a challenge's, on its host or one under it. */
export function isChallenge(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return CHALLENGES.some((c) => (host === c.host || host.endsWith(`.${c.host}`)) && (!c.path || c.path.test(parsed.pathname)));
}

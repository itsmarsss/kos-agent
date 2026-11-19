/**
 * The owner's hand in every frame of a tab KOS works in.
 *
 * The overlay reports the owner's input from each frame it runs in, in that
 * frame's own coordinates, while KOS aims its hands in the tab's. A report
 * from a frame is moved into the tab's coordinates by the box of the frame's
 * element, so KOS's own click in a frame is known for KOS's. A frame from
 * another site runs in a process of its own, which the tab's debugging
 * session does not reach: each is attached as a session of its own, under
 * the tab's, and the overlay put in it too, so the owner typing in a payment
 * or sign-in frame still takes the tab over.
 *
 * Hearing the overlay there takes the Runtime domain (a binding is heard only
 * with it on), which a page can detect, and challenge frames (Turnstile,
 * reCAPTCHA, hCaptcha and the like) look for exactly that. So a frame's
 * session is first asked only where it is (the Page domain, which a page
 * does not see), and the Runtime domain and the overlay go only into a frame
 * that is not on a challenge host; one that goes to one has the Runtime
 * domain turned off again. The owner's hand in a challenge frame is not
 * seen. A content script in every frame would see it, but takes host access
 * to every site, which this extension does not hold, and Chrome gives no way
 * to name a content script's frame in the debugger's terms, which placing
 * its reports in the tab needs.
 *
 * KOS's hands reach a frame's session too (a saved card into a payment
 * frame, a look at what it holds), by the frame's id, and only one whose
 * Runtime domain is on: a challenge frame is never reached. Its worlds are
 * told apart as the tab's are (relay.ts Worlds).
 */

import { Worlds } from "./relay.js";

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

/** A tab, or a session under it. */
export interface Target {
  tabId: number;
  sessionId?: string;
}

export type Send = (target: Target, method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** What a frame's session is given: the overlay's script, the world it runs in, and the binding it reports by. */
export interface Install {
  source: string;
  world: string;
  binding: string;
}

/** A frame in a process of its own, attached under the session of the frame it is in. */
interface Child {
  tab: number;
  /** The session it was attached under: none for the tab's own. */
  parent: string | undefined;
  /** Its frame's id, as its own frame tree says: an extension's debugger names targets by ids of its own, not the frame's. */
  frame: string;
  /** Its worlds, as Chrome said it made them: which are the page's, KOS's hands' or the overlay's, and the frame each is in. */
  worlds: Worlds;
  /** Its overlay's worlds, as each said hello. */
  overlays: Set<number>;
  /** Whether the Runtime domain and the overlay are on in it: never on a challenge host. */
  heard: boolean;
}

/** A report from the overlay in a frame's own session. */
export interface Heard {
  world: number;
  payload: string;
}

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class HandFrames {
  private readonly children = new Map<string, Child>();

  constructor(
    private readonly send: Send,
    private readonly install: Install,
  ) {}

  /** Frames in other processes, in the tab or a frame under it, attached as they come. */
  watch(target: Target): Promise<unknown> {
    return this.send(target, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  /**
   * An event on a tab or one of its frames' sessions: a frame attached or
   * gone, a world made in one, or its overlay's report, given back.
   */
  async heard(tab: number, session: string | undefined, method: string, params: Record<string, unknown>): Promise<Heard | undefined> {
    if (method === "Target.attachedToTarget") return void (await this.attached(tab, session, params));
    if (method === "Target.detachedFromTarget") return void this.children.delete(String(params["sessionId"] ?? ""));
    const child = session ? this.children.get(session) : undefined;
    if (!child || !session) return undefined;
    const frame = record(params["frame"]);
    // Its own frame's id is its target's: a frame under it, in its process, is not where it is.
    if (method === "Page.frameNavigated" && frame["id"] === child.frame && typeof frame["url"] === "string") {
      await this.placed({ tabId: tab, sessionId: session }, child, frame["url"]).catch(() => undefined);
    } else if (method === "Runtime.executionContextCreated") {
      child.worlds.made(record(params["context"]));
    } else if (method === "Runtime.executionContextDestroyed") {
      const id = Number(params["executionContextId"]);
      child.worlds.destroyed(id, typeof params["executionContextUniqueId"] === "string" ? params["executionContextUniqueId"] : undefined);
      child.overlays.delete(id);
    } else if (method === "Runtime.executionContextsCleared") {
      child.worlds.cleared();
      child.overlays.clear();
    } else if (method === "Runtime.bindingCalled" && params["name"] === this.install.binding) {
      // The binding is in the overlay's world alone: nothing in the frame's page can call it.
      return { world: Number(params["executionContextId"]), payload: String(params["payload"] ?? "") };
    }
    return undefined;
  }

  /** Whether a session is one of a tab's frames. */
  has(session: string): boolean {
    return this.children.has(session);
  }

  /** An overlay that said hello in a frame's session, to keep alive and take down with the rest. */
  hello(session: string, world: number): void {
    this.children.get(session)?.overlays.add(world);
  }

  /** The frame a world of a frame's session is in. */
  frameOf(session: string, world: number): string | undefined {
    return this.children.get(session)?.worlds.frameOf(world);
  }

  /** The session of a tab's frame in a process of its own, by the frame's id, where KOS's hands may reach it: its Runtime domain on, so never a challenge's. */
  sessionOf(tab: number, frame: string): string | undefined {
    for (const [id, c] of this.children) if (c.tab === tab && c.frame === frame && c.heard) return id;
    return undefined;
  }

  /** The worlds of a frame's session, as Chrome said it made them. */
  worldsOf(session: string): Worlds | undefined {
    return this.children.get(session)?.worlds;
  }

  /** An expression in the overlay of each of a tab's frames that has a process of its own. */
  async toOverlays(tab: number, expression: string, withinMs: number): Promise<void> {
    const sends = [...this.children.entries()]
      .filter(([, c]) => c.tab === tab)
      .flatMap(([sessionId, c]) => [...c.overlays].map((world) => this.send({ tabId: tab, sessionId }, "Runtime.evaluate", { expression, contextId: world }).catch(() => c.overlays.delete(world))));
    await Promise.race([Promise.all(sends), new Promise((r) => setTimeout(r, withinMs))]);
  }

  /**
   * A point in a frame's viewport, in the tab's: the frame's box added in
   * each session from the frame's up to the tab's. `main` is the tab's main
   * frame. Undefined when a frame on the way is gone.
   */
  async inTab(tab: number, session: string | undefined, frame: string | undefined, at: { x: number; y: number }, main: string | undefined): Promise<{ x: number; y: number } | undefined> {
    let { x, y } = at;
    for (let s = session, f = frame; ; ) {
      const child = s ? this.children.get(s) : undefined;
      if (s && !child) return undefined;
      // A box is given in its session's top frame's viewport, whatever frames of that process lie between.
      if (f && f !== (child ? child.frame : main)) {
        const box = await this.contentBox({ tabId: tab, ...(s ? { sessionId: s } : {}) }, f);
        if (!box) return undefined;
        x += box.x;
        y += box.y;
      }
      if (!child) return { x, y };
      f = child.frame;
      s = child.parent;
    }
  }

  /** Every frame of a tab let go of: its debugger is gone, and they with it. */
  forget(tab: number): void {
    for (const [id, c] of this.children) if (c.tab === tab) this.children.delete(id);
  }

  /** Where a frame's page starts inside its element, in its session's top frame's viewport. */
  private async contentBox(target: Target, frame: string): Promise<{ x: number; y: number } | undefined> {
    try {
      const owner = record(await this.send(target, "DOM.getFrameOwner", { frameId: frame }));
      const model = record(record(await this.send(target, "DOM.getBoxModel", { backendNodeId: owner["backendNodeId"] }))["model"]);
      const content = model["content"];
      return Array.isArray(content) && typeof content[0] === "number" && typeof content[1] === "number" ? { x: content[0], y: content[1] } : undefined;
    } catch {
      return undefined;
    }
  }

  /** A frame attached under a session: the overlay in it, and frames under it watched in turn. Anything else attached is let go. */
  private async attached(tab: number, parent: string | undefined, params: Record<string, unknown>): Promise<void> {
    const sessionId = String(params["sessionId"] ?? "");
    const info = record(params["targetInfo"]);
    if (!sessionId) return;
    const target = { tabId: tab, sessionId };
    if (info["type"] !== "iframe" || typeof info["targetId"] !== "string") {
      await this.send({ tabId: tab, ...(parent ? { sessionId: parent } : {}) }, "Target.detachFromTarget", { sessionId }).catch(() => undefined);
      return;
    }
    const child: Child = { tab, parent, frame: info["targetId"], worlds: new Worlds(), overlays: new Set(), heard: false };
    this.children.set(sessionId, child);
    try {
      // Where it is, first: told as it commits, or asked now if it already has.
      await this.send(target, "Page.enable");
      const tree = record(record(await this.send(target, "Page.getFrameTree"))["frameTree"]);
      const { id, url } = record(tree["frame"]);
      if (typeof id === "string" && id) child.frame = id;
      if (typeof url === "string" && url) await this.placed(target, child, url);
      await this.watch(target);
    } catch {
      // A frame gone as it came: nothing of it to watch.
      this.children.delete(sessionId);
    }
  }

  /** A frame's session where its page now is: the overlay heard there unless it is a challenge's, and not heard once it goes to one. */
  private async placed(target: Target, child: Child, url: string): Promise<void> {
    const challenge = isChallenge(url);
    if (challenge && child.heard) {
      child.heard = false;
      child.worlds.cleared();
      child.overlays.clear();
      await this.send(target, "Runtime.disable").catch(() => undefined);
      return;
    }
    // Only a page of the web: not a blank frame waiting for its page, nor Chrome's own error page.
    if (challenge || child.heard || !/^https?:/i.test(url)) return;
    child.heard = true;
    const { source, world, binding } = this.install;
    await this.send(target, "Runtime.enable");
    await this.send(target, "Runtime.addBinding", { name: binding, executionContextName: world });
    await this.send(target, "Page.addScriptToEvaluateOnNewDocument", { source, worldName: world, runImmediately: true });
  }
}

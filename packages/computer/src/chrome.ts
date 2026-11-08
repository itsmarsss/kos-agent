import { PICTURE, Page, sendEach, type Call, type Session as TabSession, type Tab } from "@kos/browser";
import type { BrowserElsewhere, PageSpot, TabInfo } from "@kos/harness";

import { kindOf, type DeviceHub, type Session } from "./hub.js";
import { DeviceError } from "./link.js";
import type { DeviceEvent } from "./protocol.js";
import type { Device } from "./store.js";

/**
 * The owner's own Chrome, as a browser KOS's tools can work in.
 *
 * A conversation that has a session on a paired Chrome (KOS for Chrome)
 * browses there: its browser.* calls go to a tab of that Chrome, through the
 * extension, driven by the same hands as KOS's own Chrome. The tabs are the
 * session's: the ones KOS opened in its window there, and the ones the owner
 * handed it. While the owner has taken over, the hands wait. A session
 * started from the side panel works in the tab beside it, where the owner is
 * looking, rather than in a window of KOS's own.
 */

interface Kept {
  url: string;
  title: string;
  handed: boolean;
  /** The tab beside the side panel the owner is talking from. */
  focus?: boolean;
}

/** One conversation's borrowed Chrome: its tabs, the one it is on, and a page for each it has driven. */
interface Borrowed {
  session: string;
  tabs: Map<string, Kept>;
  current?: string;
  pages: Map<string, Page>;
  /** The extension sends pictures the size of the tab: one from before it made them small itself. */
  fullPictures?: boolean;
  /** How often the page has moved under the agent: navigated, taken over, handed back. */
  moved: number;
  /** Whether the owner had the Chrome when last heard. */
  paused?: boolean;
}

/** How long an agent waits for the owner to hand a tab back. */
const HOLD_WAIT_MS = 10 * 60_000;
/** Time for a command's round trip through the extension, beyond the command's own. */
const RELAY_SLACK_MS = 5_000;
/** Commands in one cdp.batch, at most (BATCH_MAX in the extension's worker). */
const BATCH_MAX = 100;

/** A call to the extension on the conversation's line: a method, its params, and how long its answer may take. */
export type Relay = (method: "cdp.send" | "cdp.batch", params: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>;

/** The extension's answer to a method it does not have: one from before batches. */
function unknownMethod(err: unknown): boolean {
  return err instanceof DeviceError && err.code === "bad_request" && /is not something this extension does/.test(err.message);
}

/**
 * A tab's commands, through the extension: one at a time, or several in one
 * round trip, a hundred at most to each. An extension from before batches
 * says it has no such method, and is sent them one by one from then on.
 */
export function relayLine(relay: Relay, tab: string): TabSession {
  const send = (method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> =>
    relay("cdp.send", { tab, method, params: params ?? {} }, (timeoutMs ?? 15_000) + RELAY_SLACK_MS);
  let batches = true;
  const chunk = async (calls: Call[], parallel: boolean, timeoutMs?: number): Promise<(Record<string, unknown> | Error)[]> => {
    const answer = await relay("cdp.batch", { tab, calls: calls.map((c) => ({ method: c.method, params: c.params ?? {} })), parallel }, (timeoutMs ?? 15_000) * Math.max(1, parallel ? 1 : calls.length) + RELAY_SLACK_MS);
    const results = Array.isArray(answer["results"]) ? (answer["results"] as { result?: Record<string, unknown>; error?: { code?: string; message?: string } }[]) : [];
    return calls.map((_, i) => {
      const r = results[i];
      if (!r) return new Error(`not sent: ${results.find((x) => x.error)?.error?.message ?? "the batch was cut short"}`);
      return r.error ? new DeviceError(r.error.code ?? "cdp", r.error.message ?? "the command failed") : (r.result ?? {});
    });
  };
  const batch = async (calls: Call[], parallel: boolean, timeoutMs?: number): Promise<(Record<string, unknown> | Error)[]> => {
    const out: (Record<string, unknown> | Error)[] = [];
    for (let i = 0; i < calls.length; i += BATCH_MAX) {
      const part = calls.slice(i, i + BATCH_MAX);
      // In order, nothing after a command that failed is sent.
      const failed = parallel ? undefined : out.find((r) => r instanceof Error);
      if (failed) {
        out.push(...part.map(() => new Error(`not sent: ${failed.message}`)));
        continue;
      }
      if (!batches) {
        out.push(...(await sendEach(send, part, parallel, timeoutMs)));
        continue;
      }
      try {
        out.push(...(await chunk(part, parallel, timeoutMs)));
      } catch (err) {
        if (!unknownMethod(err)) throw err;
        batches = false;
        out.push(...(await sendEach(send, part, parallel, timeoutMs)));
      }
    }
    return out;
  };
  return { send, batch };
}

/** A JPEG's longer side, from its frame header near the start; 0 when there is none to read. */
export function jpegEdge(base64: string): number {
  const b = Buffer.from(base64.slice(0, 16_384), "base64");
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return 0;
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return Math.max(b.readUInt16BE(i + 5), b.readUInt16BE(i + 7));
    i += 2 + b.readUInt16BE(i + 2);
  }
  return 0;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

export class OwnerChrome implements BrowserElsewhere {
  private readonly held = new Map<string, Borrowed>();
  private readonly wakers = new Set<() => void>();

  constructor(private readonly hub: DeviceHub) {
    hub.onDeviceEvent((device, event, session) => this.heard(device, event, session));
    hub.onChange(() => {
      // A session gone takes its tabs with it; a waiting hand is woken to find out.
      for (const [conversation, b] of this.held) {
        const session = this.hub.sessionOf(conversation);
        if (session?.id !== b.session) this.held.delete(conversation);
        // The owner taking the Chrome over, or handing it back, may have changed any page in it.
        else if (session.paused !== b.paused) {
          b.paused = session.paused;
          b.moved++;
        }
      }
      for (const wake of [...this.wakers]) wake();
    });
  }

  /** The conversation's live session on a Chrome, if it has one. */
  private session(conversation: string): Session | undefined {
    const session = this.hub.sessionOf(conversation);
    if (!session) return undefined;
    const device = this.hub.find(session.device);
    return device && kindOf(device) === "browser" ? session : undefined;
  }

  active(conversation: string): boolean {
    return this.session(conversation) !== undefined;
  }

  /** The Chrome a conversation is in, by name, for what it is told. */
  deviceOf(conversation: string): Device | undefined {
    const session = this.session(conversation);
    return session ? this.hub.find(session.device) : undefined;
  }

  /** A session just begun: its tabs (the ones the owner handed) learned, and the one beside the side panel made the one it is on. */
  async begun(conversation: string): Promise<Kept[]> {
    const b = this.borrowed(conversation);
    await this.refresh(conversation, b);
    const beside = [...b.tabs].find(([, t]) => t.focus);
    if (beside) b.current = beside[0];
    return [...b.tabs.values()];
  }

  async tab(conversation: string): Promise<Tab> {
    const b = this.borrowed(conversation);
    if (!b.current || !b.tabs.has(b.current)) b.current = await this.open(conversation, b);
    const tab = b.current;
    return { page: this.pageOf(conversation, b, tab), capture: (maxEdge) => this.capture(conversation, tab, maxEdge) };
  }

  tabs(conversation: string): TabInfo[] {
    const b = this.held.get(conversation);
    if (!b) return [];
    return [...b.tabs].map(([id, t]) => ({ id, title: t.title, url: t.url, ...(t.handed ? {} : { mine: true }), ...(id === b.current ? { current: true } : {}) }));
  }

  tabsOf(conversation: string): string[] {
    return [...(this.held.get(conversation)?.tabs.keys() ?? [])];
  }

  async useTab(conversation: string, tab: string): Promise<void> {
    const b = this.borrowed(conversation);
    if (!b.tabs.has(tab)) await this.refresh(conversation, b);
    if (!b.tabs.has(tab)) throw new Error("no such tab in the owner's Chrome; the owner hands one to KOS from the extension");
    b.current = tab;
  }

  async newTab(conversation: string): Promise<string> {
    const b = this.borrowed(conversation);
    b.current = await this.open(conversation, b);
    return b.current;
  }

  spot(conversation: string): PageSpot | undefined {
    const b = this.held.get(conversation);
    return b?.current ? { tab: b.current, url: b.tabs.get(b.current)?.url ?? "", moved: b.moved } : undefined;
  }

  siteOf(conversation: string): string | undefined {
    const b = this.held.get(conversation);
    const url = b?.current ? b.tabs.get(b.current)?.url : undefined;
    return url && url !== "about:blank" ? hostOf(url) : undefined;
  }

  describe(conversation: string): string {
    const device = this.deviceOf(conversation);
    return `the owner's Chrome${device ? ` (${device.name})` : ""}`;
  }

  async picture(conversation: string, maxEdge: number): Promise<string | undefined> {
    const b = this.held.get(conversation);
    return b?.current && this.session(conversation) ? this.capture(conversation, b.current, maxEdge) : undefined;
  }

  private borrowed(conversation: string): Borrowed {
    const session = this.session(conversation);
    if (!session) throw new Error("this chat is not working in the owner's Chrome; chrome.start asks for it");
    let b = this.held.get(conversation);
    if (!b || b.session !== session.id) {
      b = { session: session.id, tabs: new Map(), pages: new Map(), moved: 0 };
      this.held.set(conversation, b);
    }
    return b;
  }

  private async refresh(conversation: string, b: Borrowed): Promise<void> {
    const listed = await this.hub.act(conversation, "tabs.list", {});
    const tabs = Array.isArray(listed["tabs"]) ? (listed["tabs"] as Record<string, unknown>[]) : [];
    for (const t of tabs) {
      if (typeof t["id"] !== "string") continue;
      b.tabs.set(t["id"], { url: String(t["url"] ?? ""), title: String(t["title"] ?? ""), handed: t["handed"] === true, ...(t["focus"] === true ? { focus: true } : {}) });
    }
  }

  private async open(conversation: string, b: Borrowed): Promise<string> {
    const opened = await this.hub.act(conversation, "tabs.open", { url: "about:blank" });
    const tab = String(opened["tab"] ?? "");
    if (!tab) throw new Error("the owner's Chrome opened no tab");
    b.tabs.set(tab, { url: "about:blank", title: "", handed: false });
    return tab;
  }

  private pageOf(conversation: string, b: Borrowed, tab: string): Page {
    let page = b.pages.get(tab);
    if (!page) {
      page = new Page(
        relayLine((method, params, timeoutMs) => this.hub.act(conversation, method, params, timeoutMs), tab),
        { gate: () => this.whileOwnerHas(conversation) },
      );
      b.pages.set(tab, page);
    }
    return page;
  }

  /** Until the owner hands the Chrome back: at once when they have not taken it. True when it waited. */
  private whileOwnerHas(conversation: string): Promise<boolean> {
    if (!this.session(conversation)?.paused) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wakers.delete(check);
        reject(new Error("the owner has taken over in their Chrome and has not handed it back; tell them what you were doing, or try later"));
      }, HOLD_WAIT_MS);
      const check = (): void => {
        const session = this.session(conversation);
        if (session?.paused) return;
        clearTimeout(timer);
        this.wakers.delete(check);
        if (session) resolve(true);
        else reject(new Error("the session in the owner's Chrome ended"));
      };
      this.wakers.add(check);
    });
  }

  /**
   * The tab as it looks, small enough to send, through the extension: one
   * call, the extension making it this size (`maxEdge` is its own, not the
   * protocol's) without drawing the owner's page again. An extension from
   * before that sends it the size of the tab, which is seen by its size, and
   * from then on it is asked to draw the page small, as it was before.
   */
  private async capture(conversation: string, tab: string, maxEdge: number = PICTURE.edge): Promise<string | undefined> {
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      this.hub.act(conversation, "cdp.send", { tab, method, params }, 20_000).catch(() => ({}) as Record<string, unknown>);
    const dataOf = (shot: Record<string, unknown>): string | undefined => (typeof shot["data"] === "string" && shot["data"] ? shot["data"] : undefined);
    const b = this.held.get(conversation);
    if (!b?.fullPictures) {
      const data = dataOf(await send("Page.captureScreenshot", { format: "jpeg", quality: PICTURE.quality, maxEdge }));
      if (!data || jpegEdge(data) <= maxEdge) return data;
      if (b) b.fullPictures = true;
    }
    const metrics = await send("Page.getLayoutMetrics");
    const view = (metrics["cssVisualViewport"] ?? metrics["layoutViewport"] ?? {}) as { clientWidth?: number; clientHeight?: number };
    const [width, height] = [view.clientWidth ?? 0, view.clientHeight ?? 0];
    const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
    return dataOf(await send("Page.captureScreenshot", { format: "jpeg", quality: PICTURE.quality, ...(width && height ? { clip: { x: 0, y: 0, width, height, scale } } : {}) }));
  }

  /** What the extension tells: a page's events for its hands, tabs closing, tabs handed. */
  private heard(device: string, event: DeviceEvent, session: Session | undefined): void {
    const entry = session ? [...this.held].find(([, b]) => b.session === session.id) : undefined;
    const data = event.data;
    const tab = typeof data["tab"] === "string" ? data["tab"] : undefined;
    if (event.name === "tab.handed") {
      // A tab handed while a session is live joins it at once; the one beside the side panel, where the owner just spoke, is the one KOS is on.
      for (const [conversation, b] of this.held) {
        const live = this.session(conversation);
        if (!tab || live?.id !== b.session || live.device !== device) continue;
        b.tabs.set(tab, { url: String(data["url"] ?? ""), title: String(data["title"] ?? ""), handed: true });
        if (data["focus"] === true) b.current = tab;
      }
      return;
    }
    if (!entry || !tab) return;
    const [, b] = entry;
    if (event.name === "tab.closed") {
      b.tabs.delete(tab);
      b.pages.delete(tab);
      if (b.current === tab) b.current = undefined;
      return;
    }
    if (event.name !== "cdp.event") return;
    const method = String(data["method"] ?? "");
    const params = (typeof data["params"] === "object" && data["params"] !== null ? data["params"] : {}) as Record<string, unknown>;
    if (method === "Page.frameNavigated") {
      const frame = params["frame"] as { parentId?: string; url?: string } | undefined;
      const kept = b.tabs.get(tab);
      if (frame && !frame.parentId && kept && typeof frame.url === "string") {
        kept.url = frame.url;
        b.moved++;
      }
    }
    b.pages.get(tab)?.handle({ method, params });
  }
}

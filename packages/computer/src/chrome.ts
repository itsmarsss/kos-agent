import { Page, type Tab } from "@kos/browser";
import type { BrowserElsewhere, TabInfo } from "@kos/harness";

import { kindOf, type DeviceHub, type Session } from "./hub.js";
import type { DeviceEvent } from "./protocol.js";
import type { Device } from "./store.js";

/**
 * The owner's own Chrome, as a browser KOS's tools can work in.
 *
 * A conversation that has a session on a paired Chrome (the KOS extension)
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
}

/** How long an agent waits for the owner to hand a tab back. */
const HOLD_WAIT_MS = 10 * 60_000;
/** Time for a command's round trip through the extension, beyond the command's own. */
const RELAY_SLACK_MS = 5_000;
const CAPTURE_WIDTH = 1280;

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
      for (const [conversation, b] of this.held) if (this.hub.sessionOf(conversation)?.id !== b.session) this.held.delete(conversation);
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
    return { page: this.pageOf(conversation, b, tab), capture: (maxWidth) => this.capture(conversation, tab, maxWidth) };
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

  siteOf(conversation: string): string | undefined {
    const b = this.held.get(conversation);
    const url = b?.current ? b.tabs.get(b.current)?.url : undefined;
    return url && url !== "about:blank" ? hostOf(url) : undefined;
  }

  describe(conversation: string): string {
    const device = this.deviceOf(conversation);
    return `the owner's Chrome${device ? ` (${device.name})` : ""}`;
  }

  async picture(conversation: string, maxWidth: number): Promise<string | undefined> {
    const b = this.held.get(conversation);
    return b?.current && this.session(conversation) ? this.capture(conversation, b.current, maxWidth) : undefined;
  }

  private borrowed(conversation: string): Borrowed {
    const session = this.session(conversation);
    if (!session) throw new Error("this chat is not working in the owner's Chrome; chrome.start asks for it");
    let b = this.held.get(conversation);
    if (!b || b.session !== session.id) {
      b = { session: session.id, tabs: new Map(), pages: new Map() };
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
        { send: (method, params, timeoutMs) => this.hub.act(conversation, "cdp.send", { tab, method, params: params ?? {} }, (timeoutMs ?? 15_000) + RELAY_SLACK_MS) },
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

  /** The tab as it looks, small enough to send, through the extension. */
  private async capture(conversation: string, tab: string, maxWidth = CAPTURE_WIDTH): Promise<string | undefined> {
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => this.hub.act(conversation, "cdp.send", { tab, method, params }, 20_000);
    const metrics = await send("Page.getLayoutMetrics").catch(() => ({}) as Record<string, unknown>);
    const view = (metrics["cssVisualViewport"] ?? metrics["layoutViewport"] ?? {}) as { clientWidth?: number; clientHeight?: number };
    const width = view.clientWidth ?? 0;
    const height = view.clientHeight ?? 0;
    const scale = width > maxWidth ? maxWidth / width : 1;
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 60, ...(width && height ? { clip: { x: 0, y: 0, width, height, scale } } : {}) }).catch(() => ({}) as Record<string, unknown>);
    return typeof shot["data"] === "string" && shot["data"] ? shot["data"] : undefined;
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
      if (frame && !frame.parentId && kept && typeof frame.url === "string") kept.url = frame.url;
    }
    b.pages.get(tab)?.handle({ method, params });
  }
}

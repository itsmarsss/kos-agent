import { CdpClient, type CdpEvent, type CdpSocket } from "./cdp.js";
import type { ChromeHost, ChromeLaunch, ChromeState } from "./chrome.js";

/**
 * The browser, watched.
 *
 * KOS runs one Chrome and every agent works in a tab of it, each tab in a
 * window of its own so that all of them paint at once. This is KOS's eyes
 * on that Chrome, over Chrome's own protocol: the list of tabs and whose
 * each is, a screencast of any tab for whoever is watching it, and a
 * watcher's clicks and keys passed to the tab they are looking at.
 *
 * The engine (agent-browser) is the hands: it attaches to the same Chrome
 * over CDP, one session per conversation, pinned to the tab KOS made for
 * it. Nothing here knows the engine's tools; swapping it touches the
 * kernel's one bind call, not this.
 */

export interface BrowserFrame {
  seq: number;
  /** JPEG bytes, base64. Kept encoded: the dashboard wants it that way too. */
  data: string;
  width: number;
  height: number;
  /** Capture time, epoch ms. */
  at: number;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  /** The conversation this tab was made for; absent for a stray. */
  owner?: string;
}

export interface BrowserStatus {
  /** An engine with a CDP port is configured. */
  configured: boolean;
  chrome: ChromeState;
  /** This end is connected to Chrome. */
  attached: boolean;
  tabs: BrowserTab[];
  /** Where the address bar sends words that are not an address, with %s for them. */
  search: string;
}

export type BrowserEvent =
  | { type: "status"; status: BrowserStatus }
  | { type: "tabs"; tabs: BrowserTab[] }
  | { type: "frame"; tab: string; frame: BrowserFrame }
  /** The watched tab closed. */
  | { type: "gone"; tab: string };

export type BrowserListener = (event: BrowserEvent) => void;

/** Input the dashboard may send through. Shapes follow the live view's own protocol. */
export type BrowserInput =
  | { type: "input_mouse"; eventType: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel"; x: number; y: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number }
  | { type: "input_keyboard"; eventType: "keyDown" | "keyUp" | "char"; key?: string; code?: string; text?: string; modifiers?: number };

const INPUT_TYPES = new Set(["input_mouse", "input_keyboard"]);
const MOUSE_EVENTS = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const KEY_EVENTS = new Set(["keyDown", "keyUp", "char"]);

/** Only the shapes above go to the browser; anything else is refused. */
export function parseInput(raw: unknown): BrowserInput {
  if (!raw || typeof raw !== "object") throw new Error("input must be an object");
  const o = raw as Record<string, unknown>;
  const type = o["type"];
  if (typeof type !== "string" || !INPUT_TYPES.has(type)) throw new Error("unknown input type");
  const eventType = o["eventType"];
  if (typeof eventType !== "string") throw new Error("eventType required");
  const num = (k: string, required = false): number | undefined => {
    const v = o[k];
    if (v === undefined) {
      if (required) throw new Error(`${k} required`);
      return undefined;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} must be a number`);
    return v;
  };
  const str = (k: string): string | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length > 64) throw new Error(`${k} must be a short string`);
    return v;
  };
  const modifiers = num("modifiers");
  if (type === "input_mouse") {
    if (!MOUSE_EVENTS.has(eventType)) throw new Error("unknown mouse event");
    const out: Extract<BrowserInput, { type: "input_mouse" }> = {
      type: "input_mouse",
      eventType: eventType as Extract<BrowserInput, { type: "input_mouse" }>["eventType"],
      x: num("x", true)!,
      y: num("y", true)!,
    };
    const button = str("button");
    const clickCount = num("clickCount");
    const deltaX = num("deltaX");
    const deltaY = num("deltaY");
    if (button !== undefined) out.button = button;
    if (clickCount !== undefined) out.clickCount = clickCount;
    if (deltaX !== undefined) out.deltaX = deltaX;
    if (deltaY !== undefined) out.deltaY = deltaY;
    if (modifiers !== undefined) out.modifiers = modifiers;
    return out;
  }
  if (!KEY_EVENTS.has(eventType)) throw new Error("unknown keyboard event");
  const out: Extract<BrowserInput, { type: "input_keyboard" }> = {
    type: "input_keyboard",
    eventType: eventType as Extract<BrowserInput, { type: "input_keyboard" }>["eventType"],
  };
  const key = str("key");
  const code = str("code");
  const text = str("text");
  if (key !== undefined) out.key = key;
  if (code !== undefined) out.code = code;
  if (text !== undefined) out.text = text;
  if (modifiers !== undefined) out.modifiers = modifiers;
  return out;
}

/** The keys Chrome needs a virtual key code (and a character) for to act on. */
const SPECIAL_KEYS: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: "\r" },
  Backspace: { code: 8 },
  Tab: { code: 9, text: "\t" },
  Escape: { code: 27 },
  Delete: { code: 46 },
  ArrowLeft: { code: 37 },
  ArrowUp: { code: 38 },
  ArrowRight: { code: 39 },
  ArrowDown: { code: 40 },
  Home: { code: 36 },
  End: { code: 35 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
  " ": { code: 32, text: " " },
};

/** A watcher's input as the CDP call that does it. */
export function inputCommand(input: BrowserInput): { method: string; params: Record<string, unknown> } {
  if (input.type === "input_mouse") {
    const params: Record<string, unknown> = { type: input.eventType, x: input.x, y: input.y, modifiers: input.modifiers ?? 0 };
    params["button"] = input.eventType === "mouseMoved" ? "none" : (input.button ?? "left");
    if (input.eventType === "mousePressed" || input.eventType === "mouseReleased") params["clickCount"] = input.clickCount ?? 1;
    if (input.eventType === "mouseWheel") {
      params["deltaX"] = input.deltaX ?? 0;
      params["deltaY"] = input.deltaY ?? 0;
    }
    return { method: "Input.dispatchMouseEvent", params };
  }
  const params: Record<string, unknown> = { type: input.eventType, modifiers: input.modifiers ?? 0 };
  if (input.eventType === "char") {
    params["text"] = input.text ?? "";
    return { method: "Input.dispatchKeyEvent", params };
  }
  if (input.key !== undefined) params["key"] = input.key;
  if (input.code !== undefined) params["code"] = input.code;
  const special = input.key ? SPECIAL_KEYS[input.key] : undefined;
  if (special) {
    params["windowsVirtualKeyCode"] = special.code;
    params["nativeVirtualKeyCode"] = special.code;
    if (special.text && input.eventType === "keyDown") params["text"] = special.text;
  }
  return { method: "Input.dispatchKeyEvent", params };
}

/** The engine's own CDP port variable: the browser engine is the server that sets it. */
export const CDP_ENV = "AGENT_BROWSER_CDP";
/** KOS's own keys in the engine's environment. */
export const VIEWPORT_ENV = "KOS_BROWSER_VIEWPORT";
export const CHROME_ENV = "KOS_BROWSER_CHROME";
export const HEADED_ENV = "KOS_BROWSER_HEADED";
/** Unpacked extension folders, one per line or comma. */
export const EXTENSIONS_ENV = "KOS_BROWSER_EXTENSIONS";
/** The address bar's search, a URL with %s where the words go. */
export const SEARCH_ENV = "KOS_BROWSER_SEARCH";
export const DEFAULT_SEARCH = "https://duckduckgo.com/?q=%s";

export interface BrowserEngine {
  server: string;
  /** Chrome's DevTools port, which the engine attaches to and KOS runs. */
  port: number;
  /** The viewport KOS asks for each tab, if the config names one. */
  viewport?: { width: number; height: number };
  /** A Chrome binary to use, if the config names one. */
  chrome?: string;
  headed: boolean;
  extensions: string[];
  search: string;
}

/** Folders as the config writes them: a line or a comma each. */
export function parseExtensions(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The browser engine among the configured MCP servers: the one whose
 * environment names the CDP port. KOS reads it from the same config the
 * tools come from, so swapping engines is a config change.
 */
export function browserEngine(config: { servers: Record<string, { env?: Record<string, string>; enabled?: boolean }> }): BrowserEngine | undefined {
  for (const [server, entry] of Object.entries(config.servers)) {
    if (entry.enabled === false) continue;
    const raw = entry.env?.[CDP_ENV];
    const port = raw ? Number(raw) : NaN;
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    const size = /^(\d{3,5})x(\d{3,5})$/.exec(entry.env?.[VIEWPORT_ENV] ?? "");
    const chrome = entry.env?.[CHROME_ENV];
    const search = entry.env?.[SEARCH_ENV]?.trim();
    return {
      server,
      port,
      headed: /^(1|true|yes|on)$/i.test(entry.env?.[HEADED_ENV] ?? ""),
      extensions: parseExtensions(entry.env?.[EXTENSIONS_ENV]),
      search: search && search.includes("%s") ? search : DEFAULT_SEARCH,
      ...(size ? { viewport: { width: Number(size[1]), height: Number(size[2]) } } : {}),
      ...(chrome ? { chrome } : {}),
    };
  }
  return undefined;
}

/**
 * How Chrome is started for an engine's settings. The window is the
 * viewport plus its own frame, so the page is the size each tab is set to.
 */
export function launchFor(engine: BrowserEngine | undefined): ChromeLaunch {
  if (!engine) return {};
  return {
    headed: engine.headed,
    extensions: engine.extensions,
    ...(engine.chrome ? { binary: engine.chrome } : {}),
    ...(engine.viewport ? { windowSize: { width: engine.viewport.width, height: engine.viewport.height + 90 } } : {}),
  };
}

/** The engine's session name for a conversation: letters, digits, dashes, underscores. */
export function sessionFor(conversationId: string): string {
  return `kos-${conversationId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** A file the browser finished downloading, with whose tab it came from. */
export interface BrowserDownload {
  guid: string;
  url: string;
  suggestedFilename: string;
  /** Where Chrome put it: the staging folder, named by guid. */
  stagingPath: string;
  conversationId?: string;
}

export interface BrowserLiveOptions {
  engineFor: () => BrowserEngine | undefined;
  chrome: ChromeHost;
  /** Where Chrome puts downloads first; KOS moves them into the workspace from here. */
  downloadsDir?: string;
  onDownload?: (download: BrowserDownload) => void;
  /** How to open the CDP socket. Defaults to the runtime's WebSocket. */
  connect?: (url: string) => CdpSocket;
  /** Frames per second asked of a screencast. */
  maxFps?: number;
  now?: () => number;
  report?: (message: string) => void;
}

interface Target {
  id: string;
  title: string;
  url: string;
  type: string;
}

interface Watch {
  listeners: Set<BrowserListener>;
  /** The CDP session the screencast runs on, once started. */
  sessionId?: string;
  starting?: Promise<void>;
  seq: number;
  /** The newest frame, for a watcher who arrives while the page is still. */
  last?: BrowserFrame;
}

/** An engine session's tabs: the one it is on, and every one it has. */
interface Binding {
  target: string;
  conversationId: string;
  lastUsed: number;
  tabs: Set<string>;
  /** The engine has not been told which tab it is on. */
  retarget: boolean;
}

/** The owner of a tab being opened or taken. */
export interface TabOwner {
  session: string;
  conversationId: string;
}

export class BrowserLive {
  private readonly cdp: CdpClient;
  private dialing: Promise<void> | null = null;
  private readonly targets = new Map<string, Target>();
  /** Engine session name -> the tabs KOS made or took for it, and whose they are. */
  private readonly bindings = new Map<string, Binding>();
  /** Downloads under way, by guid, until Chrome says they are done. */
  private readonly downloads = new Map<string, { url: string; suggestedFilename: string; conversationId?: string }>();
  private readonly listeners = new Set<BrowserListener>();
  private readonly watches = new Map<string, Watch>();
  /** CDP sessions attached per tab, for input and the screencast. */
  private readonly sessions = new Map<string, string>();
  private readonly maxFps: number;
  private readonly now: () => number;
  private readonly report: (message: string) => void;
  private closed = false;

  constructor(private readonly options: BrowserLiveOptions) {
    this.cdp = new CdpClient(options.connect ?? ((url) => new WebSocket(url) as unknown as CdpSocket));
    this.maxFps = options.maxFps ?? 12;
    this.now = options.now ?? Date.now;
    this.report = options.report ?? ((m) => console.error(`[browser] ${m}`));
    options.chrome.onExit(() => this.onChromeGone());
  }

  status(): BrowserStatus {
    const engine = this.options.engineFor();
    return {
      configured: engine !== undefined,
      chrome: this.options.chrome.state,
      attached: this.cdp.open,
      tabs: this.tabs(),
      search: engine?.search ?? DEFAULT_SEARCH,
    };
  }

  /** How Chrome would start now, and the binary that resolves to. */
  launch(): ChromeLaunch & { found?: string } {
    return this.options.chrome.launch;
  }

  /** The page tabs, with whose each is. */
  tabs(): BrowserTab[] {
    const owners = new Map<string, string>();
    for (const b of this.bindings.values()) for (const tab of b.tabs) owners.set(tab, b.conversationId);
    return [...this.targets.values()]
      .filter((t) => t.type === "page")
      .map((t) => {
        const owner = owners.get(t.id);
        return { id: t.id, title: t.title, url: t.url, ...(owner ? { owner } : {}) };
      });
  }

  /** The tab an engine session is on, if it is still there. */
  boundTab(session: string): string | undefined {
    const b = this.bindings.get(session);
    return b && this.targets.has(b.target) ? b.target : undefined;
  }

  /** The engine sessions with a tab. */
  boundSessions(): string[] {
    return [...this.bindings.keys()];
  }

  /** The tab a conversation works in, if it has one. */
  tabOf(conversationId: string): string | undefined {
    for (const b of this.bindings.values()) {
      if (b.conversationId === conversationId && this.targets.has(b.target)) return b.target;
    }
    return undefined;
  }

  /** Chrome up and this end attached. */
  async ensure(): Promise<void> {
    if (this.closed) throw new Error("the live view is closed");
    if (this.options.engineFor() === undefined) throw new Error("no browser engine is configured");
    if (this.cdp.open) return;
    if (this.dialing) return this.dialing;
    this.dialing = this.attach().finally(() => {
      this.dialing = null;
    });
    return this.dialing;
  }

  /**
   * The tab an engine session is on, in a window of its own, made once and
   * remembered. Says whether the engine must be told which tab that is: a
   * tab just made, or one picked after the one it was on closed.
   */
  async bind(session: string, conversationId: string): Promise<{ target: string; retarget: boolean }> {
    await this.ensure();
    const b = this.bindings.get(session);
    if (b && this.targets.has(b.target)) {
      const retarget = b.retarget;
      b.retarget = false;
      return { target: b.target, retarget };
    }
    const target = await this.openTab("about:blank", { session, conversationId });
    this.bindings.get(session)!.retarget = false;
    return { target, retarget: true };
  }

  /**
   * A new tab in a window of its own: the owner's, or an agent's own next
   * to the ones it has, which it is then on.
   */
  async openTab(url = "about:blank", owner?: TabOwner): Promise<string> {
    await this.ensure();
    const result = await this.cdp.send("Target.createTarget", { url, newWindow: true });
    const target = String(result["targetId"] ?? "");
    if (!target) throw new Error("Chrome made no tab");
    if (!this.targets.has(target)) this.targets.set(target, { id: target, title: "", url, type: "page" });
    if (owner) this.take(owner, target);
    this.emitTabs();
    return target;
  }

  /**
   * An agent moves to a tab that is open: one the owner pointed at, or
   * another agent's. A tab is one session's at a time, so whoever had it
   * is moved to another of theirs, or starts afresh on their next call.
   */
  useTab(owner: TabOwner, target: string): void {
    const t = this.targets.get(target);
    if (!t || t.type !== "page") throw new Error("no such tab");
    this.take(owner, target);
    this.emitTabs();
  }

  private take(owner: TabOwner, target: string): void {
    for (const [session, b] of this.bindings) {
      if (session === owner.session || !b.tabs.has(target)) continue;
      b.tabs.delete(target);
      if (b.target === target) this.move(session, b);
    }
    const b = this.bindings.get(owner.session) ?? { target, conversationId: owner.conversationId, lastUsed: 0, tabs: new Set<string>(), retarget: true };
    if (b.target !== target) b.retarget = true;
    b.target = target;
    b.tabs.add(target);
    b.lastUsed = this.now();
    this.bindings.set(owner.session, b);
  }

  /** A session's tab went: on to another of its tabs, or out of the list. */
  private move(session: string, b: Binding): void {
    const next = [...b.tabs].find((tab) => this.targets.has(tab));
    if (next) {
      b.target = next;
      b.retarget = true;
    } else {
      this.bindings.delete(session);
    }
  }

  /** A tab is gone: whoever had it moves on. */
  private forget(target: string): void {
    this.targets.delete(target);
    this.sessions.delete(target);
    for (const [session, b] of [...this.bindings]) {
      if (!b.tabs.has(target)) continue;
      b.tabs.delete(target);
      if (b.target === target) this.move(session, b);
    }
  }

  /** Close one tab, whosever it is. */
  async closeTab(target: string): Promise<void> {
    if (!this.targets.has(target)) throw new Error("no such tab");
    await this.cdp.send("Target.closeTarget", { targetId: target });
    this.forget(target);
    this.emitTabs();
  }

  /** Send a tab somewhere, as the address bar does. */
  async navigate(tab: string, url: string): Promise<void> {
    if (!this.targets.has(tab)) throw new Error("no such tab");
    const sessionId = await this.sessionFor(tab);
    const result = await this.cdp.send("Page.navigate", { url }, sessionId);
    if (typeof result["errorText"] === "string" && result["errorText"]) throw new Error(result["errorText"]);
  }

  /** Back or forward through a tab's history. False when there is nowhere to go. */
  async history(tab: string, delta: -1 | 1): Promise<boolean> {
    if (!this.targets.has(tab)) throw new Error("no such tab");
    const sessionId = await this.sessionFor(tab);
    const got = await this.cdp.send("Page.getNavigationHistory", {}, sessionId);
    const entries = (got["entries"] as { id: number }[] | undefined) ?? [];
    const at = typeof got["currentIndex"] === "number" ? got["currentIndex"] : -1;
    const entry = entries[at + delta];
    if (!entry) return false;
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId);
    return true;
  }

  async reload(tab: string): Promise<void> {
    if (!this.targets.has(tab)) throw new Error("no such tab");
    await this.cdp.send("Page.reload", {}, await this.sessionFor(tab));
  }

  /**
   * Chrome closed and started again, so a changed launch setting (the
   * window shown, a binary, extensions) takes effect. Every tab goes with
   * it; each session gets a fresh one on its next call.
   */
  async restart(): Promise<void> {
    if (this.cdp.open) await this.cdp.send("Browser.close").catch(() => undefined);
    this.options.chrome.stop();
    this.onChromeGone();
    await this.options.chrome.waitGone();
    await this.ensure();
  }

  /** A session is in use: its tab is not idle. */
  touch(session: string): void {
    const b = this.bindings.get(session);
    if (b) b.lastUsed = this.now();
  }

  /**
   * Close the tabs of sessions nothing has used for a while, so a browser
   * that served twenty agents today is not twenty windows tonight. A
   * session whose tabs went is given a fresh one the next time it calls.
   * The owner's own tabs are nobody's and stay until they close them.
   */
  async closeIdle(maxIdleMs: number, keep: (conversationId: string) => boolean = () => false): Promise<string[]> {
    if (!this.cdp.open) return [];
    const closed: string[] = [];
    const cutoff = this.now() - maxIdleMs;
    for (const [session, b] of [...this.bindings]) {
      if (b.lastUsed > cutoff || keep(b.conversationId)) continue;
      this.bindings.delete(session);
      for (const tab of b.tabs) {
        await this.cdp.send("Target.closeTarget", { targetId: tab }).catch(() => undefined);
        closed.push(tab);
      }
    }
    if (closed.length) this.emitTabs();
    return closed;
  }

  /**
   * Close tabs nobody owns that show nothing: Chrome's first tab, and the
   * blank one the engine opens before it is told which tab is its own.
   */
  async tidy(): Promise<void> {
    if (!this.cdp.open) return;
    const owned = new Set([...this.bindings.values()].flatMap((b) => [...b.tabs]));
    if (owned.size === 0) return;
    for (const t of [...this.targets.values()]) {
      if (t.type === "page" && !owned.has(t.id) && (t.url === "about:blank" || t.url === "")) {
        await this.cdp.send("Target.closeTarget", { targetId: t.id }).catch(() => undefined);
      }
    }
  }

  /** Watch: the tab list and status always; frames of `tab` when one is named. */
  subscribe(listener: BrowserListener, tab?: string): () => void {
    this.listeners.add(listener);
    listener({ type: "status", status: this.status() });
    listener({ type: "tabs", tabs: this.tabs() });
    void this.ensure().catch((err: unknown) => this.report(`not attached: ${err instanceof Error ? err.message : String(err)}`));
    let unwatch: (() => void) | undefined;
    if (tab) unwatch = this.watch(tab, listener);
    return () => {
      this.listeners.delete(listener);
      unwatch?.();
    };
  }

  /**
   * One picture of a tab, small enough to send anywhere: what an approval
   * shows, and what a step keeps. Base64 JPEG, at most `maxWidth` wide.
   */
  async capture(tab: string, maxWidth = 900): Promise<string | undefined> {
    if (!this.targets.has(tab)) return undefined;
    const sessionId = await this.sessionFor(tab);
    const metrics: Record<string, unknown> = await this.cdp.send("Page.getLayoutMetrics", {}, sessionId).catch(() => ({}));
    const size = (metrics["cssVisualViewport"] ?? metrics["layoutViewport"] ?? {}) as Record<string, unknown>;
    const width = typeof size["clientWidth"] === "number" ? size["clientWidth"] : 0;
    const height = typeof size["clientHeight"] === "number" ? size["clientHeight"] : 0;
    const scale = width > maxWidth ? maxWidth / width : 1;
    const shot: Record<string, unknown> = await this.cdp
      .send("Page.captureScreenshot", { format: "jpeg", quality: 60, ...(width && height ? { clip: { x: 0, y: 0, width, height, scale } } : {}) }, sessionId)
      .catch(() => ({}));
    return typeof shot["data"] === "string" && shot["data"] ? shot["data"] : undefined;
  }

  /** The host of the page a conversation's tab is on, if it has one. */
  siteOf(conversationId: string): string | undefined {
    const tab = this.tabOf(conversationId);
    const url = tab ? this.targets.get(tab)?.url : undefined;
    if (!url || url === "about:blank") return undefined;
    try {
      return new URL(url).host || undefined;
    } catch {
      return undefined;
    }
  }

  /** Pass a watcher's input to a tab. */
  async input(tab: string, raw: unknown): Promise<void> {
    const command = inputCommand(parseInput(raw));
    if (!this.targets.has(tab)) throw new Error("no such tab");
    const sessionId = await this.sessionFor(tab);
    await this.cdp.send(command.method, command.params, sessionId);
  }

  close(): void {
    this.closed = true;
    this.cdp.close();
    this.targets.clear();
    this.watches.clear();
    this.sessions.clear();
    this.bindings.clear();
  }

  private async attach(): Promise<void> {
    const url = await this.options.chrome.ensure();
    await this.cdp.dial(url, () => this.onChromeGone());
    this.cdp.on((event) => this.onEvent(event));
    const listed = await this.cdp.send("Target.getTargets");
    this.targets.clear();
    for (const info of (listed["targetInfos"] as Record<string, unknown>[] | undefined) ?? []) this.remember(info);
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    // Downloads land in the staging folder named by guid, and Chrome says
    // when each is done, so KOS can move it to where it belongs.
    if (this.options.downloadsDir) {
      await this.cdp
        .send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.options.downloadsDir, eventsEnabled: true })
        .catch((err: unknown) => this.report(`downloads not set up: ${err instanceof Error ? err.message : String(err)}`));
    }
    this.emit({ type: "status", status: this.status() });
    this.emitTabs();
  }

  private onChromeGone(): void {
    this.options.chrome.lost();
    this.cdp.close();
    for (const [tab, watch] of this.watches) {
      for (const listener of watch.listeners) listener({ type: "gone", tab });
    }
    this.watches.clear();
    this.sessions.clear();
    this.targets.clear();
    this.bindings.clear();
    this.emit({ type: "status", status: this.status() });
    this.emitTabs();
  }

  private remember(info: Record<string, unknown>): void {
    const id = typeof info["targetId"] === "string" ? info["targetId"] : "";
    if (!id) return;
    this.targets.set(id, {
      id,
      title: typeof info["title"] === "string" ? info["title"] : "",
      url: typeof info["url"] === "string" ? info["url"] : "",
      type: typeof info["type"] === "string" ? info["type"] : "page",
    });
  }

  private onEvent(event: CdpEvent): void {
    switch (event.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const info = event.params["targetInfo"] as Record<string, unknown> | undefined;
        if (info) {
          this.remember(info);
          this.emitTabs();
        }
        return;
      }
      case "Target.targetDestroyed": {
        const id = String(event.params["targetId"] ?? "");
        this.forget(id);
        const watch = this.watches.get(id);
        if (watch) {
          for (const listener of watch.listeners) listener({ type: "gone", tab: id });
          this.watches.delete(id);
        }
        this.emitTabs();
        return;
      }
      case "Browser.downloadWillBegin": {
        // The main frame's id is its tab's id, which says whose download it is.
        const guid = String(event.params["guid"] ?? "");
        if (!guid) return;
        const frame = String(event.params["frameId"] ?? "");
        const owner = [...this.bindings.values()].find((b) => b.tabs.has(frame))?.conversationId;
        this.downloads.set(guid, {
          url: typeof event.params["url"] === "string" ? event.params["url"] : "",
          suggestedFilename: typeof event.params["suggestedFilename"] === "string" ? event.params["suggestedFilename"] : "download",
          ...(owner ? { conversationId: owner } : {}),
        });
        return;
      }
      case "Browser.downloadProgress": {
        const guid = String(event.params["guid"] ?? "");
        const state = event.params["state"];
        const started = this.downloads.get(guid);
        if (!started || (state !== "completed" && state !== "canceled")) return;
        this.downloads.delete(guid);
        if (state === "completed" && this.options.downloadsDir) {
          this.options.onDownload?.({ guid, ...started, stagingPath: `${this.options.downloadsDir}/${guid}` });
        }
        return;
      }
      case "Target.detachedFromTarget": {
        const sessionId = String(event.params["sessionId"] ?? "");
        for (const [tab, s] of this.sessions) if (s === sessionId) this.sessions.delete(tab);
        return;
      }
      case "Page.frameNavigated": {
        // A cross-site navigation swaps the renderer under the cast, and the
        // cast dies quietly with it. Started again for the new page.
        const frame = event.params["frame"] as Record<string, unknown> | undefined;
        if (!event.sessionId || !frame || frame["parentId"]) return;
        const navigated = [...this.watches].find(([, w]) => w.sessionId === event.sessionId);
        if (navigated) void this.recast(navigated[0], navigated[1]);
        return;
      }
      case "Page.loadEventFired": {
        // The loaded page, pictured, since a still one casts nothing more.
        if (!event.sessionId) return;
        const loaded = [...this.watches].find(([, w]) => w.sessionId === event.sessionId);
        if (loaded) void this.picture(loaded[0], loaded[1]);
        return;
      }
      case "Page.screencastFrame": {
        if (!event.sessionId) return;
        const entry = [...this.watches].find(([, w]) => w.sessionId === event.sessionId);
        if (!entry) return;
        const [tab, watch] = entry;
        const meta = (event.params["metadata"] ?? {}) as Record<string, unknown>;
        const frame: BrowserFrame = {
          seq: ++watch.seq,
          data: typeof event.params["data"] === "string" ? event.params["data"] : "",
          width: typeof meta["deviceWidth"] === "number" ? meta["deviceWidth"] : 0,
          height: typeof meta["deviceHeight"] === "number" ? meta["deviceHeight"] : 0,
          at: typeof meta["timestamp"] === "number" ? Math.round(meta["timestamp"] * 1000) : this.now(),
        };
        void this.cdp.send("Page.screencastFrameAck", { sessionId: event.params["sessionId"] }, event.sessionId).catch(() => undefined);
        if (frame.data) this.deliver(tab, watch, frame);
        return;
      }
      default:
        return;
    }
  }

  private deliver(tab: string, watch: Watch, frame: BrowserFrame): void {
    watch.last = frame;
    for (const listener of watch.listeners) listener({ type: "frame", tab, frame });
  }

  /** A listener's hold on a tab's screencast; the cast runs while any hold does. */
  private watch(tab: string, listener: BrowserListener): () => void {
    // A tab from before a restart, or one that closed a moment ago: the
    // watcher is told it is gone and picks another; nothing to start.
    if (this.cdp.open && !this.targets.has(tab)) {
      listener({ type: "gone", tab });
      return () => undefined;
    }
    let watch = this.watches.get(tab);
    if (!watch) {
      watch = { listeners: new Set(), seq: 0 };
      this.watches.set(tab, watch);
    }
    watch.listeners.add(listener);
    if (watch.last) listener({ type: "frame", tab, frame: watch.last });
    const held = watch;
    void this.ensure()
      .then(() => this.startCast(tab, held))
      .catch((err: unknown) => this.report(`screencast of ${tab} not started: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      held.listeners.delete(listener);
      if (held.listeners.size === 0 && this.watches.get(tab) === held) {
        this.watches.delete(tab);
        if (held.sessionId) void this.cdp.send("Page.stopScreencast", {}, held.sessionId).catch(() => undefined);
      }
    };
  }

  private async startCast(tab: string, watch: Watch): Promise<void> {
    if (watch.sessionId || watch.starting) return watch.starting;
    watch.starting = (async () => {
      const sessionId = await this.sessionFor(tab);
      if (this.watches.get(tab) !== watch) return;
      watch.sessionId = sessionId;
      await this.cdp.send("Page.enable", {}, sessionId).catch(() => undefined);
      await this.recast(tab, watch);
    })().finally(() => {
      watch.starting = undefined;
    });
    return watch.starting;
  }

  /** Start (or start again) a tab's cast, and picture it once. */
  private async recast(tab: string, watch: Watch): Promise<void> {
    const sessionId = watch.sessionId;
    if (!sessionId || this.watches.get(tab) !== watch) return;
    // A cast that survived the navigation refuses to start twice; stopping
    // one that is not running is a no-op, so stop first either way.
    await this.cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
    await this.cdp
      .send(
        "Page.startScreencast",
        { format: "jpeg", quality: 75, maxWidth: 1920, maxHeight: 1200, everyNthFrame: Math.max(1, Math.round(60 / this.maxFps)) },
        sessionId,
      )
      .catch((err: unknown) => this.report(`cast of ${tab}: ${err instanceof Error ? err.message : String(err)}`));
    await this.picture(tab, watch);
  }

  /**
   * One picture of the tab as it is, delivered as a frame. A still page
   * casts nothing until something on it moves, so the first look, and the
   * look after a load, are taken rather than waited for.
   */
  private async picture(tab: string, watch: Watch): Promise<void> {
    const sessionId = watch.sessionId;
    if (!sessionId || this.watches.get(tab) !== watch) return;
    const shot: Record<string, unknown> = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 75 }, sessionId).catch(() => ({}));
    const data = typeof shot["data"] === "string" ? shot["data"] : "";
    if (!data || this.watches.get(tab) !== watch) return;
    const metrics: Record<string, unknown> = await this.cdp.send("Page.getLayoutMetrics", {}, sessionId).catch(() => ({}));
    const size = (metrics["cssVisualViewport"] ?? metrics["layoutViewport"] ?? {}) as Record<string, unknown>;
    const width = typeof size["clientWidth"] === "number" ? size["clientWidth"] : 0;
    const height = typeof size["clientHeight"] === "number" ? size["clientHeight"] : 0;
    this.deliver(tab, watch, { seq: ++watch.seq, data, width, height, at: this.now() });
  }

  /** The CDP session for a tab, attached on first use. */
  private async sessionFor(tab: string): Promise<string> {
    const known = this.sessions.get(tab);
    if (known) return known;
    await this.ensure();
    const result = await this.cdp.send("Target.attachToTarget", { targetId: tab, flatten: true });
    const sessionId = String(result["sessionId"] ?? "");
    if (!sessionId) throw new Error("Chrome gave no session for the tab");
    this.sessions.set(tab, sessionId);
    return sessionId;
  }

  private emitTabs(): void {
    this.emit({ type: "tabs", tabs: this.tabs() });
  }

  private emit(event: BrowserEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

import { CdpClient, type CdpEvent, type CdpSocket } from "./cdp.js";
import type { ChromeHost, ChromeState } from "./chrome.js";

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

export interface BrowserEngine {
  server: string;
  /** Chrome's DevTools port, which the engine attaches to and KOS runs. */
  port: number;
  /** The viewport KOS asks for each tab, if the config names one. */
  viewport?: { width: number; height: number };
  /** A Chrome binary to use, if the config names one. */
  chrome?: string;
  headed: boolean;
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
    return {
      server,
      port,
      headed: /^(1|true|yes|on)$/i.test(entry.env?.[HEADED_ENV] ?? ""),
      ...(size ? { viewport: { width: Number(size[1]), height: Number(size[2]) } } : {}),
      ...(chrome ? { chrome } : {}),
    };
  }
  return undefined;
}

/** The engine's session name for a conversation: letters, digits, dashes, underscores. */
export function sessionFor(conversationId: string): string {
  return `kos-${conversationId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export interface BrowserLiveOptions {
  engineFor: () => BrowserEngine | undefined;
  chrome: ChromeHost;
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

export class BrowserLive {
  private readonly cdp: CdpClient;
  private dialing: Promise<void> | null = null;
  private readonly targets = new Map<string, Target>();
  /** Engine session name -> the tab KOS made for it and whose it is. */
  private readonly bindings = new Map<string, { target: string; conversationId: string }>();
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
    return {
      configured: this.options.engineFor() !== undefined,
      chrome: this.options.chrome.state,
      attached: this.cdp.open,
      tabs: this.tabs(),
    };
  }

  /** The page tabs, with whose each is. */
  tabs(): BrowserTab[] {
    const owners = new Map<string, string>();
    for (const b of this.bindings.values()) owners.set(b.target, b.conversationId);
    return [...this.targets.values()]
      .filter((t) => t.type === "page")
      .map((t) => {
        const owner = owners.get(t.id);
        return { id: t.id, title: t.title, url: t.url, ...(owner ? { owner } : {}) };
      });
  }

  /** The tab an engine session is bound to, if its tab is still there. */
  boundTab(session: string): string | undefined {
    const b = this.bindings.get(session);
    return b && this.targets.has(b.target) ? b.target : undefined;
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
   * A tab for an engine session, in a window of its own, made once and
   * remembered. Says whether it was just made, since a new tab needs the
   * engine told about it.
   */
  async bind(session: string, conversationId: string): Promise<{ target: string; made: boolean }> {
    await this.ensure();
    const existing = this.boundTab(session);
    if (existing) return { target: existing, made: false };
    const result = await this.cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const target = String(result["targetId"] ?? "");
    if (!target) throw new Error("Chrome made no tab");
    this.bindings.set(session, { target, conversationId });
    if (!this.targets.has(target)) this.targets.set(target, { id: target, title: "", url: "about:blank", type: "page" });
    this.emitTabs();
    return { target, made: true };
  }

  /**
   * Close tabs nobody owns that show nothing: Chrome's first tab, and the
   * blank one the engine opens before it is told which tab is its own.
   */
  async tidy(): Promise<void> {
    if (!this.cdp.open) return;
    const owned = new Set([...this.bindings.values()].map((b) => b.target));
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
        this.targets.delete(id);
        this.sessions.delete(id);
        const watch = this.watches.get(id);
        if (watch) {
          for (const listener of watch.listeners) listener({ type: "gone", tab: id });
          this.watches.delete(id);
        }
        for (const [session, b] of this.bindings) if (b.target === id) this.bindings.delete(session);
        this.emitTabs();
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

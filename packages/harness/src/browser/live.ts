/**
 * The browser, watched.
 *
 * KOS browses through agent-browser, whose daemon streams the viewport over
 * a WebSocket on the machine: JPEG frames one way, mouse and keys the other.
 * This is KOS's end of that wire. It holds the newest frame and the page's
 * state, hands them to whoever is watching from the dashboard, and passes a
 * watcher's clicks and keystrokes back, so the owner can see every page KOS
 * opens and take the wheel mid-task.
 *
 * Nothing here knows agent-browser's tools; only its stream protocol, kept
 * in one place so a different engine with a different wire is one file.
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
  active: boolean;
}

export interface BrowserStatus {
  /** A stream port is known: the browser engine is configured. */
  configured: boolean;
  /** This end is attached to the stream. */
  attached: boolean;
  /** The socket's state, for when "attached" needs explaining: connecting, open, or none. */
  socket: "none" | "connecting" | "open";
  /** How many messages the stream has sent this attachment. */
  received: number;
  /** The daemon has a browser. */
  connected: boolean;
  /** Frames are being produced. */
  screencasting: boolean;
  url?: string;
  viewport?: { width: number; height: number };
  /** The browser's tabs; the active one is what the frames show. */
  tabs: BrowserTab[];
}

export type BrowserEvent =
  | { type: "frame"; frame: BrowserFrame }
  | { type: "status"; status: BrowserStatus }
  | { type: "url"; url: string }
  | { type: "tabs"; tabs: BrowserTab[] };

export type BrowserListener = (event: BrowserEvent) => void;

/** Input the dashboard may send through. Shapes follow the stream protocol. */
export type BrowserInput =
  | { type: "input_mouse"; eventType: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel"; x: number; y: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number }
  | { type: "input_keyboard"; eventType: "keyDown" | "keyUp" | "char"; key?: string; code?: string; text?: string; modifiers?: number };

/** The slice of a WebSocket this needs, so a test can hand in a fake. */
export interface StreamSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface BrowserLiveOptions {
  /** Where the stream is, when the engine is configured. Read on each attach. */
  portFor: () => number | undefined;
  /** How to open the socket. Defaults to the runtime's WebSocket. */
  connect?: (url: string) => StreamSocket;
  /** How long to stay attached after the last watcher leaves and the last tool ran. */
  lingerMs?: number;
  /** Frames per second asked of the stream. Plenty for watching; cheap on the CPU. */
  maxFps?: number;
  now?: () => number;
  /** The daemon's browser came up (or came back): the moment to set it up. */
  onBrowserUp?: () => void;
}

/** How long a socket may take to open, and then to say anything at all. */
const HANDSHAKE_MS = 5000;

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

/** The stream port an MCP server was told to use, if it is the browser engine. */
export const STREAM_PORT_ENV = "AGENT_BROWSER_STREAM_PORT";
/** KOS's own key in the engine's environment: the page size to ask for, as WxH. */
export const VIEWPORT_ENV = "KOS_BROWSER_VIEWPORT";

export interface BrowserEngine {
  server: string;
  port: number;
  /** The viewport KOS sets when the browser comes up, if the config names one. */
  viewport?: { width: number; height: number };
}

/**
 * The browser engine among the configured MCP servers: the one whose
 * environment names a stream port. KOS reads it from the same config the
 * tools come from, so swapping engines is a config change.
 */
export function browserEngine(config: { servers: Record<string, { env?: Record<string, string>; enabled?: boolean }> }): BrowserEngine | undefined {
  for (const [server, entry] of Object.entries(config.servers)) {
    if (entry.enabled === false) continue;
    const raw = entry.env?.[STREAM_PORT_ENV];
    const port = raw ? Number(raw) : NaN;
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    const size = /^(\d{3,5})x(\d{3,5})$/.exec(entry.env?.[VIEWPORT_ENV] ?? "");
    return { server, port, ...(size ? { viewport: { width: Number(size[1]), height: Number(size[2]) } } : {}) };
  }
  return undefined;
}

export class BrowserLive {
  private readonly listeners = new Set<BrowserListener>();
  private socket: StreamSocket | null = null;
  private latest: BrowserFrame | null = null;
  private url: string | undefined;
  private tabs: BrowserTab[] = [];
  private daemon: { connected: boolean; screencasting: boolean; viewport?: { width: number; height: number } } = { connected: false, screencasting: false };
  private port: number | undefined;
  /** When the last reason to stay attached went away; nothing while there is one. */
  private idleSince: number | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryIn = 500;
  private readonly connect: (url: string) => StreamSocket;
  private readonly lingerMs: number;
  private readonly maxFps: number;
  private readonly now: () => number;
  private closed = false;
  private opened = false;
  private received = 0;
  /** The handshake and the first message each get this long; past it the socket is dead and is replaced. */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: BrowserLiveOptions) {
    this.connect = options.connect ?? ((url) => new WebSocket(url) as unknown as StreamSocket);
    this.lingerMs = options.lingerMs ?? 60_000;
    this.maxFps = options.maxFps ?? 12;
    this.now = options.now ?? Date.now;
  }

  status(): BrowserStatus {
    const port = this.options.portFor();
    return {
      configured: port !== undefined,
      attached: this.socket !== null,
      socket: this.socket === null ? "none" : this.opened ? "open" : "connecting",
      received: this.received,
      connected: this.daemon.connected,
      screencasting: this.daemon.screencasting,
      ...(this.url ? { url: this.url } : {}),
      ...(this.daemon.viewport ? { viewport: this.daemon.viewport } : {}),
      tabs: this.tabs,
    };
  }

  latestFrame(): BrowserFrame | null {
    return this.latest;
  }

  /** Watch. The stream is attached while anyone is, and a while after. */
  subscribe(listener: BrowserListener): () => void {
    this.listeners.add(listener);
    this.idleSince = null;
    this.clearLinger();
    this.attach();
    listener({ type: "status", status: this.status() });
    if (this.tabs.length) listener({ type: "tabs", tabs: this.tabs });
    if (this.url) listener({ type: "url", url: this.url });
    if (this.latest) listener({ type: "frame", frame: this.latest });
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.linger();
    };
  }

  /**
   * KOS is using the browser: attach so frames are on hand even with nobody
   * watching yet, and the watcher who arrives mid-task sees the page at once.
   */
  wake(): void {
    this.attach();
    if (this.listeners.size === 0) this.linger();
  }

  /** Pass a watcher's input to the browser. */
  input(raw: unknown): void {
    const message = parseInput(raw);
    if (!this.socket) throw new Error("not attached to the browser");
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.closed = true;
    this.clearLinger();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.detach();
  }

  private attach(): void {
    if (this.closed || this.socket) return;
    const port = this.options.portFor();
    if (port === undefined) return;
    this.port = port;
    let socket: StreamSocket;
    try {
      socket = this.connect(`ws://127.0.0.1:${port}/?maxFps=${this.maxFps}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.opened = false;
    this.received = 0;
    // A socket that neither opens nor speaks is not attached to anything,
    // whatever it says: the daemon was restarting under it, or the port was
    // someone else's for a moment. Replace it rather than wait on it.
    this.armHandshake(socket);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.opened = true;
      this.retryIn = 500;
      this.armHandshake(socket);
      this.emit({ type: "status", status: this.status() });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.received++;
      this.disarmHandshake();
      this.receive(ev.data);
    };
    socket.onerror = () => {
      /* onclose follows; that is where the retry is decided */
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.daemon = { connected: false, screencasting: false };
      this.tabs = [];
      this.emit({ type: "status", status: this.status() });
      // Gone while someone still wants it: the daemon restarts between
      // tasks, so try again rather than report a dead browser.
      if (this.listeners.size > 0 || this.idleSince !== null) this.scheduleRetry();
    };
  }

  private armHandshake(socket: StreamSocket): void {
    this.disarmHandshake();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.socket !== socket) return;
      this.detach();
      if (this.listeners.size > 0 || this.idleSince !== null) this.scheduleRetry();
    }, HANDSHAKE_MS);
  }

  private disarmHandshake(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private detach(): void {
    this.disarmHandshake();
    const socket = this.socket;
    this.socket = null;
    this.opened = false;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
    this.daemon = { connected: false, screencasting: false };
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.listeners.size > 0 || this.idleSince !== null) this.attach();
    }, this.retryIn);
    this.retryIn = Math.min(this.retryIn * 2, 10_000);
  }

  /** Nobody watching and no tool running: stay a little, then let go. */
  private linger(): void {
    this.idleSince = this.now();
    this.clearLinger();
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.listeners.size === 0) {
        this.idleSince = null;
        this.detach();
      }
    }, this.lingerMs);
  }

  private clearLinger(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  private receive(data: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(typeof data === "string" ? data : String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = message["type"];
    if (type === "frame") {
      const meta = (message["metadata"] ?? {}) as Record<string, unknown>;
      const frame: BrowserFrame = {
        seq: typeof message["seq"] === "number" ? message["seq"] : (this.latest?.seq ?? 0) + 1,
        data: typeof message["data"] === "string" ? message["data"] : "",
        width: typeof meta["deviceWidth"] === "number" ? meta["deviceWidth"] : (this.daemon.viewport?.width ?? 0),
        height: typeof meta["deviceHeight"] === "number" ? meta["deviceHeight"] : (this.daemon.viewport?.height ?? 0),
        at: typeof meta["timestamp"] === "number" ? meta["timestamp"] : this.now(),
      };
      if (!frame.data) return;
      this.latest = frame;
      this.emit({ type: "frame", frame });
    } else if (type === "status") {
      const width = message["viewportWidth"];
      const height = message["viewportHeight"];
      const was = this.daemon.connected;
      this.daemon = {
        connected: message["connected"] === true,
        screencasting: message["screencasting"] === true,
        ...(typeof width === "number" && typeof height === "number" ? { viewport: { width, height } } : {}),
      };
      this.emit({ type: "status", status: this.status() });
      if (!was && this.daemon.connected) this.options.onBrowserUp?.();
    } else if (type === "url" && typeof message["url"] === "string") {
      this.url = message["url"];
      this.emit({ type: "url", url: this.url });
    } else if (type === "tabs" && Array.isArray(message["tabs"])) {
      // Sent on attach and on tab changes. The active tab's url is the one
      // being looked at, which the url message only says after the next
      // navigation; the rest is for the tab strip.
      this.tabs = (message["tabs"] as Record<string, unknown>[])
        .filter((t) => t["type"] === undefined || t["type"] === "page")
        .map((t, i) => ({
          id: typeof t["tabId"] === "string" ? t["tabId"] : typeof t["targetId"] === "string" ? t["targetId"] : `t${i + 1}`,
          title: typeof t["title"] === "string" ? t["title"] : "",
          url: typeof t["url"] === "string" ? t["url"] : "",
          active: t["active"] === true,
        }));
      this.emit({ type: "tabs", tabs: this.tabs });
      const active = this.tabs.find((t) => t.active) ?? this.tabs[0];
      if (active && active.url && active.url !== this.url) {
        this.url = active.url;
        this.emit({ type: "url", url: this.url });
      }
    }
  }

  private emit(event: BrowserEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

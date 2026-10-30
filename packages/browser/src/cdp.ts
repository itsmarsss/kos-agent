/**
 * A thin Chrome DevTools Protocol client.
 *
 * KOS's eyes on the browser are Chrome's own: a tab list, a screencast of
 * any tab, and input to any tab, all over one WebSocket to the browser.
 * The whole of CDP is thousands of methods; this uses a few dozen, and wants
 * nothing from a library beyond what forty lines give it: ids on requests,
 * replies matched by id, events handed on, sessions flattened so a tab's
 * commands carry its sessionId.
 */

export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  /** The tab's session, for events from an attached target. Absent for browser-level events. */
  sessionId?: string;
}

export type CdpListener = (event: CdpEvent) => void;

/** How long a command may wait for its reply. */
const REPLY_MS = 15_000;

export class CdpClient {
  private socket: CdpSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<CdpListener>();
  private closedBy: (() => void) | null = null;

  constructor(private readonly connect: (url: string) => CdpSocket) {}

  get open(): boolean {
    return this.socket !== null;
  }

  /** Connect to the browser endpoint. Resolves on open, rejects on the first error. */
  async dial(url: string, onClosed: () => void): Promise<void> {
    if (this.socket) throw new Error("already connected");
    const socket = this.connect(url);
    this.socket = socket;
    this.closedBy = onClosed;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("could not reach the browser"));
      socket.onclose = () => {
        reject(new Error("the browser hung up"));
        this.dropped(socket);
      };
      socket.onmessage = (ev) => this.receive(ev.data);
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.closedBy = null;
    this.failAll(new Error("connection closed"));
    if (socket) {
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
  }

  on(listener: CdpListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send a command; to a tab when `sessionId` names its session. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = REPLY_MS): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("not connected to the browser"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private receive(data: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(typeof data === "string" ? data : String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message["id"];
    if (typeof id === "number") {
      const waiting = this.pending.get(id);
      if (!waiting) return;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      const error = message["error"] as { message?: string } | undefined;
      if (error) waiting.reject(new Error(error.message ?? "browser error"));
      else waiting.resolve((message["result"] as Record<string, unknown>) ?? {});
      return;
    }
    const method = message["method"];
    if (typeof method !== "string") return;
    const event: CdpEvent = {
      method,
      params: (message["params"] as Record<string, unknown>) ?? {},
      ...(typeof message["sessionId"] === "string" ? { sessionId: message["sessionId"] } : {}),
    };
    for (const listener of this.listeners) listener(event);
  }

  private dropped(socket: CdpSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.failAll(new Error("the browser hung up"));
    const tell = this.closedBy;
    this.closedBy = null;
    tell?.();
  }

  private failAll(error: Error): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
}

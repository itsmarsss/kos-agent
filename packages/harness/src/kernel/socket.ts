import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { BrowserFrame } from "@kos/browser";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { Kernel } from "./kernel.js";
import { authorized } from "./server.js";

/**
 * Everything live on the dashboard, on one connection.
 *
 * A turn's progress, the browser's screen and a build's log each used to be
 * a stream of their own, and Chrome gives one origin six connections: six
 * dashboard tabs holding their streams starved every fetch the dashboard
 * made. A WebSocket draws on no such pool, and one carries all three, so a
 * tab holds one connection whatever it shows.
 *
 * A message from the page names a channel to watch, or is the owner's hand
 * on the browser: input to a tab, or taking and letting go of one. What
 * comes back is JSON naming its channel, except the browser's frames, which
 * go as bytes: a four-byte length, a JSON header, then the JPEG. A frame
 * that cannot go out at once is dropped rather than queued, since a late
 * frame is worth less than the next one.
 */

export const SOCKET_PATH = "/api/socket";

/** Nothing the page sends is bigger than a key press. */
const MAX_MESSAGE = 64 * 1024;
const PING_MS = 25_000;
/** Bytes waiting to go out past which a frame is dropped. */
const FRAME_BACKLOG = 1_000_000;

export type Channel = "events" | "browser" | "builds";

export interface DashboardSocketOptions {
  /** The dashboard's token, when it has one: the socket asks for it as the API does. */
  token?: string;
  /** Origins besides the dashboard's own that may connect. */
  allowedOrigins?: string[];
}

export interface DashboardSocket {
  /** Takes the upgrade if it is for the dashboard's socket; false leaves it to someone else. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

/**
 * Whether a page may connect. A WebSocket is not held to the same-origin
 * rule, so any site open in the owner's browser could reach a socket on
 * this machine and watch it; only the dashboard's own origin (or one on the
 * list) may. A caller that is not a browser sends no origin.
 */
export function originAllowed(req: IncomingMessage, allowedOrigins: string[] = []): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createDashboardSocket(kernel: Kernel, options: DashboardSocketOptions = {}): DashboardSocket {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  let next = 1;
  return {
    upgrade(req, socket, head) {
      if ((req.url ?? "").split("?")[0] !== SOCKET_PATH) return false;
      const allowed = originAllowed(req, options.allowedOrigins) && (!options.token || authorized({ method: "GET", path: SOCKET_PATH, headers: req.headers }, options.token));
      if (!allowed) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => serve(kernel, ws, `window-${next++}`));
      return true;
    },
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

/** A browser frame as one binary message: its header's length, the header, the JPEG. */
export function frameMessage(tab: string, frame: BrowserFrame): Buffer {
  const header = Buffer.from(JSON.stringify({ channel: "browser", type: "frame", tab, seq: frame.seq, width: frame.width, height: frame.height, at: frame.at }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, Buffer.from(frame.data, "base64")]);
}

function serve(kernel: Kernel, ws: WebSocket, holder: string): void {
  const watching = new Map<Channel, () => void>();
  const send = (message: object): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const say = (channel: Channel, error: string): void => send({ channel, type: "error", error });

  const unwatch = (channel: Channel): void => {
    watching.get(channel)?.();
    watching.delete(channel);
  };

  const watch = (channel: Channel, tab?: string): void => {
    unwatch(channel);
    if (channel === "events") {
      // Caught up on what is running before anything new, so a page opened mid-turn shows the turn.
      for (const event of kernel.progress.snapshot()) send({ channel, event });
      watching.set(channel, kernel.progress.subscribe((event) => send({ channel, event })));
    } else if (channel === "builds") {
      for (const build of kernel.builds.list()) send({ channel, build });
      watching.set(
        channel,
        kernel.builds.watch((id) => {
          const build = kernel.builds.get(id);
          if (build) send({ channel, build });
        }),
      );
    } else {
      watching.set(
        channel,
        kernel.browser.subscribe((event) => {
          if (event.type !== "frame") return send({ channel, ...event });
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < FRAME_BACKLOG) ws.send(frameMessage(event.tab, event.frame));
        }, tab),
      );
    }
  };

  const handle = async (raw: RawData, binary: boolean): Promise<void> => {
    if (binary) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const channel = message["channel"];
    const tab = typeof message["tab"] === "string" ? message["tab"] : undefined;
    switch (message["op"]) {
      case "watch":
        if (channel === "events" || channel === "browser" || channel === "builds") watch(channel, tab);
        return;
      case "unwatch":
        if (channel === "events" || channel === "browser" || channel === "builds") unwatch(channel);
        return;
      case "input": {
        if (!tab) return say("browser", "tab required");
        const { op: _op, tab: _tab, ...input } = message;
        await kernel.browser.input(tab, input).catch((err: unknown) => say("browser", err instanceof Error ? err.message : String(err)));
        return;
      }
      case "take":
        if (!tab) return say("browser", "tab required");
        try {
          kernel.browser.hold(tab, holder);
        } catch (err) {
          say("browser", err instanceof Error ? err.message : String(err));
        }
        return;
      case "release":
        if (tab) kernel.browser.release(tab, holder);
        return;
      default:
        return;
    }
  };

  let alive = true;
  const beat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, PING_MS);
  beat.unref?.();
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("message", (raw, binary) => void handle(raw, binary));
  ws.on("close", () => {
    clearInterval(beat);
    for (const channel of [...watching.keys()]) unwatch(channel);
    // A window gone lets go of whatever it had taken.
    kernel.browser.releaseAll(holder);
  });
}

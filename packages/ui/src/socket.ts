/**
 * One connection to KOS for everything live.
 *
 * A turn's progress, the browser's screen and a build's log used to be a
 * stream each, and a browser gives one origin six connections: six tabs of
 * the dashboard holding their streams starved every fetch it made. This is
 * one WebSocket per tab, carrying all of them. A watcher names a channel;
 * the socket opens with the first and closes a little after the last, and
 * comes back on its own after a drop, watching again what was watched.
 */

export type Channel = "events" | "browser" | "builds";

/** A browser frame as it arrives: its header, and the JPEG as a blob. */
export interface FrameMessage {
  channel: "browser";
  type: "frame";
  tab: string;
  seq: number;
  width: number;
  height: number;
  at: number;
  image: Blob;
}

export type SocketMessage = Record<string, unknown> & { channel: Channel };

type Listener = (message: SocketMessage | FrameMessage) => void;

interface Watch {
  channel: Channel;
  params: Record<string, unknown>;
  listener: Listener;
}

/** How long the socket stays open after the last watcher leaves, so a view that remounts does not reconnect. */
const LINGER_MS = 5_000;
const RETRY_MAX_MS = 8_000;

function decodeFrame(data: ArrayBuffer): FrameMessage | null {
  if (data.byteLength < 4) return null;
  const length = new DataView(data).getUint32(0);
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length))) as Omit<FrameMessage, "image">;
    return { ...header, image: new Blob([new Uint8Array(data, 4 + length)], { type: "image/jpeg" }) };
  } catch {
    return null;
  }
}

class KosSocket {
  private ws: WebSocket | null = null;
  private readonly watches = new Set<Watch>();
  private readonly states = new Set<(up: boolean) => void>();
  private up = false;
  private retry = 0;
  private reconnect: number | undefined;
  private linger: number | undefined;

  /** Watch a channel; the newest watch of a channel sets what it carries (the tab, for the browser). */
  watch(channel: Channel, params: Record<string, unknown>, listener: Listener): () => void {
    const w: Watch = { channel, params, listener };
    this.watches.add(w);
    window.clearTimeout(this.linger);
    this.open();
    if (this.up) this.send({ op: "watch", channel, ...params });
    return () => {
      this.watches.delete(w);
      const still = [...this.watches].filter((x) => x.channel === channel).at(-1);
      if (still) this.send({ op: "watch", channel, ...still.params });
      else this.send({ op: "unwatch", channel });
      if (this.watches.size === 0) this.linger = window.setTimeout(() => this.shut(), LINGER_MS);
    };
  }

  /** Told whether the socket is up, at once and on each change. */
  onState(listener: (up: boolean) => void): () => void {
    this.states.add(listener);
    listener(this.up);
    return () => this.states.delete(listener);
  }

  send(message: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private open(): void {
    if (this.ws || this.reconnect !== undefined) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/socket`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setUp(true);
      // What each channel's newest watcher asked for, again: a fresh socket watches nothing.
      const latest = new Map<Channel, Watch>();
      for (const w of this.watches) latest.set(w.channel, w);
      for (const w of latest.values()) this.send({ op: "watch", channel: w.channel, ...w.params });
    };
    ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      const message = typeof event.data === "string" ? (JSON.parse(event.data) as SocketMessage) : decodeFrame(event.data);
      if (!message) return;
      for (const w of this.watches) if (w.channel === message.channel) w.listener(message);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setUp(false);
      if (this.watches.size === 0) return;
      const wait = Math.min(RETRY_MAX_MS, 500 * 2 ** this.retry++);
      this.reconnect = window.setTimeout(() => {
        this.reconnect = undefined;
        this.open();
      }, wait);
    };
  }

  private shut(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setUp(false);
  }

  private setUp(up: boolean): void {
    if (this.up === up) return;
    this.up = up;
    for (const listener of this.states) listener(up);
  }
}

export const socket = new KosSocket();

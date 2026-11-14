import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIPv4, isIPv6, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";

import { PairError, kindOf, type DeviceHub } from "./hub.js";
import { loadLanCert, type LanCert } from "./lancert.js";
import { PHONE_PLATFORM, PROTOCOL_VERSION, SOCKET_PATH } from "./protocol.js";
import { deviceSocketServer, PREFIX, type DeviceSocketServer } from "./routes.js";

/**
 * The listener phones on the home Wi-Fi reach KOS through: the device
 * socket and pairing, and nothing else.
 *
 * The dashboard and its API stay on loopback. This one is off until the
 * owner turns it on (Settings, Devices) or the host is started with
 * KOS_DEVICE_LAN=1. It speaks TLS only, with KOS's own certificate, which
 * a phone pins (lancert.ts); it serves only private addresses; and an
 * unpaired caller can do one thing, present a one-time code, a few times a
 * minute. Past that, every connection still proves both keys, and only a
 * phone is let in.
 */

export interface LanOptions {
  /** The port it listens on: the dashboard's plus two unless KOS_DEVICE_LAN_PORT says otherwise. */
  port: number;
  /** The address it binds: every interface unless KOS_DEVICE_LAN_HOST names one. */
  host: string;
  /** Where its certificate and key are kept, outside the workspace. */
  certPath: string;
  /** On whatever the setting says: KOS_DEVICE_LAN=1. */
  forced: boolean;
  now?: () => number;
  /** This host's addresses on its networks; the system's unless a test says. */
  addresses?: () => string[];
  /** LAN_LIMITS unless a test turns some down. */
  limits?: Partial<LanLimits>;
  /** Where it says what went wrong once it listens; the console's error stream unless given. */
  log?: (line: string) => void;
}

/** Where the listener stands, as the dashboard shows it. */
export interface LanStatus {
  on: boolean;
  /** On by the host's configuration, not the setting. */
  forced: boolean;
  port: number;
  /** Where a phone on the network finds it, one per private address of this host. */
  urls: string[];
  /** The certificate's pin and its words; empty until it was first made. */
  pin: string;
  words: string;
  /** Why it is not on when it was asked to be. */
  error?: string;
}

/** What a pairing code carries for a phone while the listener is on. */
export interface LanPairing {
  url: string;
  urls: string[];
  pin: string;
  words: string;
}

const PAIR_PATH = `${PREFIX}/pair`;
const PROBE_PATH = `${PREFIX}/lan`;
const MAX_BODY = 4 * 1024;
/** A phone's frames are chat: words, a choice, a decision. */
const MAX_FRAME_BYTES = 512 * 1024;
const MINUTE = 60_000;
const HEADERS_WITHIN_MS = 10_000;

/** How much the listener takes, from one address and from all. */
export interface LanLimits {
  /** Pairing attempts a minute. */
  pairsPerAddress: number;
  pairsInAll: number;
  /** Socket upgrades a minute. */
  upgradesPerAddress: number;
  upgradesInAll: number;
  /** Connections open at once. */
  connectionsPerAddress: number;
  connectionsInAll: number;
  /** Device sockets open at once. */
  socketsPerAddress: number;
  socketsInAll: number;
}

export const LAN_LIMITS: LanLimits = {
  pairsPerAddress: 5,
  pairsInAll: 30,
  upgradesPerAddress: 20,
  upgradesInAll: 60,
  connectionsPerAddress: 8,
  connectionsInAll: 64,
  socketsPerAddress: 2,
  socketsInAll: 16,
};

/** Keys a rate limit keeps at most; past that the least recently used goes. */
const MAX_KEYS = 1000;

/** Count of what each key did in the last window; a key past its limit waits for its oldest to age out. */
export class RateLimit {
  private readonly seen = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Take one for `key`: 0 when allowed, else the seconds until one is. */
  take(key: string): number {
    const now = this.now();
    const recent = (this.seen.get(key) ?? []).filter((t) => now - t < this.windowMs);
    // Set anew, so the map's order is the order keys were last used in.
    this.seen.delete(key);
    this.seen.set(key, recent);
    // Many addresses at once is a flood: the least recently used go first, so memory stays bounded.
    if (this.seen.size > MAX_KEYS) this.seen.delete(this.seen.keys().next().value!);
    if (recent.length >= this.limit) return Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
    recent.push(now);
    return 0;
  }
}

/** How many of something each key holds open at once. */
class Open {
  private readonly held = new Map<string, number>();

  constructor(private readonly perKey: number) {}

  /** Hold one for `key` until `closed` fires; false, holding nothing, when the key has its share. */
  hold(key: string, closed: (release: () => void) => void): boolean {
    const count = this.held.get(key) ?? 0;
    if (count >= this.perKey) return false;
    this.held.set(key, count + 1);
    closed(() => {
      const left = (this.held.get(key) ?? 1) - 1;
      if (left > 0) this.held.set(key, left);
      else this.held.delete(key);
    });
    return true;
  }
}

/** An address without brackets, zone or IPv4 mapping, lowercase. */
function bareAddress(address: string): string {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  return bare.startsWith("::ffff:") && isIPv4(bare.slice(7)) ? bare.slice(7) : bare;
}

/**
 * What a limit counts an address as: an IPv4 address itself; a unique-local,
 * link-local or loopback IPv6 one by itself too, since every device on a home
 * network shares its /64; any other IPv6 one by its /64, which one network
 * hands a single device whole to pick addresses from.
 */
export function addressKey(address: string): string {
  const bare = bareAddress(address);
  if (!isIPv6(bare)) return bare;
  const [head = "", tail = ""] = bare.split("::");
  const front = head ? head.split(":") : [];
  const back = bare.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back].map((g) => g.replace(/^0+(?=.)/, ""));
  return isPrivateAddress(bare) ? groups.join(":") : `${groups.slice(0, 4).join(":")}::/64`;
}

/**
 * Whether an address is on a private network: RFC 1918, link-local,
 * loopback, and the IPv6 unique-local, link-local and loopback ranges, in
 * IPv4-mapped form too. 100.64.0.0/10 is not among them: carriers share
 * it out behind their own NAT, so it is no sign of a home network.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = bareAddress(address);
  if (isIPv4(bare)) {
    const [a, b] = bare.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (!isIPv6(bare)) return false;
  if (bare === "::1") return true;
  return /^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare);
}

/** A home network's own IPv4 addresses of this host: the ones a phone on the Wi-Fi can reach. */
function homeAddresses(): string[] {
  const home = (a: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal && home(i.address))
    .map((i) => i.address);
}

/** An answer in JSON; `close` ends the connection once it is sent, for a caller turned away. */
const json = (res: ServerResponse, status: number, body: unknown, options: { headers?: Record<string, string>; close?: boolean } = {}): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(options.close ? { connection: "close" } : {}), ...options.headers });
  // Held now: the response lets go of its socket as it finishes.
  const socket = res.socket;
  if (options.close) res.once("finish", () => socket?.destroySoon());
  res.end(JSON.stringify(body));
};

/** An upgrade turned away before it is a socket. */
function refuse(socket: Duplex, status: string, retryAfter?: number): void {
  socket.end(`HTTP/1.1 ${status}\r\n${retryAfter ? `Retry-After: ${retryAfter}\r\n` : ""}Connection: close\r\n\r\n`, () => socket.destroy());
}

export class DeviceLan {
  private server: Server | undefined;
  private sockets: DeviceSocketServer | undefined;
  private cert: LanCert | undefined;
  private error: string | undefined;
  /** What the owner last asked for; the queue works toward it. */
  private wanted = false;
  /** Closed for good: off whatever the setting or the host says. */
  private closed = false;
  /** Each sync waits for the one before, so turning it on and off at once ends where it was last asked. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly limits: LanLimits;
  private readonly pairsByAddress: RateLimit;
  private readonly pairsInAll: RateLimit;
  private readonly upgradesByAddress: RateLimit;
  private readonly upgradesInAll: RateLimit;
  private readonly log: (line: string) => void;

  constructor(
    private readonly hubOf: () => DeviceHub | undefined,
    private readonly options: LanOptions,
  ) {
    const now = options.now ?? Date.now;
    this.limits = { ...LAN_LIMITS, ...options.limits };
    this.pairsByAddress = new RateLimit(this.limits.pairsPerAddress, MINUTE, now);
    this.pairsInAll = new RateLimit(this.limits.pairsInAll, MINUTE, now);
    this.upgradesByAddress = new RateLimit(this.limits.upgradesPerAddress, MINUTE, now);
    this.upgradesInAll = new RateLimit(this.limits.upgradesInAll, MINUTE, now);
    this.log = options.log ?? ((line) => console.error(line));
  }

  get on(): boolean {
    return this.server?.listening === true;
  }

  /** On when the owner wants it (or the host forces it) and computer use is on; off otherwise. */
  sync(wanted: boolean): Promise<LanStatus> {
    this.wanted = wanted;
    const run = this.queue.then(() => this.apply());
    this.queue = run.catch(() => undefined);
    return run;
  }

  status(): LanStatus {
    return {
      on: this.on,
      forced: this.options.forced,
      port: this.port,
      urls: this.on ? this.urls() : [],
      pin: this.cert?.pin ?? "",
      words: this.cert?.words ?? "",
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** What a new pairing code carries for a phone, while a phone can use it. */
  pairing(): LanPairing | undefined {
    const urls = this.on ? this.urls() : [];
    if (!this.cert || urls.length === 0) return undefined;
    return { url: urls[0]!, urls, pin: this.cert.pin, words: this.cert.words };
  }

  /** Off for good, forced or not: the host is shutting down. */
  async close(): Promise<void> {
    this.closed = true;
    await this.sync(false);
  }

  private want(): boolean {
    return !this.closed && (this.wanted || this.options.forced) && this.hubOf() !== undefined;
  }

  private async apply(): Promise<LanStatus> {
    if (this.want() && !this.server) await this.start();
    // Asked off while it was starting: the latest ask wins.
    if (!this.want() && this.server) await this.stop();
    if (!this.want()) this.error = undefined;
    return this.status();
  }

  /** The port it listens on: the one bound while on (a test asks for any), else the one configured. */
  private get port(): number {
    const bound = this.server?.address();
    return typeof bound === "object" && bound ? bound.port : this.options.port;
  }

  private urls(): string[] {
    const { host } = this.options;
    const port = this.port;
    const any = host === "0.0.0.0" || host === "::" || host === "";
    const addresses = any ? (this.options.addresses ?? homeAddresses)() : [host];
    return addresses.map((a) => `https://${isIPv6(a) ? `[${a}]` : a}:${port}`);
  }

  private async start(): Promise<void> {
    let server: Server;
    try {
      this.cert ??= loadLanCert(this.options.certPath, this.options.now);
      server = createServer({
        key: this.cert.key,
        cert: this.cert.cert,
        minVersion: "TLSv1.2",
        handshakeTimeout: HEADERS_WITHIN_MS,
        headersTimeout: HEADERS_WITHIN_MS,
        requestTimeout: HEADERS_WITHIN_MS,
        // Checked every second, so a request past its ten seconds goes then, not up to thirty later.
        connectionsCheckingInterval: 1000,
      });
    } catch (err) {
      // A certificate that cannot serve leaves the listener off; computer use goes on without it.
      this.cert = undefined;
      this.error = `the Wi-Fi certificate could not be used: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    server.maxConnections = this.limits.connectionsInAll;
    // Phones only, whatever else holds a key, with frames the size of a chat's.
    const sockets = deviceSocketServer(this.hubOf, { admit: (device) => kindOf(device) === "phone", loopback: false, maxPayload: MAX_FRAME_BYTES, maxSockets: this.limits.socketsInAll });
    const connections = new Open(this.limits.connectionsPerAddress);
    const socketsOpen = new Open(this.limits.socketsPerAddress);
    // Before TLS: an address off the private networks gets nothing at all, nor one holding its share open.
    server.on("connection", (socket: Socket) => {
      const address = socket.remoteAddress ?? "";
      if (!isPrivateAddress(address) || !connections.hold(addressKey(address), (release) => socket.once("close", release))) socket.destroy();
    });
    server.on("tlsClientError", (_err, socket) => socket.destroy());
    server.on("clientError", (_err, socket: Duplex) => socket.destroy());
    server.on("request", (req, res) => void this.request(req, res));
    server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head, sockets, socketsOpen));
    const listened = await new Promise<string | undefined>((resolve) => {
      server.once("error", (err) => resolve(err.message));
      server.listen(this.options.port, this.options.host, () => resolve(undefined));
    });
    if (listened) {
      sockets.close();
      server.close();
      this.error = `could not listen on port ${this.options.port}: ${listened}`;
      return;
    }
    // Whatever goes wrong once it listens is said, never thrown.
    server.on("error", (err) => this.log(`devices: the Wi-Fi listener: ${err.message}`));
    this.error = undefined;
    this.server = server;
    this.sockets = sockets;
  }
  private async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.sockets?.close();
    this.sockets = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = req.socket.remoteAddress ?? "";
    if (!isPrivateAddress(address)) return void req.socket.destroy();
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === PROBE_PATH) return json(res, 200, { kos: true, protocol: PROTOCOL_VERSION });
    if (req.method !== "POST" || path !== PAIR_PATH) return json(res, 404, { error: "not found" });

    const wait = this.pairsByAddress.take(addressKey(address)) || this.pairsInAll.take("all");
    if (wait) return json(res, 429, { error: "too many pairing attempts; wait a minute" }, { headers: { "retry-after": String(wait) }, close: true });
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return json(res, 413, { error: "too large" }, { close: true });
    const body = await readBody(req);
    if (body === "too large") return json(res, 413, { error: "too large" }, { close: true });
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      input = parsed as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "the body must be JSON" });
    }
    if (input.platform !== PHONE_PLATFORM) return json(res, 403, { error: "only a phone pairs over Wi-Fi" });
    const hub = this.hubOf();
    if (!hub) return json(res, 503, { error: "computer use is switched off" });
    try {
      json(res, 200, hub.pair({ code: input.code, name: input.name, platform: input.platform, publicKey: input.publicKey }));
    } catch (err) {
      if (err instanceof PairError) return json(res, err.status, { error: err.message });
      json(res, 500, { error: "internal" });
    }
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, sockets: DeviceSocketServer, open: Open): void {
    const address = req.socket.remoteAddress ?? "";
    if (!isPrivateAddress(address) || (req.url ?? "").split("?")[0] !== SOCKET_PATH) return void socket.destroy();
    const key = addressKey(address);
    const wait = this.upgradesByAddress.take(key) || this.upgradesInAll.take("all");
    if (wait) return refuse(socket, "429 Too Many Requests", wait);
    // A phone needs one line; a few addresses cannot take every one there is.
    if (!open.hold(key, (release) => socket.once("close", release))) return refuse(socket, "429 Too Many Requests");
    if (!sockets.upgrade(req, socket, head)) socket.destroy();
  }
}

/** The request's body as text, or "too large" past MAX_BODY, read no further. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve("too large");
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

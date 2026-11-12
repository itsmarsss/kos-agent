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
const MINUTE = 60_000;
const PAIRS_PER_ADDRESS = 5;
const PAIRS_IN_ALL = 30;
const UPGRADES_PER_ADDRESS = 20;
const HEADERS_WITHIN_MS = 10_000;

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
    if (recent.length >= this.limit) {
      this.seen.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.seen.set(key, recent);
    // Many addresses at once is a flood: the oldest keys go first, so memory stays bounded.
    if (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value!);
    return 0;
  }
}

/**
 * Whether an address is on a private network: RFC 1918, link-local,
 * loopback, a Tailscale tailnet (100.64.0.0/10), and the IPv6 unique-local,
 * link-local and loopback ranges, in IPv4-mapped form too.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const mapped = bare.startsWith("::ffff:") ? bare.slice(7) : bare;
  if (isIPv4(mapped)) {
    const [a, b] = mapped.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!isIPv6(bare)) return false;
  if (bare === "::1") return true;
  return /^f[cd][0-9a-f]{0,2}:/.test(bare) || /^fe[89ab][0-9a-f]?:/.test(bare);
}

/** A home network's own IPv4 addresses of this host: the ones a phone on the Wi-Fi can reach. */
function homeAddresses(): string[] {
  const home = (a: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal && home(i.address))
    .map((i) => i.address);
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

export class DeviceLan {
  private server: Server | undefined;
  private sockets: DeviceSocketServer | undefined;
  private cert: LanCert | undefined;
  private error: string | undefined;
  private readonly pairsByAddress: RateLimit;
  private readonly pairsInAll: RateLimit;
  private readonly upgrades: RateLimit;

  constructor(
    private readonly hubOf: () => DeviceHub | undefined,
    private readonly options: LanOptions,
  ) {
    const now = options.now ?? Date.now;
    this.pairsByAddress = new RateLimit(PAIRS_PER_ADDRESS, MINUTE, now);
    this.pairsInAll = new RateLimit(PAIRS_IN_ALL, MINUTE, now);
    this.upgrades = new RateLimit(UPGRADES_PER_ADDRESS, MINUTE, now);
  }

  get on(): boolean {
    return this.server?.listening === true;
  }

  /** On when the owner wants it (or the host forces it) and computer use is on; off otherwise. */
  async sync(wanted: boolean): Promise<LanStatus> {
    const want = (wanted || this.options.forced) && this.hubOf() !== undefined;
    if (want && !this.server) await this.start();
    else if (!want && this.server) await this.stop();
    if (!want) this.error = undefined;
    return this.status();
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

  async close(): Promise<void> {
    await this.stop();
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
    try {
      this.cert ??= loadLanCert(this.options.certPath, this.options.now);
    } catch (err) {
      this.error = `the Wi-Fi certificate could not be read: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    // Phones only, whatever else holds a key.
    const sockets = deviceSocketServer(this.hubOf, (device) => kindOf(device) === "phone");
    const server = createServer({ key: this.cert.key, cert: this.cert.cert, minVersion: "TLSv1.2", handshakeTimeout: HEADERS_WITHIN_MS, headersTimeout: HEADERS_WITHIN_MS, requestTimeout: HEADERS_WITHIN_MS });
    // Before TLS: an address off the private networks gets nothing at all.
    server.on("connection", (socket: Socket) => {
      if (!isPrivateAddress(socket.remoteAddress ?? "")) socket.destroy();
    });
    server.on("tlsClientError", (_err, socket) => socket.destroy());
    server.on("clientError", (_err, socket: Duplex) => socket.destroy());
    server.on("request", (req, res) => void this.request(req, res));
    server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head, sockets));
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

    const wait = this.pairsByAddress.take(address) || this.pairsInAll.take("all");
    if (wait) return json(res, 429, { error: "too many pairing attempts; wait a minute" }, { "retry-after": String(wait) });
    const body = await readBody(req);
    if (body === "too large") return json(res, 413, { error: "too large" });
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

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, sockets: DeviceSocketServer): void {
    const address = req.socket.remoteAddress ?? "";
    if (!isPrivateAddress(address) || (req.url ?? "").split("?")[0] !== SOCKET_PATH) return void socket.destroy();
    const wait = this.upgrades.take(address);
    if (wait) {
      socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${wait}\r\nConnection: close\r\n\r\n`);
      return void socket.destroy();
    }
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

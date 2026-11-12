import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { ApiExtension, ApiRequest, ApiResponse } from "@kos/harness";
import { WebSocketServer, type WebSocket } from "ws";

import { PairError, type DeviceHub } from "./hub.js";
import type { Socket } from "./link.js";
import type { LanPairing, LanStatus } from "./lan.js";
import type { ComputerSettings, Device } from "./store.js";
import type { DeviceUpdates } from "./updates.js";
import { MAX_FRAME_BYTES, SOCKET_PATH } from "./protocol.js";

/**
 * How devices and the dashboard reach the hub.
 *
 * Pairing is the one open route: a device has no dashboard token, and the
 * one-time code it brings is the proof. Listing, renaming, removing and
 * making a code are the owner's, behind the token. The socket itself is
 * open at the HTTP level and proved inside, by signatures.
 */

export const PREFIX = "/api/devices";
const PAIR_PATH = `${PREFIX}/pair`;

/** Sockets beyond this are refused: a page that opens hundreds is not a device. */
const MAX_SOCKETS = 64;
const PING_EVERY_MS = 30_000;

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const bad = (status: number, error: string): ApiResponse => ({ status, body: { error } });

/** The Wi-Fi listener as the routes see it: where it stands, what a code carries for a phone, and turning it on or off. */
export interface LanControl {
  status(): LanStatus;
  pairing(): LanPairing | undefined;
  sync(wanted: boolean): Promise<LanStatus>;
}

export function deviceRoutes(
  hubOf: () => DeviceHub | undefined,
  titleOf: (conversation: string) => string,
  lan?: LanControl,
  updatesOf: () => DeviceUpdates | undefined = () => undefined,
): ApiExtension {
  return {
    prefix: PREFIX,
    open: [PAIR_PATH],
    async handle(req: ApiRequest): Promise<ApiResponse | undefined> {
      const hub = hubOf();
      if (!hub) return bad(503, "computer use is switched off");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id : "";
      const route = `${req.method} ${req.path}`;
      switch (route) {
        case `POST ${PAIR_PATH}`: {
          // Readable from any origin: KOS for Chrome pairs from its own, and
          // the code is the proof, not where the request comes from. The answer
          // is a device id and KOS's public key.
          const anywhere = { "access-control-allow-origin": "*" };
          try {
            return { ...ok(hub.pair({ code: body.code, name: body.name, platform: body.platform, publicKey: body.publicKey })), headers: anywhere };
          } catch (err) {
            if (err instanceof PairError) return { ...bad(err.status, err.message), headers: anywhere };
            throw err;
          }
        }
        case `GET ${PREFIX}`: {
          const updates = updatesOf();
          return ok({
            devices: hub.list().map((d) => {
              const update = updates?.statusOf(d.id);
              return { ...d, ...(d.session ? { session: { ...d.session, title: titleOf(d.session.conversation) } } : {}), ...(update ? { update } : {}) };
            }),
            settings: hub.settings(),
            ...(lan ? { lan: lan.status() } : {}),
          });
        }
        case `POST ${PREFIX}/update`: {
          // The owner's Update now: the build tried once more, when the device is idle.
          if (!id) return bad(400, "id required");
          const updates = updatesOf();
          if (!updates) return bad(503, "this KOS does not update devices");
          if (!hub.list().some((d) => d.id === id)) return bad(404, "no such device");
          const status = await updates.updateNow(id);
          return status ? ok({ update: status }) : bad(409, "that device is offline, or not one KOS updates");
        }
        case `POST ${PREFIX}/settings`: {
          const patch: Partial<ComputerSettings> = {};
          if (body.askMinutes !== undefined) patch.askMinutes = Number(body.askMinutes);
          if (body.unattended !== undefined) patch.unattended = body.unattended === true;
          if (body.lan !== undefined) patch.lan = body.lan === true;
          if (body.autoUpdate !== undefined) patch.autoUpdate = body.autoUpdate === true;
          let next: ComputerSettings;
          try {
            next = hub.updateSettings(patch);
          } catch (err) {
            return bad(400, err instanceof Error ? err.message : String(err));
          }
          // The listener follows the setting at once, and the answer says where it landed.
          if (patch.lan !== undefined && lan) return ok({ ...next, lanStatus: await lan.sync(next.lan) });
          return ok(next);
        }
        case `POST ${PREFIX}/pairings`: {
          // While phones may pair over Wi-Fi, the code carries where and how a phone reaches KOS.
          const forPhone = lan?.pairing();
          return ok({ ...hub.issueCode(), ...(forPhone ? { lan: forPhone } : {}) });
        }
        case `POST ${PREFIX}/rename`: {
          if (!id || typeof body.name !== "string") return bad(400, "id and name required");
          try {
            const renamed = hub.rename(id, body.name);
            return renamed ? ok(renamed) : bad(404, "no such device");
          } catch (err) {
            return bad(400, err instanceof Error ? err.message : String(err));
          }
        }
        case `POST ${PREFIX}/remove`:
          if (!id) return bad(400, "id required");
          return hub.remove(id) ? ok({ removed: id }) : bad(404, "no such device");
        case `POST ${PREFIX}/stop`:
          if (!id) return bad(400, "id required");
          return ok({ stopped: hub.stopOn(id) });
        default:
          return undefined;
      }
    },
  };
}

/** A ws socket as the hub's link reads one. */
function asSocket(ws: WebSocket): Socket {
  return {
    send: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    close: (code, reason) => ws.close(code, reason),
    onMessage: (handler) =>
      ws.on("message", (data, isBinary) => {
        // The protocol is text frames; binary is not something a device sends.
        if (isBinary) ws.close(4001, "text frames only");
        else handler(data.toString());
      }),
    onClose: (handler) => ws.on("close", handler),
  };
}

export interface DeviceSocketServer {
  /** Take an HTTP upgrade if it is for the device socket; false leaves it to someone else. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

export interface DeviceSocketOptions {
  /** Narrows which proved devices this server's sockets carry (hub.accept). */
  admit?: (device: Device) => boolean;
  /** The largest frame a device may send; the protocol's 16 MB unless less. */
  maxPayload?: number;
  /** Sockets open at once. */
  maxSockets?: number;
  /** Whether a socket from loopback is a device on this computer; false for a listener whose loopback stands in for a network. */
  loopback?: boolean;
}

/** An address on this computer: 127/8 or ::1, as itself or IPv4-mapped. */
export function isLoopback(address: string | undefined): boolean {
  const a = (address ?? "").replace(/^::ffff:/i, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function deviceSocketServer(hubOf: () => DeviceHub | undefined, options: DeviceSocketOptions = {}): DeviceSocketServer {
  const { admit, maxPayload = MAX_FRAME_BYTES, maxSockets = MAX_SOCKETS, loopback = true } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const alive = new WeakSet<WebSocket>();
  // A connection that stops answering pings is a laptop that went to sleep
  // without saying goodbye; dropping it ends its session.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, PING_EVERY_MS);
  pinger.unref();

  return {
    upgrade(req, socket, head) {
      if ((req.url ?? "").split("?")[0] !== SOCKET_PATH) return false;
      const hub = hubOf();
      if (!hub || wss.clients.size >= maxSockets) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        alive.add(ws);
        ws.on("pong", () => alive.add(ws));
        ws.on("error", () => ws.terminate());
        hub.accept(asSocket(ws), { ...(admit ? { admit } : {}), local: loopback && isLoopback(req.socket.remoteAddress) });
      });
      return true;
    },
    close() {
      clearInterval(pinger);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

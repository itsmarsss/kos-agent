import { randomBytes } from "node:crypto";

import { publicKeyFromRaw, type HostKey } from "./keys.js";
import { DeviceError, DeviceLink, type Socket } from "./link.js";
import { PairingCodes, type PairingCode } from "./pairing.js";
import { CLOSE, PROTOCOL_VERSION, type Consent, type DeviceEvent, type EndReason, type Grant, type Method, type Permissions, type Size } from "./protocol.js";
import type { Device, DeviceStore } from "./store.js";

/**
 * The devices KOS can reach, and the sessions it holds on them.
 *
 * A session is the unit of consent: the owner allows one on the device, for a
 * task and a time, and every action inside it rides on that. One session per
 * device, one per conversation. The device is the authority on whether a
 * session is live; this side keeps a copy so it can answer at once, and drops
 * it whenever the device says so or goes away.
 */

export interface Session {
  id: string;
  device: string;
  conversation: string;
  task: string;
  until: number;
  space: Size;
  paused: boolean;
  startedAt: number;
}

/** A paired device as the dashboard and the agent are told of it. */
export interface DeviceStatus {
  id: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number | null;
  online: boolean;
  consent?: Consent;
  permissions?: Permissions;
  version?: string;
  os?: string;
  /** The live session on it, when there is one. */
  session?: { conversation: string; task: string; until: number; paused: boolean };
}

export interface HubDeps {
  store: DeviceStore;
  hostKey: HostKey;
  /** True while KOS's kill switch is thrown: nothing starts. */
  halted: () => boolean;
  now?: () => number;
  /** How long the owner has to answer on the device, plus the trip. */
  beginTimeoutMs?: number;
  callTimeoutMs?: number;
}

export class PairError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BEGIN_TIMEOUT_MS = 75_000;
const CALL_TIMEOUT_MS = 20_000;
const MAX_MINUTES = 120;

export class DeviceHub {
  readonly codes: PairingCodes;
  private readonly links = new Map<string, DeviceLink>();
  private readonly sessions = new Map<string, Session>();
  /** Why a conversation's last session ended, so its next call can say so. */
  private readonly endings = new Map<string, EndReason | "offline" | "removed">();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: HubDeps) {
    this.codes = new PairingCodes(this.now);
  }

  private readonly now = (): number => this.deps.now?.() ?? Date.now();

  /** Told whenever a device comes, goes, pairs, or a session changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  issueCode(): PairingCode {
    return this.codes.issue();
  }

  /** A device bringing a code and its key. Answers with its id and KOS's key, to pin. */
  pair(input: { code: unknown; name: unknown; platform: unknown; publicKey: unknown }): { device: string; hostKey: string; protocol: number } {
    const { code, name, platform, publicKey } = input;
    if (typeof code !== "string" || typeof name !== "string" || typeof platform !== "string" || typeof publicKey !== "string") {
      throw new PairError(400, "code, name, platform and publicKey are required");
    }
    // A key that cannot verify anything is refused before the code is spent.
    if (!publicKeyFromRaw(publicKey)) {
      throw new PairError(400, "publicKey must be a 32-byte Ed25519 key in base64");
    }
    if (!this.codes.redeem(code)) throw new PairError(403, "that code is wrong or has expired; make a new one in KOS");
    if (this.deps.store.byKey(publicKey)) throw new PairError(409, "this device is already paired");
    const device = this.deps.store.add({ name, platform, publicKey });
    this.changed();
    return { device: device.id, hostKey: this.deps.hostKey.publicKey, protocol: PROTOCOL_VERSION };
  }

  /** A socket a device opened; it is in once both keys are proved. */
  accept(socket: Socket): DeviceLink {
    return new DeviceLink(socket, {
      hostKey: this.deps.hostKey,
      lookup: (id) => this.deps.store.get(id),
      onReady: (link) => this.ready(link),
      onState: () => this.changed(),
      onEvent: (link, event) => this.event(link, event),
      onClose: (link) => this.gone(link),
    });
  }

  private ready(link: DeviceLink): void {
    const id = link.device!.id;
    const older = this.links.get(id);
    this.links.set(id, link);
    // The newer connection wins: the old one is a laptop that slept and woke.
    older?.close(CLOSE.replaced, "replaced by a newer connection");
    this.deps.store.seen(id);
    this.changed();
  }

  private gone(link: DeviceLink): void {
    const id = link.device?.id;
    if (!id || this.links.get(id) !== link) return;
    this.links.delete(id);
    this.deps.store.seen(id);
    // A device that is gone ends its session itself; this side follows.
    for (const s of this.sessions.values()) if (s.device === id) this.drop(s, "offline");
    this.changed();
  }

  private event(link: DeviceLink, event: DeviceEvent): void {
    const session = typeof event.data.session === "string" ? this.sessions.get(event.data.session) : undefined;
    if (!session || session.device !== link.device?.id) return;
    if (event.name === "session.paused") session.paused = true;
    else if (event.name === "session.resumed") session.paused = false;
    else if (event.name === "session.ended") this.drop(session, endReason(event.data.reason));
    this.changed();
  }

  private drop(session: Session, why: EndReason | "offline" | "removed"): void {
    this.sessions.delete(session.id);
    this.endings.set(session.conversation, why);
  }

  list(): DeviceStatus[] {
    return this.deps.store.list().map((d) => this.statusOf(d));
  }

  private statusOf(d: Device): DeviceStatus {
    const link = this.links.get(d.id);
    const session = [...this.sessions.values()].find((s) => s.device === d.id);
    return {
      id: d.id,
      name: d.name,
      platform: d.platform,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      online: link?.ready === true,
      ...(link?.state ? { consent: link.state.consent, permissions: link.state.permissions } : {}),
      ...(link?.app ? { version: link.app.version, os: link.app.os } : {}),
      ...(session ? { session: { conversation: session.conversation, task: session.task, until: session.until, paused: session.paused } } : {}),
    };
  }

  /**
   * The device a name or id means: the id, else the name exactly, else the
   * one name containing it. Where several fit, the one online is meant, since
   * an offline one could not be used anyway; nothing named means the one
   * online, or the only one there is.
   */
  find(nameOrId: string | undefined): Device | undefined {
    const devices = this.deps.store.list();
    const online = (ds: Device[]): Device[] => ds.filter((d) => this.links.get(d.id)?.ready);
    const one = (ds: Device[]): Device | undefined => (ds.length === 1 ? ds[0] : online(ds).length === 1 ? online(ds)[0] : undefined);
    const raw = (nameOrId ?? "").trim().toLowerCase();
    if (!raw) return one(devices);
    const byId = devices.find((d) => d.id.toLowerCase() === raw);
    if (byId) return byId;
    const exact = devices.filter((d) => d.name.toLowerCase() === raw);
    return exact.length ? one(exact) : one(devices.filter((d) => d.name.toLowerCase().includes(raw)));
  }

  /** How a device's sessions are allowed: on the device itself, or through KOS's approvals. */
  consentOf(deviceId: string): Consent | undefined {
    return this.links.get(deviceId)?.state?.consent;
  }

  sessionOf(conversation: string): Session | undefined {
    const session = [...this.sessions.values()].find((s) => s.conversation === conversation);
    if (session && session.until <= this.now()) {
      this.drop(session, "expired");
      return undefined;
    }
    return session;
  }

  /** Why this conversation's last session ended, once; undefined when none did. */
  takeEnding(conversation: string): string | undefined {
    const why = this.endings.get(conversation);
    this.endings.delete(conversation);
    return why;
  }

  /** Ask the owner, on the device, for a session; resolves when they answer. */
  async begin(input: { conversation: string; device: Device; task: string; requester: string; minutes: number; maxEdge?: number }): Promise<Session> {
    if (this.deps.halted()) throw new DeviceError("halted", "KOS is halted by the kill switch");
    const held = this.sessionOf(input.conversation);
    if (held) {
      if (held.device === input.device.id) return held;
      throw new DeviceError("busy", "this chat already has a session on another device; end it first");
    }
    const link = this.links.get(input.device.id);
    if (!link?.ready) throw new DeviceError("offline", `${input.device.name} is offline: KOS Device is not running on it, or cannot reach KOS`);
    const missing = missingPermissions(link.state?.permissions);
    if (missing) throw new DeviceError("permission", `${input.device.name} has not granted ${missing} to KOS Device yet`);
    const other = [...this.sessions.values()].find((s) => s.device === input.device.id);
    if (other) throw new DeviceError("busy", `${input.device.name} is in use by another chat`);

    const id = `ses_${randomBytes(9).toString("base64url")}`;
    const minutes = Math.max(1, Math.min(MAX_MINUTES, Math.round(input.minutes)));
    const result = await link.call(
      "session.begin",
      // The chat's id lets the device link the owner straight to the chat that is asking.
      { session: id, task: input.task, requester: input.requester, conversation: input.conversation, minutes, ...(input.maxEdge ? { maxEdge: input.maxEdge } : {}) },
      this.deps.beginTimeoutMs ?? BEGIN_TIMEOUT_MS,
    );
    const grant = readGrant(result);
    if (!grant) throw new DeviceError("denied", "the owner did not allow it on the device");
    const session: Session = {
      id,
      device: input.device.id,
      conversation: input.conversation,
      task: input.task,
      until: grant.until,
      space: grant.space,
      paused: false,
      startedAt: this.now(),
    };
    this.sessions.set(id, session);
    this.endings.delete(input.conversation);
    this.changed();
    return session;
  }

  /** Something done in the conversation's session; the device's result. */
  async act(conversation: string, method: Exclude<Method, "session.begin" | "session.end">, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.deps.halted()) {
      this.endAll("host");
      throw new DeviceError("halted", "KOS is halted by the kill switch");
    }
    const session = this.sessionOf(conversation);
    if (!session) throw new DeviceError("no_session", "no session");
    if (session.paused) throw new DeviceError("paused", "the owner has taken over");
    const link = this.links.get(session.device);
    if (!link?.ready) {
      this.drop(session, "offline");
      throw new DeviceError("offline", "the device went offline");
    }
    try {
      return await link.call(method, { ...params, session: session.id }, this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof DeviceError && err.code === "no_session") this.drop(session, "host");
      if (err instanceof DeviceError && err.code === "paused") session.paused = true;
      throw err;
    }
  }

  /** End a session here and tell the device, without waiting on it: the overlay goes as soon as it hears. */
  private release(session: Session, why: EndReason): void {
    this.drop(session, why);
    void this.links.get(session.device)?.call("session.end", { session: session.id }, 5_000).catch(() => undefined);
  }

  /** The conversation giving its computer back. */
  end(conversation: string): boolean {
    const session = this.sessionOf(conversation);
    if (!session) return false;
    this.release(session, "host");
    this.changed();
    return true;
  }

  /** The owner stopping a device's session from the dashboard. */
  stopOn(deviceId: string): boolean {
    const session = [...this.sessions.values()].find((s) => s.device === deviceId);
    if (!session) return false;
    this.release(session, "owner");
    this.changed();
    return true;
  }

  /** End every session: the kill switch, or the module switched off. */
  endAll(reason: EndReason): void {
    for (const session of [...this.sessions.values()]) this.release(session, reason);
    this.changed();
  }

  rename(id: string, name: string): DeviceStatus | undefined {
    const device = this.deps.store.rename(id, name);
    this.changed();
    return device ? this.statusOf(device) : undefined;
  }

  /** Unpair: the key is forgotten and a live connection is closed as unknown. */
  remove(id: string): boolean {
    const removed = this.deps.store.remove(id);
    for (const s of [...this.sessions.values()]) if (s.device === id) this.drop(s, "removed");
    this.links.get(id)?.close(CLOSE.unauthorized, "removed from KOS");
    this.links.delete(id);
    this.changed();
    return removed;
  }

  /** Close every connection, for a host shutting down. */
  closeAll(): void {
    this.endAll("host");
    for (const link of this.links.values()) link.close(1001, "KOS is stopping");
    this.links.clear();
  }

  get paired(): number {
    return this.deps.store.list().length;
  }
}

function missingPermissions(p: Permissions | undefined): string | undefined {
  if (!p) return "Screen Recording and Accessibility";
  if (!p.screen && !p.input) return "Screen Recording and Accessibility";
  if (!p.screen) return "Screen Recording";
  if (!p.input) return "Accessibility";
  return undefined;
}

function readGrant(result: Record<string, unknown>): Grant | undefined {
  const space = result.space as Record<string, unknown> | undefined;
  if (result.granted !== true || typeof result.until !== "number" || typeof space?.width !== "number" || typeof space.height !== "number") return undefined;
  return { granted: true, until: result.until, space: { width: space.width, height: space.height } };
}

function endReason(v: unknown): EndReason {
  return v === "owner" || v === "expired" || v === "idle" || v === "quit" ? v : "host";
}

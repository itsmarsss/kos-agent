import { randomBytes } from "node:crypto";

import type { FaceDrawing } from "@kos/shared";

import { publicKeyFromRaw, type HostKey } from "./keys.js";
import { DeviceError, DeviceLink, type Refusal, type Socket } from "./link.js";
import { PairingCodes, type PairingCode } from "./pairing.js";
import { BROWSER_PLATFORM, CLOSE, PROTOCOL_VERSION, type Consent, type DeviceEvent, type EndReason, type Grant, type Method, type PanelMethod, type Permissions, type Size, type Target } from "./protocol.js";
import { MAX_ASK_MINUTES, type ComputerSettings, type Device, type DeviceStore } from "./store.js";

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
  /** What the owner shared: the screen, or one window. */
  target: Target;
  paused: boolean;
  startedAt: number;
  /** The site the owner let this session act on without asking each step, when they did. */
  site?: string;
}

/** A paired device as the dashboard and the agent are told of it. */
export interface DeviceStatus {
  id: string;
  name: string;
  platform: string;
  kind: DeviceKind;
  pairedAt: number;
  lastSeen: number | null;
  online: boolean;
  consent?: Consent;
  permissions?: Permissions;
  version?: string;
  os?: string;
  /** The live session on it, when there is one. */
  session?: { conversation: string; task: string; until: number; paused: boolean; target: Target };
}

export interface HubDeps {
  store: DeviceStore;
  hostKey: HostKey;
  /** True while KOS's kill switch is thrown: nothing starts. */
  halted: () => boolean;
  /** KOS's face as the owner set it, for every device to draw KOS by. */
  face?: () => FaceDrawing;
  now?: () => number;
  /** Where the hub writes what the owner may need to read in the host's log; the console's error stream unless given. */
  log?: (line: string) => void;
  /** How long the owner has to answer on the device, plus the trip. */
  beginTimeoutMs?: number;
  callTimeoutMs?: number;
  /** How long an action waits for the owner to hand a session back. */
  handBackWaitMs?: number;
}

/** A computer running KOS for Mac, or a Chrome running KOS for Chrome. */
export type DeviceKind = "computer" | "browser";

export function kindOf(device: { platform: string }): DeviceKind {
  return device.platform === BROWSER_PLATFORM ? "browser" : "computer";
}

/** Told of what a device says beyond its sessions' lives: a browser's page events, tabs closed or handed. */
export type DeviceListener = (device: string, event: DeviceEvent, session: Session | undefined) => void;

export class PairError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The device may wait up to five minutes for the owner, as they set it there.
const BEGIN_TIMEOUT_MS = 315_000;
const CALL_TIMEOUT_MS = 20_000;
const PANEL_TIMEOUT_MS = 10_000;
/** How long KOS waits for the owner to hand back a session they took over, on any device. */
export const HAND_BACK_WAIT_MS = 5 * 60_000;
/** A device refused again and again is logged once in this long. */
const REFUSAL_LOG_MS = 60_000;
const MAX_REFUSALS_LOGGED = 100;

/** What a device claimed, safe for a log line: one line, printable, short. */
const loggable = (text: string, max = 64): string => text.replace(/[^\x20-\x7e]/g, "?").slice(0, max);

export class DeviceHub {
  readonly codes: PairingCodes;
  private readonly links = new Map<string, DeviceLink>();
  private readonly sessions = new Map<string, Session>();
  /** Why a conversation's last session ended, so its next call can say so. */
  private readonly endings = new Map<string, EndReason | "offline" | "removed">();
  private readonly listeners = new Set<() => void>();
  private readonly deviceListeners = new Set<DeviceListener>();
  private readonly endListeners = new Set<(session: Session, why: EndReason | "offline" | "removed") => void>();
  /** Sessions being asked for on a device, by conversation: withdrawn by Stop. */
  private readonly asks = new Map<string, { device: string; session: string; withdraw: () => void }>();
  /** When each refused device id was last logged, for each check it failed. */
  private readonly refusalsLogged = new Map<string, number>();

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

  /** Told of each session that ends, and why. */
  onEnded(listener: (session: Session, why: EndReason | "offline" | "removed") => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /** Told of each event a device sends that is not about a session's life. */
  onDeviceEvent(listener: DeviceListener): () => void {
    this.deviceListeners.add(listener);
    return () => this.deviceListeners.delete(listener);
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
      onUnpair: (link) => void this.remove(link.device!.id),
      onClose: (link) => this.gone(link),
      onRefused: (refusal) => this.refused(refusal),
    });
  }

  /** A hello turned away, said in the host's log once a minute per device id and check, so a device that cannot get in is not silent. */
  private refused({ device, app, check }: Refusal): void {
    const now = this.now();
    for (const [id, at] of this.refusalsLogged) if (now - at >= REFUSAL_LOG_MS) this.refusalsLogged.delete(id);
    // Many ids at once is a flood, not a device to diagnose: the first ones said are enough.
    const key = `${device}\n${check}`;
    if (this.refusalsLogged.has(key) || this.refusalsLogged.size >= MAX_REFUSALS_LOGGED) return;
    this.refusalsLogged.set(key, now);
    const line = `devices: refused ${loggable(device)} (${loggable(app.platform, 20)} ${loggable(app.version, 20)} on ${loggable(app.os, 40)}): ${check}`;
    (this.deps.log ?? ((l: string) => console.error(l)))(line);
  }

  private ready(link: DeviceLink): void {
    const id = link.device!.id;
    const older = this.links.get(id);
    this.links.set(id, link);
    // The newer connection wins: the old one is a laptop that slept and woke.
    older?.close(CLOSE.replaced, "replaced by a newer connection");
    this.deps.store.seen(id);
    this.showFace(link);
    this.changed();
  }

  /** KOS's face changed: every device online draws the new one. */
  tellFace(): void {
    for (const link of this.links.values()) this.showFace(link);
  }

  private showFace(link: DeviceLink): void {
    const face = this.deps.face?.();
    if (face) link.tell({ t: "face", face });
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
    const device = link.device?.id;
    if (!device) return;
    const named = typeof event.data.session === "string" ? this.sessions.get(event.data.session) : undefined;
    const session = named?.device === device ? named : undefined;
    if (!event.name.startsWith("session.")) {
      for (const l of this.deviceListeners) l(device, event, session);
      return;
    }
    if (!session) return;
    if (event.name === "session.paused") session.paused = true;
    else if (event.name === "session.resumed") session.paused = false;
    // The owner gave it more time on the device.
    else if (event.name === "session.extended" && typeof event.data.until === "number" && event.data.until > session.until) session.until = event.data.until;
    else if (event.name === "session.ended") this.drop(session, endReason(event.data.reason));
    this.changed();
  }

  private drop(session: Session, why: EndReason | "offline" | "removed"): void {
    if (!this.sessions.delete(session.id)) return;
    this.endings.set(session.conversation, why);
    for (const l of [...this.endListeners]) l(session, why);
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
      kind: kindOf(d),
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      online: link?.ready === true,
      ...(link?.state ? { consent: link.state.consent, permissions: link.state.permissions } : {}),
      ...(link?.app ? { version: link.app.version, os: link.app.os } : {}),
      ...(session ? { session: { conversation: session.conversation, task: session.task, until: session.until, paused: session.paused, target: session.target } } : {}),
    };
  }

  /**
   * The device a name or id means: the id, else the name exactly, else the
   * one name containing it. Where several fit, the one online is meant, since
   * an offline one could not be used anyway; nothing named means the one
   * online, or the only one there is.
   */
  find(nameOrId: string | undefined, kind?: DeviceKind): Device | undefined {
    const devices = this.deps.store.list().filter((d) => !kind || kindOf(d) === kind);
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

  /**
   * A session asked of the owner on the device. `app`, when given, is the
   * app KOS would work in: the owner sees its window offered first. Once
   * `signal` aborts (the owner pressed Stop in the chat that asks), or the
   * ask is withdrawn, it is answered at once as stopped, the device is told
   * to take the prompt down, and a yes given after that is given back on
   * the device straight away: nobody is left to use it.
   */
  async begin(input: { conversation: string; device: Device; task: string; requester: string; minutes: number; app?: string; maxEdge?: number; signal?: AbortSignal }): Promise<Session> {
    if (input.signal?.aborted) throw new DeviceError("stopped", "the owner pressed Stop before the session was asked for");
    if (this.deps.halted()) throw new DeviceError("halted", "KOS is halted by the kill switch");
    const held = this.sessionOf(input.conversation);
    if (held) {
      if (held.device === input.device.id) return held;
      throw new DeviceError("busy", "this chat already has a session on another device; end it first");
    }
    const link = this.links.get(input.device.id);
    if (!link?.ready) throw new DeviceError("offline", `${input.device.name} is offline: KOS for Mac is not running on it, or cannot reach KOS`);
    const browser = kindOf(input.device) === "browser";
    const missing = browser ? undefined : missingPermissions(link.state?.permissions);
    if (missing) throw new DeviceError("permission", `${input.device.name} has not granted ${missing} to KOS for Mac yet`);
    const other = [...this.sessions.values()].find((s) => s.device === input.device.id);
    if (other) throw new DeviceError("busy", `${input.device.name} is in use by another chat`);
    if (this.asks.has(input.conversation)) throw new DeviceError("busy", "this chat is already asking the owner for a session");

    const id = `ses_${randomBytes(9).toString("base64url")}`;
    const minutes = Math.max(1, Math.min(MAX_ASK_MINUTES, Math.round(input.minutes)));
    const asked = link.call(
      "session.begin",
      // The chat's id lets the device link the owner straight to the chat that is asking.
      {
        session: id, task: input.task, requester: input.requester, conversation: input.conversation, minutes,
        ...(input.app ? { target: { app: input.app } } : {}),
        ...(input.maxEdge ? { maxEdge: input.maxEdge } : {}),
      },
      this.deps.beginTimeoutMs ?? BEGIN_TIMEOUT_MS,
    );
    const giveBack = (): void => void link.call("session.end", { session: id }, 5_000).catch(() => undefined);
    // Stopped or withdrawn: the device takes its prompt down, and the ask is answered here at once.
    const stop = new AbortController();
    const onAbort = (): void => stop.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    stop.signal.addEventListener("abort", giveBack, { once: true });
    this.asks.set(input.conversation, { device: input.device.id, session: id, withdraw: () => stop.abort() });
    this.changed();
    const readOf = (result: Record<string, unknown>): Grant | undefined => (browser ? readBrowserGrant(result) : readGrant(result));
    let result: Record<string, unknown>;
    try {
      result = await untilStopped(asked, stop.signal, (late) => {
        if (readOf(late)) giveBack();
      });
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      this.asks.delete(input.conversation);
      this.changed();
    }
    const grant = readOf(result);
    if (!grant) {
      if (result.reason === "unanswered") throw new DeviceError("unanswered", "the owner did not answer the ask on the device in time");
      throw new DeviceError("denied", "the owner did not allow it on the device");
    }
    const session: Session = {
      id,
      device: input.device.id,
      conversation: input.conversation,
      task: input.task,
      until: grant.until,
      space: grant.space,
      target: grant.target,
      paused: false,
      startedAt: this.now(),
      ...(grant.site ? { site: grant.site } : {}),
    };
    this.sessions.set(id, session);
    this.endings.delete(input.conversation);
    this.changed();
    return session;
  }

  /** Whether the owner is being asked, on a device, for a session for this conversation. */
  asking(conversation: string): boolean {
    return this.asks.has(conversation);
  }

  /** Take down the conversation's ask on its device: answered as stopped here, the prompt withdrawn there. */
  withdraw(conversation: string): boolean {
    const ask = this.asks.get(conversation);
    ask?.withdraw();
    return ask !== undefined;
  }

  /**
   * Until the owner hands the conversation's session back: at once when they
   * have not taken it over. True when it waited. A wait the owner does not
   * end in time is refused as `held`; the session ending, as `no_session`;
   * Stop, as `stopped`.
   */
  untilHandedBack(conversation: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.sessionOf(conversation)?.paused) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const done = (err?: DeviceError): void => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", stopped);
        if (err) reject(err);
        else resolve(true);
      };
      const stopped = (): void => done(new DeviceError("stopped", "the owner pressed Stop while they had control"));
      const timer = setTimeout(() => done(new DeviceError("held", "the owner kept control and did not hand it back")), this.deps.handBackWaitMs ?? HAND_BACK_WAIT_MS);
      const off = this.onChange(() => {
        const session = this.sessionOf(conversation);
        if (!session) done(new DeviceError("no_session", "the session ended while the owner had control"));
        else if (!session.paused) done();
      });
      signal?.addEventListener("abort", stopped, { once: true });
      if (signal?.aborted) stopped();
    });
  }

  /** Something done in the conversation's session; the device's result. */
  async act(conversation: string, method: Exclude<Method, "session.begin" | "session.end" | PanelMethod>, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
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
      return await link.call(method, { ...params, session: session.id }, timeoutMs ?? this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof DeviceError && err.code === "no_session") this.drop(session, "host");
      if (err instanceof DeviceError && err.code === "paused") session.paused = true;
      throw err;
    }
  }

  /**
   * A call to a Chrome outside any session: its side panel's chat, and the
   * page beside it. The device's answer, or its refusal; offline when it is
   * not on.
   */
  async request(deviceId: string, method: PanelMethod, params: Record<string, unknown>, timeoutMs = PANEL_TIMEOUT_MS): Promise<Record<string, unknown>> {
    // Showing the chat goes on under the kill switch; reading a page does not.
    if (method === "page.read" && this.deps.halted()) throw new DeviceError("halted", "KOS is halted by the kill switch");
    const link = this.links.get(deviceId);
    if (!link?.ready) throw new DeviceError("offline", "that Chrome is not connected to KOS");
    return link.call(method, params, timeoutMs);
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

  settings(): ComputerSettings {
    return this.deps.store.settings();
  }

  updateSettings(patch: Partial<ComputerSettings>): ComputerSettings {
    const next = this.deps.store.setSettings(patch);
    this.changed();
    return next;
  }
}

function missingPermissions(p: Permissions | undefined): string | undefined {
  if (!p) return "Screen Recording and Accessibility";
  if (!p.screen && !p.input) return "Screen Recording and Accessibility";
  if (!p.screen) return "Screen Recording";
  if (!p.input) return "Accessibility";
  return undefined;
}

/**
 * The device's answer, or a stop the moment the signal aborts. An answer
 * that comes after the stop goes to `late`, so a session granted then can
 * be given back.
 */
function untilStopped(asked: Promise<Record<string, unknown>>, signal: AbortSignal, late: (result: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new DeviceError("stopped", "the owner pressed Stop before the session was allowed"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    asked.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) late(result);
        else resolve(result);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** A browser's grant: its time, and no screen; what it shares is its tabs. */
function readBrowserGrant(result: Record<string, unknown>): Grant | undefined {
  if (result.granted !== true || typeof result.until !== "number") return undefined;
  const site = typeof result.auto === "object" && result.auto !== null ? (result.auto as Record<string, unknown>).site : undefined;
  return { granted: true, until: result.until, space: { width: 0, height: 0 }, target: { kind: "tabs" }, ...(typeof site === "string" && site ? { site } : {}) };
}

function readGrant(result: Record<string, unknown>): Grant | undefined {
  const space = result.space as Record<string, unknown> | undefined;
  if (result.granted !== true || typeof result.until !== "number" || typeof space?.width !== "number" || typeof space.height !== "number") return undefined;
  return { granted: true, until: result.until, space: { width: space.width, height: space.height }, target: readTarget(result.target) };
}

/** What the device says it shared; a device that does not say shared the screen. */
function readTarget(v: unknown): Target {
  const t = (v ?? {}) as Record<string, unknown>;
  if (t.kind !== "window") return { kind: "screen" };
  return { kind: "window", ...(typeof t.app === "string" ? { app: t.app } : {}), ...(typeof t.title === "string" ? { title: t.title } : {}) };
}

function endReason(v: unknown): EndReason {
  return v === "owner" || v === "expired" || v === "idle" || v === "quit" || v === "window" || v === "detached" ? v : "host";
}

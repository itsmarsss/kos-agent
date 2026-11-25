import type { ApprovalRequest } from "@kos/harness";

import { ApnsClient, DEVICE_TOKEN_RE, readP8, type ApnsAnswer, type ApnsCredentials, type ApnsPush, type ApnsSender } from "./apns.js";
import { kindOf, loggable, type DeviceHub } from "./hub.js";
import { approvalOf } from "./panel.js";
import type { DeviceStore, PushEnv, PushSettings } from "./store.js";

/**
 * Asks pushed to the owner's iPhones, for a phone whose app is not open:
 * one notification per new ask on each paired phone that gave KOS a token,
 * Approve and Deny on it, and a quiet withdrawal once the ask is settled
 * anywhere. The decision comes back over the phone's own proved line as
 * `chat.decide`, so it is decided as any phone's is; nothing is decided here.
 *
 * Switched on by an APNs key (docs/computer.md, Push): from the host's
 * environment, or from Settings with the .p8 itself in the vault. Without
 * one nothing is sent, and Settings says so.
 */

/** The event a phone gives its token with, or takes it back with (no token). */
export const PUSH_TOKEN_EVENT = "push.token";

/**
 * The notification categories KOS for iPhone registers: an ask to approve or
 * deny, and one to deny or open only: too long to approve unseen, or one that
 * runs for no waiting turn, whose warning is read on its card first.
 */
export const ASK_CATEGORY = "kos.ask";
export const ASK_OPEN_CATEGORY = "kos.ask.open";

const TITLE_MAX = 60;
const BODY_MAX = 180;
/** Asks pushed and not yet settled, remembered for their withdrawal; past this the oldest go unwithdrawn. */
const SENT_KEPT = 200;

/** The key as the host's environment gives it (`KOS_APNS_*`), read once at start. */
export interface ApnsEnv {
  key?: string;
  keyId?: string;
  teamId?: string;
  topic?: string;
  /** `KOS_APNS_KEY_FILE` named a file KOS could not read. */
  unreadable?: string;
}

/** Where push stands: on with credentials from one place, or off, with what is wrong when something is. */
export type PushConfig =
  | { state: "on"; source: "env" | "settings"; credentials: ApnsCredentials }
  | { state: "off"; source?: "env" | "settings"; problem?: string };

/** The `KOS_APNS_*` names, the key read from `KOS_APNS_KEY_FILE` when it names one. Nothing set is none. */
export function readApnsEnv(env: NodeJS.ProcessEnv, readFile: (path: string) => string): ApnsEnv | undefined {
  const file = env.KOS_APNS_KEY_FILE?.trim();
  let key = env.KOS_APNS_KEY?.trim();
  let unreadable: string | undefined;
  if (file) {
    try {
      key = readFile(file);
    } catch {
      unreadable = file;
    }
  }
  const out: ApnsEnv = {
    ...(key ? { key } : {}),
    ...(unreadable ? { unreadable } : {}),
    ...(env.KOS_APNS_KEY_ID?.trim() ? { keyId: env.KOS_APNS_KEY_ID.trim() } : {}),
    ...(env.KOS_APNS_TEAM_ID?.trim() ? { teamId: env.KOS_APNS_TEAM_ID.trim() } : {}),
    ...(env.KOS_APNS_TOPIC?.trim() ? { topic: env.KOS_APNS_TOPIC.trim() } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

const KEY_ID_RE = /^[A-Z0-9]{10}$/;
const TOPIC_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const PUSH_SETTING_RE: Readonly<Record<keyof PushSettings, RegExp>> = {
  keyId: KEY_ID_RE,
  teamId: KEY_ID_RE,
  topic: TOPIC_RE,
  secret: /^[a-z0-9][a-z0-9_-]{0,79}$/,
};

/**
 * The credentials push runs on: the environment's when it names any of
 * them (all four, or it says what is missing), else Settings', the key read
 * from the vault secret it names. `secret` reads a vault secret's main field.
 */
export function pushConfig(env: ApnsEnv | undefined, settings: PushSettings, secret: (handle: string) => string | undefined): PushConfig {
  const from = env ? "env" : "settings";
  const given = env ? { key: env.key, keyId: env.keyId, teamId: env.teamId, topic: env.topic } : undefined;
  const fields = given ?? { key: settings.secret, keyId: settings.keyId, teamId: settings.teamId, topic: settings.topic };
  if (!Object.values(fields).some(Boolean) && !env?.unreadable) return { state: "off" };
  if (env?.unreadable) return { state: "off", source: from, problem: `KOS can't read the APNs key at ${env.unreadable}.` };
  const names = env
    ? { key: "KOS_APNS_KEY_FILE or KOS_APNS_KEY", keyId: "KOS_APNS_KEY_ID", teamId: "KOS_APNS_TEAM_ID", topic: "KOS_APNS_TOPIC" }
    : { key: "the key's secret", keyId: "the key ID", teamId: "the team ID", topic: "the bundle ID" };
  const missing = (Object.keys(names) as (keyof typeof names)[]).filter((k) => !fields[k]).map((k) => names[k]);
  if (missing.length) return { state: "off", source: from, problem: `Push needs ${missing.join(", ")}.` };
  if (!KEY_ID_RE.test(fields.keyId!)) return { state: "off", source: from, problem: "The key ID is the 10 letters and digits Apple shows beside the key." };
  if (!KEY_ID_RE.test(fields.teamId!)) return { state: "off", source: from, problem: "The team ID is the 10 letters and digits of your Apple developer team." };
  if (!TOPIC_RE.test(fields.topic!)) return { state: "off", source: from, problem: "The bundle ID is the app's, such as com.you.kos-phone." };
  const text = env ? fields.key : secret(fields.key!);
  if (!text) return { state: "off", source: from, problem: `The secret ${fields.key} does not read: is the vault open, and is it there?` };
  try {
    return { state: "on", source: from, credentials: { key: readP8(text), keyId: fields.keyId!, teamId: fields.teamId!, topic: fields.topic! } };
  } catch (err) {
    return { state: "off", source: from, problem: `The APNs key ${env ? "in the environment" : `in ${fields.key}`} is ${err instanceof Error ? err.message : "not a key"}.` };
  }
}

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/**
 * An ask as its notification: who asks, and the card's own line (askView's
 * title, as the dashboard's card is titled), scrubbed of every secret value
 * and cut short. No arguments, no steps, no page content: the phone opens
 * the ask for those. An ask that runs for no waiting turn says so under its
 * line and is not approved from the notification. It lapses from APNs with
 * the ask, and one of the same ask replaces it on the phone.
 */
export function askPush(req: ApprovalRequest, scrub: (text: string) => string): Omit<ApnsPush, "token" | "env"> {
  const card = approvalOf(req);
  const line = typeof card.title === "string" ? card.title : typeof card.summary === "string" ? card.summary : (req.tool ?? "An ask");
  const asker = typeof card.asker === "string" ? card.asker : "KOS";
  const expires = req.expiresAt !== undefined ? Math.ceil(req.expiresAt / 1000) : 0;
  // The host's own words, kept whole under a line cut to leave them room.
  const warning = typeof card.detached === "string" ? clip(card.detached, BODY_MAX / 2) : undefined;
  const body = warning ? `${clip(scrub(line), BODY_MAX - warning.length - 1)}\n${warning}` : clip(scrub(line), BODY_MAX);
  return {
    headers: { "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": collapseId(req.id), "apns-expiration": String(expires) },
    payload: {
      aps: {
        alert: { title: clip(scrub(`${asker} asks`), TITLE_MAX), body },
        sound: "default",
        category: card.tooLong === true || warning ? ASK_OPEN_CATEGORY : ASK_CATEGORY,
        "thread-id": "kos.asks",
      },
      kos: { ask: req.id },
    },
  };
}

/** The ask settled: a background push the phone takes its notification down on. Low priority, as Apple asks of these. */
export function settledPush(id: string): Omit<ApnsPush, "token" | "env"> {
  return {
    headers: { "apns-push-type": "background", "apns-priority": "5" },
    payload: { aps: { "content-available": 1 }, kos: { settled: id } },
  };
}

/** The notification's id on the phone: APNs makes the collapse id the request's identifier, so the phone takes it down by it. */
export const collapseId = (ask: string): string => `kos.ask.${ask}`.slice(0, 64);

export interface PhonePushDeps {
  store: DeviceStore;
  hub: Pick<DeviceHub, "onDeviceEvent">;
  /** Where push stands now, read at each send: Settings and the vault may have changed. */
  config(): PushConfig;
  scrub(text: string): string;
  sender?: ApnsSender;
  log?(line: string): void;
}

/** Push for one phone, as Settings shows it. */
export interface PhonePushStatus {
  on: boolean;
  env?: PushEnv;
}

export class PhonePush {
  private readonly sender: ApnsSender;
  /** The phones each pushed ask went to, for its withdrawal. */
  private readonly sent = new Map<string, string[]>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: PhonePushDeps) {
    this.sender = deps.sender ?? new ApnsClient();
    this.log = deps.log ?? ((line) => console.error(line));
    deps.hub.onDeviceEvent((device, event) => {
      if (event.name === PUSH_TOKEN_EVENT) this.tokenFrom(device, event.data);
    });
  }

  /** Where push stands for Settings: on or off, from where, what is wrong; never a value. */
  status(): { configured: boolean; source?: "env" | "settings"; problem?: string; settings: PushSettings } {
    const config = this.deps.config();
    return {
      configured: config.state === "on",
      ...(config.source ? { source: config.source } : {}),
      ...(config.state === "off" && config.problem ? { problem: config.problem } : {}),
      settings: this.deps.store.pushSettings(),
    };
  }

  /** The owner's key, as Settings names it, changed; where push stands then. */
  save(patch: Partial<PushSettings>): ReturnType<PhonePush["status"]> {
    this.deps.store.setPushSettings(patch);
    return this.status();
  }

  of(device: string): PhonePushStatus {
    const target = this.deps.store.push(device);
    return target ? { on: true, env: target.env } : { on: false };
  }

  /** A new ask: one notification on each phone that has a token, when push is on. */
  async asked(req: ApprovalRequest): Promise<void> {
    const targets = this.deps.store.pushes();
    if (!targets.length) return;
    const config = this.deps.config();
    if (config.state !== "on") return;
    const push = askPush(req, this.deps.scrub);
    const reached = await this.each(config.credentials, targets, push, `ask ${loggable(req.id)}`);
    if (!reached.length) return;
    this.sent.set(req.id, reached);
    while (this.sent.size > SENT_KEPT) this.sent.delete(this.sent.keys().next().value!);
  }

  /** The ask settled, here or anywhere: the phones it was pushed to take it down. */
  async settled(id: string): Promise<void> {
    const devices = this.sent.get(id);
    if (!devices) return;
    this.sent.delete(id);
    const config = this.deps.config();
    if (config.state !== "on") return;
    const targets = this.deps.store.pushes().filter((t) => devices.includes(t.device));
    await this.each(config.credentials, targets, settledPush(id), `withdrawal of ask ${loggable(id)}`);
  }

  close(): void {
    this.sender.close();
  }

  /** One push to each phone; the phones it reached. A token APNs no longer takes is dropped. */
  private async each(credentials: ApnsCredentials, targets: ReturnType<DeviceStore["pushes"]>, push: Omit<ApnsPush, "token" | "env">, what: string): Promise<string[]> {
    const answers = await Promise.all(
      targets.map(async (t) => [t, await this.sender.send(credentials, { ...push, token: t.token, env: t.env }).catch((err: unknown): ApnsAnswer => ({ status: 0, reason: err instanceof Error ? err.message : String(err) }))] as const),
    );
    const reached: string[] = [];
    for (const [target, answer] of answers) {
      if (answer.status === 200) {
        reached.push(target.device);
        continue;
      }
      const name = this.deps.store.get(target.device)?.name ?? target.device;
      this.log(`push: ${what} to ${loggable(name)} not sent: ${answer.status || "no answer"}${answer.reason ? ` ${loggable(answer.reason)}` : ""}`);
      // The phone gives its token again on its next line: one dropped by mistake comes back.
      if (answer.status === 410 || answer.reason === "BadDeviceToken" || answer.reason === "Unregistered") this.deps.store.clearPush(target.device);
    }
    return reached;
  }

  /** A phone gave its token, or took it back. Only a paired phone's is kept. */
  private tokenFrom(device: string, data: Record<string, unknown>): void {
    const paired = this.deps.store.get(device);
    if (!paired || kindOf(paired) !== "phone") return;
    const token = typeof data.token === "string" ? data.token.toLowerCase() : undefined;
    const env = data.env === "sandbox" || data.env === "production" ? data.env : undefined;
    if (token === undefined) {
      if (this.deps.store.push(device)) this.log(`push: ${loggable(paired.name)} turned its notifications off`);
      this.deps.store.clearPush(device);
      return;
    }
    if (!DEVICE_TOKEN_RE.test(token) || !env) return;
    const before = this.deps.store.push(device);
    this.deps.store.setPush(device, token, env);
    if (before?.token !== token || before.env !== env) this.log(`push: ${loggable(paired.name)} gave KOS its token (${env})`);
  }
}

import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";

import type { PushEnv } from "./store.js";

/**
 * Apple's push service, as KOS speaks to it: token-based auth (a .p8 key,
 * its id and the team's), a JWT signed ES256 and kept under the hour Apple
 * allows, and HTTP/2 to the gateway a phone's token is good on. Nothing
 * here logs or returns the key, the JWT or a device's token.
 */

export const APNS_ORIGINS: Readonly<Record<PushEnv, string>> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** How long a provider token is used before a new one is signed: Apple refuses one older than an hour, and one made more often than every twenty minutes. */
export const JWT_REFRESH_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ApnsCredentials {
  key: KeyObject;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
}

/** One push to one phone: the headers beyond auth and topic, and the JSON body. */
export interface ApnsPush {
  token: string;
  env: PushEnv;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

/** What APNs answered: its status and, for a refusal, its reason (`BadDeviceToken`, `Unregistered`, `ExpiredProviderToken`). */
export interface ApnsAnswer {
  status: number;
  reason?: string;
}

export interface ApnsSender {
  send(credentials: ApnsCredentials, push: ApnsPush): Promise<ApnsAnswer>;
  close(): void;
}

/** A device token as an iPhone gives it: hex, 32 bytes today, room for Apple to make it longer. */
export const DEVICE_TOKEN_RE = /^[0-9a-f]{64,200}$/;

/**
 * The .p8 key Apple hands out, as PEM, with or without its line breaks (a
 * secret's field may have lost them), or its base64 alone. Refused unless it
 * is the EC P-256 key APNs signs with.
 */
export function readP8(text: string): KeyObject {
  const body = text.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error("not a .p8 key");
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(body, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("not a .p8 key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("not an APNs key: APNs keys are EC P-256");
  return key;
}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** The JWT's first two parts, as Apple specifies them: `{alg, kid}` and `{iss, iat}`, iat in seconds. */
export function jwtSigningInput(keyId: string, teamId: string, iat: number): string {
  return `${b64url(JSON.stringify({ alg: "ES256", kid: keyId }))}.${b64url(JSON.stringify({ iss: teamId, iat }))}`;
}

/** A provider token: the signing input signed ES256, the signature as JOSE wants it (r and s, 32 bytes each). */
export function apnsJwt(credentials: Pick<ApnsCredentials, "key" | "keyId" | "teamId">, iat: number): string {
  const input = jwtSigningInput(credentials.keyId, credentials.teamId, iat);
  const signature = sign("sha256", Buffer.from(input), { key: credentials.key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(signature)}`;
}

/** The provider token in use, signed again when it nears the hour or the credentials change, or when APNs refused it. */
export class ProviderToken {
  private held: { jwt: string; at: number; of: string } | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  get(credentials: ApnsCredentials): string {
    const of = `${credentials.keyId}|${credentials.teamId}|${fingerprint(credentials.key)}`;
    const now = this.now();
    if (this.held && this.held.of === of && now - this.held.at < JWT_REFRESH_MS) return this.held.jwt;
    const jwt = apnsJwt(credentials, Math.floor(now / 1000));
    this.held = { jwt, at: now, of };
    return jwt;
  }

  /** APNs said the token was expired or invalid: the next push signs a new one. */
  drop(): void {
    this.held = undefined;
  }
}

function fingerprint(key: KeyObject): string {
  return createHash("sha256").update(key.export({ format: "der", type: "pkcs8" })).digest("hex");
}

export interface ApnsClientOptions {
  /** Where each gateway is; Apple's unless a test says otherwise. */
  origins?: Partial<Record<PushEnv, string>>;
  timeoutMs?: number;
  now?: () => number;
}

/** HTTP/2 to APNs: one session per gateway, kept while it lasts, never keeping KOS up. */
export class ApnsClient implements ApnsSender {
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private readonly tokens: ProviderToken;

  constructor(private readonly options: ApnsClientOptions = {}) {
    this.tokens = new ProviderToken(options.now);
  }

  async send(credentials: ApnsCredentials, push: ApnsPush): Promise<ApnsAnswer> {
    if (!DEVICE_TOKEN_RE.test(push.token)) return { status: 400, reason: "BadDeviceToken" };
    const answer = await this.request(this.originOf(push.env), {
      ":method": "POST",
      ":path": `/3/device/${push.token}`,
      authorization: `bearer ${this.tokens.get(credentials)}`,
      "apns-topic": credentials.topic,
      "content-type": "application/json",
      ...push.headers,
    }, JSON.stringify(push.payload));
    if (answer.status === 403 && (answer.reason === "ExpiredProviderToken" || answer.reason === "InvalidProviderToken")) this.tokens.drop();
    return answer;
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private originOf(env: PushEnv): string {
    return this.options.origins?.[env] ?? APNS_ORIGINS[env];
  }

  private session(origin: string): ClientHttp2Session {
    const open = this.sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(origin);
    const forget = (): void => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on("error", forget);
    session.on("goaway", forget);
    session.on("close", forget);
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  private request(origin: string, headers: Record<string, string>, body: string): Promise<ApnsAnswer> {
    return new Promise((resolve) => {
      let session: ClientHttp2Session;
      try {
        session = this.session(origin);
      } catch (err) {
        resolve({ status: 0, reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      const stream = session.request(headers);
      let status = 0;
      let text = "";
      let done = false;
      const finish = (answer: ApnsAnswer): void => {
        if (done) return;
        done = true;
        resolve(answer);
      };
      stream.setEncoding("utf8");
      stream.setTimeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
        stream.close(constants.NGHTTP2_CANCEL);
        finish({ status: 0, reason: "timed out" });
      });
      stream.on("response", (h) => (status = Number(h[":status"] ?? 0)));
      stream.on("data", (chunk: string) => (text += chunk.slice(0, 4096 - text.length)));
      stream.on("end", () => {
        const reason = reasonOf(text);
        finish({ status, ...(reason ? { reason } : {}) });
      });
      stream.on("error", (err) => finish({ status: 0, reason: err.message }));
      stream.end(body);
    });
  }
}

/** APNs' reason, from the JSON it answers a refusal with. */
function reasonOf(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const reason = (JSON.parse(text) as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

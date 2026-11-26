import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { openDatabase, type ApprovalRequest } from "@kos/harness";
import { DETACHED_WORDS } from "@kos/shared";

import { readP8, type ApnsAnswer, type ApnsCredentials, type ApnsPush, type ApnsSender } from "./apns.js";
import { FakeDevice } from "./device.fixture.js";
import { DeviceHub } from "./hub.js";
import { rawPublicKey } from "./keys.js";
import { DevicePanel, PHONE_PANEL } from "./panel.js";
import { ASK_CATEGORY, ASK_OPEN_CATEGORY, PUSH_TOKEN_EVENT, PhonePush, askPush, pushConfig, readApnsEnv, type PushConfig } from "./push.js";
import { deviceRoutes, PREFIX } from "./routes.js";
import { DeviceStore, type PushSettings } from "./store.js";

const P8 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const credentials: ApnsCredentials = { key: readP8(P8), keyId: "ABC123DEFG", teamId: "DEF123GHIJ", topic: "com.owner.kos-phone" };
const ON: PushConfig = { state: "on", source: "settings", credentials };
const TOKEN = "ab".repeat(32);
const NO_SETTINGS: PushSettings = { keyId: "", teamId: "", topic: "", secret: "" };

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
const hostKey = { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) };

/** APNs as a test plays it: every push asked for, and the answer each gets. */
class FakeSender implements ApnsSender {
  readonly pushes: ApnsPush[] = [];
  answer: (push: ApnsPush) => ApnsAnswer = () => ({ status: 200 });
  async send(_c: ApnsCredentials, push: ApnsPush): Promise<ApnsAnswer> {
    this.pushes.push(push);
    return this.answer(push);
  }
  close(): void {}
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(config: () => PushConfig = () => ON) {
  const store = new DeviceStore(openDatabase(":memory:"));
  const hub = new DeviceHub({ store, hostKey, halted: () => false, lineGraceMs: 0, log: () => undefined });
  const sender = new FakeSender();
  const logged: string[] = [];
  const push = new PhonePush({ store, hub, config, scrub: (t) => t.replaceAll("sk_live_42", "[secret stripe]"), sender, log: (l) => void logged.push(l) });
  const pair = (platform: string, name: string): FakeDevice => {
    const fake = new FakeDevice();
    fake.id = hub.pair({ code: hub.issueCode().code, name, platform, publicKey: fake.publicKey }).device;
    hub.accept(fake.socket);
    fake.hello();
    return fake;
  };
  return { store, hub, sender, push, pair, logged };
}

const ask = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "41",
  text: "Approve files.write?",
  tool: "files.write",
  args: { path: "notes/list.md", content: "the list" },
  expiresAt: 1_761_800_000_500,
  asker: { name: "Garden", conversationId: "c_2" },
  ...over,
});

describe("push's credentials", () => {
  const vault = (handle: string): string | undefined => (handle === "apns-7k2q" ? P8 : undefined);
  const settings: PushSettings = { keyId: "ABC123DEFG", teamId: "DEF123GHIJ", topic: "com.owner.kos-phone", secret: "apns-7k2q" };

  it("are none with nothing given, and push is off saying nothing is wrong", () => {
    expect(pushConfig(undefined, NO_SETTINGS, vault)).toEqual({ state: "off" });
  });

  it("are Settings' with the .p8 read from the vault secret it names", () => {
    expect(pushConfig(undefined, settings, vault)).toMatchObject({ state: "on", source: "settings", credentials: { keyId: "ABC123DEFG", teamId: "DEF123GHIJ", topic: "com.owner.kos-phone" } });
  });

  it("say what is missing or wrong, and never what the key is", () => {
    expect(pushConfig(undefined, { ...settings, teamId: "" }, vault)).toEqual({ state: "off", source: "settings", problem: "Push needs the team ID." });
    expect(pushConfig(undefined, { ...settings, secret: "gone-0000" }, vault)).toMatchObject({ state: "off", problem: expect.stringMatching(/gone-0000 does not read/) });
    const notKey = pushConfig(undefined, settings, () => "hunter2-not-a-key");
    expect(notKey).toMatchObject({ state: "off", problem: expect.stringMatching(/apns-7k2q is not a \.p8 key/) });
    expect(JSON.stringify(notKey)).not.toContain("hunter2");
    expect(pushConfig(undefined, { ...settings, topic: "kos" }, vault)).toMatchObject({ state: "off", problem: expect.stringMatching(/bundle ID/) });
  });

  it("are the environment's whenever it names any of them, whole or saying what it lacks", () => {
    const env = readApnsEnv({ KOS_APNS_KEY_FILE: "/keys/AuthKey.p8", KOS_APNS_KEY_ID: "ABC123DEFG", KOS_APNS_TEAM_ID: "DEF123GHIJ", KOS_APNS_TOPIC: "com.owner.kos-phone" }, () => P8);
    expect(pushConfig(env, settings, vault)).toMatchObject({ state: "on", source: "env" });
    const partial = readApnsEnv({ KOS_APNS_KEY: P8, KOS_APNS_KEY_ID: "ABC123DEFG" }, () => "");
    expect(pushConfig(partial, settings, vault)).toEqual({ state: "off", source: "env", problem: "Push needs KOS_APNS_TEAM_ID, KOS_APNS_TOPIC." });
    const unreadable = readApnsEnv({ KOS_APNS_KEY_FILE: "/keys/gone.p8" }, () => {
      throw new Error("ENOENT");
    });
    expect(pushConfig(unreadable, NO_SETTINGS, vault)).toEqual({ state: "off", source: "env", problem: "KOS can't read the APNs key at /keys/gone.p8." });
    expect(readApnsEnv({}, () => P8)).toBeUndefined();
  });
});

describe("an ask's notification", () => {
  it("is who asks and the card's own line, with its id to collapse on and to lapse with the ask", () => {
    const push = askPush(ask(), (t) => t);
    expect(push.headers).toEqual({ "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "kos.ask.41", "apns-expiration": "1761800001" });
    expect(push.payload).toEqual({
      aps: { alert: { title: "Garden asks", body: expect.stringContaining("notes/list.md") }, sound: "default", category: ASK_CATEGORY, "thread-id": "kos.asks" },
      kos: { ask: "41" },
    });
    // The card's line, never what the call would write.
    expect(JSON.stringify(push.payload)).not.toContain("the list");
  });

  it("is scrubbed of every secret value, and cut short", () => {
    const push = askPush(ask({ tool: "shell.run", args: { command: `curl -H 'auth: sk_live_42' ${"x".repeat(400)}` } }), (t) => t.replaceAll("sk_live_42", "[secret stripe]"));
    const body = (push.payload.aps as { alert: { body: string } }).alert.body;
    expect(body).not.toContain("sk_live_42");
    expect(body.length).toBeLessThanOrEqual(180);
  });

  it("offers Deny alone for an ask too long to approve unseen, as the phone's card does", () => {
    const push = askPush(ask({ args: { path: "big.md", content: "y".repeat(250_000) } }), (t) => t);
    expect((push.payload.aps as { category: string }).category).toBe(ASK_OPEN_CATEGORY);
  });

  it("offers Deny alone for an ask that runs detached, its warning under the line", () => {
    const aps = (r: ApprovalRequest) => askPush(r, (t) => t).payload.aps as { alert: { body: string }; category: string };
    const stopped = aps(ask({ tool: "notify", args: { text: "back soon" }, detached: "stopped" }));
    expect(stopped.category).toBe(ASK_OPEN_CATEGORY);
    expect(stopped.alert.body.endsWith(`\n${DETACHED_WORDS.stopped}`)).toBe(true);
    // A long line is cut, the warning kept whole.
    const long = aps(ask({ tool: "shell.run", args: { command: "x".repeat(400) }, detached: "unwaited" }));
    expect(long.alert.body.length).toBeLessThanOrEqual(180);
    expect(long.alert.body.endsWith(`\n${DETACHED_WORDS.unwaited}`)).toBe(true);
  });

  it("is unchanged for an ask a turn waits on, and for a secret's, which never runs detached", () => {
    const aps = (r: ApprovalRequest) => askPush(r, (t) => t).payload.aps as { alert: { body: string }; category: string };
    const held = aps(ask());
    expect(held.category).toBe(ASK_CATEGORY);
    expect(held.alert.body).not.toContain("\n");
    const secret = aps(ask({ tool: "secrets.fill", args: { secret: "visa", fields: [] }, asksAlways: true }));
    expect(secret.category).toBe(ASK_CATEGORY);
    expect(secret.alert.body).not.toMatch(/approving runs it now/);
  });
});

describe("a phone's token", () => {
  it("is kept for a paired phone, and taken back when it says so", async () => {
    const { store, pair } = setup();
    const phone = pair("ios", "iPhone");
    phone.event(PUSH_TOKEN_EVENT, { token: TOKEN.toUpperCase(), env: "sandbox" });
    await flush();
    expect(store.push(phone.id)).toMatchObject({ token: TOKEN, env: "sandbox" });
    phone.event(PUSH_TOKEN_EVENT, {});
    await flush();
    expect(store.push(phone.id)).toBeUndefined();
  });

  it("is never a computer's or a Chrome's, nor one that is not a token or names no gateway", async () => {
    const { store, pair } = setup();
    const mac = pair("macos", "Studio");
    mac.event(PUSH_TOKEN_EVENT, { token: TOKEN, env: "sandbox" });
    const phone = pair("ios", "iPhone");
    phone.event(PUSH_TOKEN_EVENT, { token: "../../x", env: "sandbox" });
    phone.event(PUSH_TOKEN_EVENT, { token: TOKEN, env: "staging" });
    await flush();
    expect(store.pushes()).toEqual([]);
  });

  it("goes when the phone is unpaired", async () => {
    const { store, hub, pair } = setup();
    const phone = pair("ios", "iPhone");
    phone.event(PUSH_TOKEN_EVENT, { token: TOKEN, env: "production" });
    await flush();
    hub.remove(phone.id);
    expect(store.pushes()).toEqual([]);
  });

  it("is one iPhone's: given by a phone paired again, the old pairing's copy goes", () => {
    const { store } = setup();
    store.setPush("dev_old", TOKEN, "sandbox");
    store.setPush("dev_new", TOKEN, "sandbox");
    expect(store.pushes().map((p) => p.device)).toEqual(["dev_new"]);
  });
});

describe("pushing an ask", () => {
  it("sends nothing without credentials, though a phone gave its token", async () => {
    const { sender, push, pair } = setup(() => ({ state: "off" }));
    pair("ios", "iPhone").event(PUSH_TOKEN_EVENT, { token: TOKEN, env: "sandbox" });
    await flush();
    await push.asked(ask());
    await push.settled("41");
    expect(sender.pushes).toEqual([]);
    expect(push.status()).toEqual({ configured: false, settings: NO_SETTINGS });
  });

  it("sends one to each phone with a token, on the gateway each is good on", async () => {
    const { sender, push, pair } = setup();
    pair("ios", "iPhone").event(PUSH_TOKEN_EVENT, { token: TOKEN, env: "sandbox" });
    pair("ios", "iPad").event(PUSH_TOKEN_EVENT, { token: "cd".repeat(32), env: "production" });
    pair("ios", "Old iPhone");
    await flush();
    await push.asked(ask());
    expect(sender.pushes.map((p) => [p.token, p.env])).toEqual([
      [TOKEN, "sandbox"],
      ["cd".repeat(32), "production"],
    ]);
  });

  it("drops a token APNs no longer takes, and says so without the token", async () => {
    const { store, sender, push, pair, logged } = setup();
    const phone = pair("ios", "iPhone");
    phone.event(PUSH_TOKEN_EVENT, { token: TOKEN, env: "sandbox" });
    await flush();
    sender.answer = () => ({ status: 410, reason: "Unregistered" });
    await push.asked(ask());
    expect(store.push(phone.id)).toBeUndefined();
    expect(logged.at(-1)).toBe("push: ask 41 to iPhone not sent: 410 Unregistered");
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("is taken down once settled, on the phones it reached and only for asks it pushed", async () => {
    const { sender, push, pair } = setup();
    pair("ios", "iPhone").event(PUSH_TOKEN_EVENT, { token: TOKEN, env: "sandbox" });
    await flush();
    await push.asked(ask());
    await push.settled("99");
    await push.settled("41");
    await push.settled("41");
    expect(sender.pushes.map((p) => p.headers["apns-push-type"])).toEqual(["alert", "background"]);
    expect(sender.pushes[1]!.payload).toEqual({ aps: { "content-available": 1 }, kos: { settled: "41" } });
  });

  it("is decided over the phone's own line on wake, the phone as who decided", async () => {
    const { hub, sender, push, pair } = setup();
    const panel = new DevicePanel(PHONE_PANEL, { current: () => undefined, events: () => [] });
    panel.attach(hub);
    const decided: unknown[] = [];
    panel.onApproval(async (d) => void decided.push(d));
    const phone = pair("ios", "iPhone");
    phone.event(PUSH_TOKEN_EVENT, { token: TOKEN, env: "sandbox" });
    await flush();
    await push.asked(ask());
    // Woken by Approve on the lock screen: the app dials, proves itself and decides, and opens no chat to do it.
    phone.drop();
    const woken = new FakeDevice(phone.id, phone.key);
    hub.accept(woken.socket);
    woken.hello();
    woken.event("chat.decide", { approval: "41", approved: true });
    await flush();
    expect(decided).toEqual([{ id: "41", approved: true, deciderId: phone.id }]);
    await push.settled("41");
    expect(sender.pushes.at(-1)!.payload).toMatchObject({ kos: { settled: "41" } });
  });
});

describe("Settings for push", () => {
  it("lists each phone's push and where push stands, and keeps the key's names, never the key", async () => {
    const { hub, push, pair } = setup(() => ({ state: "off" }));
    const routes = deviceRoutes(() => hub, (id) => id, undefined, () => undefined, () => push);
    const phone = pair("ios", "iPhone");
    pair("macos", "Studio");
    phone.event(PUSH_TOKEN_EVENT, { token: TOKEN, env: "sandbox" });
    await flush();
    const listed = (await routes.handle({ method: "GET", path: PREFIX })) as { body: { devices: { name: string; push?: unknown }[]; push: unknown } };
    expect(listed.body.devices.map((d) => [d.name, d.push])).toEqual([
      ["iPhone", { on: true, env: "sandbox" }],
      ["Studio", undefined],
    ]);
    expect(listed.body.push).toEqual({ configured: false, settings: NO_SETTINGS });
    const saved = await routes.handle({ method: "POST", path: `${PREFIX}/push`, body: { keyId: "ABC123DEFG", teamId: "DEF123GHIJ", topic: "com.owner.kos-phone", secret: "apns-7k2q" } });
    expect(saved).toMatchObject({ status: 200, body: { settings: { keyId: "ABC123DEFG", secret: "apns-7k2q" } } });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/push`, body: { keyId: "-----BEGIN PRIVATE KEY-----" } })).toMatchObject({ status: 400 });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/push`, body: { secret: "" } })).toMatchObject({ body: { settings: { secret: "" } } });
  });
});

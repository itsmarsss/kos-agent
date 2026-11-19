import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_TTL_MS, summarizeAction } from "@kos/shared";
import type { FieldSpot, SecretFill, Seen } from "@kos/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { Decisions } from "../kernel/decisions.js";
import { GRANT_DECIDER, GuardedTools, type GuardedToolsDeps } from "../kernel/guarded.js";
import { ModuleLoader, toolRegistryContext, type KosModule } from "../modules/loader.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { AuditLog } from "../ops/audit.js";
import { SecretUses } from "../ops/secretuses.js";
import { Workspace } from "../store/workspace.js";
import { createSecretsModule, type SecretPlace } from "../tools/secrets.js";
import { registerSecretType, type MacFocus, type MacSecretParams } from "../tools/secrettype.js";
import { OneTimeCodes } from "./codes.js";
import { Scrubber } from "./scrub.js";
import { SecretsRegistry } from "./secrets.js";

/**
 * One-time codes: typed by the owner into the card of the fill or the type
 * that needs one, held in memory as a single-use otp_<id> bound to that page
 * or app and that chat, gone after five minutes, never written anywhere,
 * and taken out of whatever echoes it.
 */

const SITE = "https://github.com";
const CODE = "481926";
const SAFARI = { name: "Safari", bundle: "com.apple.Safari" };

describe("OneTimeCodes", () => {
  let now = 1_000_000;
  const codes = (): OneTimeCodes => new OneTimeCodes(() => now);
  const here = { surface: "kos-browser" as const, conversationId: "c1", origin: SITE };

  it("takes only what a card takes, and hands a code out once, to the ask it came with", () => {
    const held = codes();
    expect(held.offer(1, "12345")).toMatch(/6 or more/);
    expect(held.offer(1, "12 34 56;")).toMatch(/letters, digits and dashes/);
    expect(held.offer(1, " 481 926 ")).toBeUndefined();
    expect(held.claim(2, here)).toBeUndefined();
    const handle = held.claim(1, here)!;
    expect(handle).toMatch(/^otp_[0-9a-f]{8}$/);
    expect(held.claim(1, here)).toBeUndefined();
    expect(held.value(handle, here)).toBe(CODE);
  });

  it("refuses another chat, page, browser or app, a code used once, and one past five minutes", () => {
    const held = codes();
    held.offer(1, CODE);
    const handle = held.claim(1, here)!;
    expect(held.check(handle, { ...here, conversationId: "c2" })?.code).toBe("policy");
    expect(held.check(handle, { ...here, origin: "https://evil.example" })?.code).toBe("origin");
    expect(held.check(handle, { ...here, surface: "chrome" })?.code).toBe("origin");
    expect(held.check(handle, { ...here, surface: "mac", app: SAFARI.bundle })?.code).toBe("origin");
    expect(held.check("otp_00000000", here)?.code).toBe("secret");
    held.spend(handle);
    expect(held.check(handle, here)?.code).toBe("used");
    held.offer(2, "777333");
    const late = held.claim(2, here)!;
    now += CODE_TTL_MS;
    expect(held.check(late, here)?.code).toBe("expired");
    held.offer(3, "222444");
    now += CODE_TTL_MS;
    expect(held.claim(3, here)).toBeUndefined();
  });

  it("is watched for while held and a while after, then forgotten", () => {
    const held = codes();
    held.offer(1, CODE);
    const handle = held.claim(1, here)!;
    expect(held.watched()).toEqual([{ handle, value: CODE, origin: SITE }]);
    held.spend(handle);
    now += CODE_TTL_MS - 1;
    expect(held.watched()).toHaveLength(1);
    now += 2;
    expect(held.watched()).toEqual([]);
  });
});

describe("the scrubber on a code", () => {
  it("takes it out where it stands alone, never from inside a longer number or word", () => {
    const scrubber = new Scrubber([["otp_1.code", CODE, "code"]]);
    expect(scrubber.scrub(`Your code is ${CODE}.`)).toBe("Your code is [secret otp_1.code].");
    expect(scrubber.scrub(`{"value":"${CODE}"}`)).toBe('{"value":"[secret otp_1.code]"}');
    expect(scrubber.scrub(`at 1763${CODE}000 and id x${CODE}`)).toBe(`at 1763${CODE}000 and id x${CODE}`);
    expect(scrubber.scrub(`hex ${Buffer.from(CODE).toString("hex")}`)).toBe("hex [secret otp_1.code]");
  });

  it("follows the registry's codes: looked for from the yes, and on the database's path", () => {
    const secrets = new SecretsRegistry();
    expect(secrets.scrub(`code ${CODE}`)).toBe(`code ${CODE}`);
    secrets.codes.offer(9, CODE);
    expect(secrets.scrub(`code ${CODE}`)).toMatch(/^code \[secret otp_[0-9a-f]{8}\.code\]$/);
    expect(secrets.scrubStored(`code ${CODE}`)).not.toContain(CODE);
    expect(secrets.browserValues()).toContainEqual({ text: CODE, digits: false });
    const handle = secrets.codes.claim(9, { surface: "kos-browser", conversationId: "c1", origin: SITE })!;
    expect(secrets.pageValues([SITE])).toContainEqual({ text: CODE, digits: false });
    expect(secrets.pageValues(["https://example.com"])).toEqual([]);
    secrets.codes.clear();
    expect(secrets.scrub(`code ${CODE} ${handle}`)).toBe(`code ${CODE} ${handle}`);
  });
});

describe("a one-time code through the tools", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let approvals: ApprovalQueue;
  let audit: AuditLog;
  let secrets: SecretsRegistry;
  let page: { url: string; doc: string; frames: Record<string, string>; echo: boolean };
  let place: SecretPlace;
  let filled: SecretFill[][];
  let refuse: Error | undefined;
  let mac: { focus: MacFocus; typed: MacSecretParams[] };
  let said: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-codes-"));
    ws = Workspace.open(join(root, "ws"));
    secrets = new SecretsRegistry();
    approvals = new ApprovalQueue(ws.db, secrets);
    audit = new AuditLog(ws.db, secrets);
    page = { url: `${SITE}/sessions/two-factor`, doc: "doc-1", frames: {}, echo: false };
    place = { surface: "kos-browser" };
    filled = [];
    refuse = undefined;
    mac = { focus: { app: SAFARI, field: { role: "AXTextField", secure: false, window: "Two-factor", label: "Code", origin: SITE } }, typed: [] };
    said = [];
    for (const stream of ["log", "info", "warn", "error"] as const) vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void said.push(args.map(String).join(" ")));
    const uses = new SecretUses(ws.db);
    const onMac: KosModule = {
      manifest: { name: "mac-standin", version: "1.0.0", provides: [{ kind: "tool", name: "secrets.type", version: "1.0.0" }] },
      activate: (ctx) =>
        void registerSecretType(ctx, {
          vault: () => undefined,
          uses,
          codes: () => secrets.codes,
          mac: {
            session: () => ({ id: "s1", device: { id: "dev_mac", name: "Studio MacBook" } }),
            focus: async () => structuredClone(mac.focus),
            type: async (_chat, params) => {
              mac.typed.push(params);
              return {};
            },
          },
        }),
    };
    registry = new ToolRegistry();
    await new ModuleLoader(toolRegistryContext(registry)).load([
      createSecretsModule({
        vault: () => undefined,
        uses,
        codes: secrets.codes,
        browser: {
          unready: () => undefined,
          where: () => place,
          url: () => page.url,
          spots: async (refs) => refs.map((ref): FieldSpot => ({ origin: new URL(page.url).origin, frameOrigin: page.frames[ref] ?? new URL(page.url).origin, doc: page.doc, field: { label: "Authentication code", type: "text", action: `${SITE}/sessions/two-factor`, method: "post" } })),
          fill: async (fills): Promise<Seen> => {
            if (refuse) throw refuse;
            filled.push(fills);
            // A page that echoes what was typed, as the leak suite's does.
            return { text: page.echo ? `textbox "Authentication code" @e7\ntext "You typed ${fills[0]!.value}"` : 'textbox "Authentication code" = "(hidden)" @e7', images: [] };
          },
        },
      }),
      onMac,
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    secrets.codes.clear();
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const guarded = (over: Partial<GuardedToolsDeps> = {}): GuardedTools => new GuardedTools({ registry, secrets, audit, approvals, conversationId: "c1", turnId: "t1", owner: true, ownWords: true, ...over });
  /** A fresh call each time, as the model makes one: the tools read a call's fields once per call. */
  const askCode = (): Record<string, unknown> => ({ secret: "code", fields: [{ field: "code", target: "@e7" }], intent: "finish signing in" });
  const decisions = (): Decisions =>
    new Decisions({
      ownerId: "owner",
      approvals,
      permissions: { add: () => undefined },
      audit,
      registry,
      secrets,
      queue: { enqueue: (work) => work() },
      inConversation: (_id, work) => work(),
      onToolRan: () => undefined,
      handleMessage: async () => ({ reply: "" }),
      codes: secrets.codes,
    });
  const pending = async (): Promise<number> => {
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    return approvals.pending()[0]!.id;
  };
  const handleIn = (text: string): string => /otp_[0-9a-f]{8}/.exec(text)![0];
  /** Every byte of the workspace's database files, the write-ahead log included. */
  const dbBytes = (): string =>
    readdirSync(join(root, "ws"))
      .filter((f) => f.includes("sqlite"))
      .map((f) => readFileSync(join(root, "ws", f), "latin1"))
      .join("\n");

  it("asks on a card with a box for the code, and takes no yes without one", async () => {
    const running = guarded().execute("secrets.fill", askCode());
    const id = await pending();
    const ask = approvals.get(id)!;
    expect(ask.secret).toMatchObject({ handle: "code", kind: "code", label: "One-time code", origin: SITE, code: true, remember: [], targets: [{ field: "code", label: "Authentication code", type: "text" }] });
    expect(summarizeAction(ask.tool, ask.args)).toBe("Fill a one-time code you type on this card");
    expect(await decisions().approve(id, "owner", { surface: "dashboard" })).toMatchObject({ ok: false, message: expect.stringMatching(/Type the code/) });
    expect(await decisions().approve(id, "owner", { surface: "dashboard", code: "12" })).toMatchObject({ ok: false });
    expect(await decisions().approve(id, "owner", { surface: "discord", code: CODE })).toMatchObject({ ok: false, message: expect.stringMatching(/never decided here/) });
    expect(approvals.get(id)?.status).toBe("pending");
    expect(await decisions().approve(id, "owner", { surface: "dashboard", code: CODE })).toMatchObject({ ok: true });
    const done = await running;
    expect(done.isError).toBe(false);
    expect(filled).toEqual([[{ ref: "@e7", value: CODE, expect: { origin: SITE, doc: "doc-1", frameOrigin: SITE, slot: "text" } }]]);
    expect(done.content).toMatch(/Filled the one-time code \(otp_[0-9a-f]{8}\) on https:\/\/github\.com, in KOS's own browser\. It is spent/);
    expect(done.content).not.toContain(CODE);
  });

  it("is filled once: the same handle again is refused", async () => {
    const running = guarded().execute("secrets.fill", askCode());
    await decisions().approve(await pending(), "owner", { surface: "dashboard", code: CODE });
    const handle = handleIn((await running).content);
    const again = await guarded().execute("secrets.fill", { ...askCode(), secret: handle });
    expect(again).toMatchObject({ isError: true, content: expect.stringMatching(/was used already/) });
    expect(filled).toHaveLength(1);
    expect(approvals.pending()).toHaveLength(0);
  });

  it("refused before it went in, is kept for one more try on that page alone, without a second ask", async () => {
    refuse = Object.assign(new Error("the field is covered by something else"), { code: "field" });
    const running = guarded().execute("secrets.fill", askCode());
    await decisions().approve(await pending(), "owner", { surface: "dashboard", code: CODE });
    const first = await running;
    expect(first.content).toMatch(/Not filled: the field is covered.*kept as otp_/);
    const handle = handleIn(first.content);
    refuse = undefined;
    page.url = "https://evil.example/login";
    expect((await guarded().execute("secrets.fill", { ...askCode(), secret: handle })).content).toMatch(/given for https:\/\/github\.com, not https:\/\/evil\.example/);
    expect((await guarded({ conversationId: "c2" }).execute("secrets.fill", { ...askCode(), secret: handle })).content).toMatch(/another chat/);
    page.url = `${SITE}/sessions/two-factor`;
    const retried = await guarded().execute("secrets.fill", { ...askCode(), secret: handle });
    expect(retried.content).toMatch(/Filled the one-time code/);
    expect(filled.map((f) => f[0]!.value)).toEqual([CODE]);
    const audited = ws.db.prepare("SELECT approved_by FROM audit_log WHERE tool = 'secrets.fill' ORDER BY id DESC LIMIT 1").get() as { approved_by: string };
    expect(audited.approved_by).toBe(GRANT_DECIDER);
  });

  it("runs out after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    refuse = Object.assign(new Error("the page changed"), { code: "changed" });
    const running = guarded().execute("secrets.fill", askCode());
    await decisions().approve(await pending(), "owner", { surface: "dashboard", code: CODE });
    const handle = handleIn((await running).content);
    refuse = undefined;
    vi.setSystemTime(Date.now() + CODE_TTL_MS + 1);
    expect((await guarded().execute("secrets.fill", { ...askCode(), secret: handle })).content).toMatch(/ran out/);
    expect(filled).toHaveLength(0);
  });

  it("is asked of the owner present in their own turn, on https, in the page's own frame", async () => {
    expect((await guarded({ attended: false }).execute("secrets.fill", askCode())).content).toMatch(/needs the owner present/);
    expect((await guarded({ guest: { project: undefined, chat: "g" } }).execute("secrets.fill", askCode())).content).toMatch(/guest/);
    page.frames["@e7"] = "https://pay.example";
    expect((await guarded().execute("secrets.fill", askCode())).content).toMatch(/in a frame from https:\/\/pay\.example/);
    page.frames = {};
    page.url = "http://example.com/2fa";
    expect((await guarded().execute("secrets.fill", askCode())).content).toMatch(/not https/);
    expect(approvals.pending()).toHaveLength(0);
  });

  it("is written nowhere: not the database, its log, the audit, the ask or the console, and an echo of it is taken out", async () => {
    page.echo = true;
    const running = guarded().execute("secrets.fill", askCode());
    await decisions().approve(await pending(), "owner", { surface: "dashboard", code: CODE });
    const done = await running;
    expect(done.content).toMatch(/You typed \[secret otp_[0-9a-f]{8}\.code\]/);
    const rows = JSON.stringify([ws.db.prepare("SELECT * FROM pending_actions").all(), ws.db.prepare("SELECT * FROM audit_log").all()]);
    for (const text of [rows, dbBytes(), said.join("\n")]) expect(text).not.toContain(CODE);
  });

  it("types into the app and page in front on the Mac, bound to them", async () => {
    const running = guarded().execute("secrets.type", { secret: "code", field: "code", intent: "finish signing in" });
    const id = await pending();
    const ask = approvals.get(id)!;
    expect(ask.secret).toMatchObject({ kind: "code", code: true, surface: "mac", app: SAFARI, origin: SITE, device: "Studio MacBook" });
    expect(summarizeAction(ask.tool, ask.args)).toBe("Type a one-time code you type on this card into Safari");
    await decisions().approve(id, "owner", { surface: "phone", code: CODE });
    const done = await running;
    expect(done.content).toMatch(/Typed the one-time code \(otp_[0-9a-f]{8}\) into the text field in Safari/);
    expect(mac.typed).toEqual([expect.objectContaining({ text: CODE, field: "text", app: { bundle: SAFARI.bundle }, apps: [SAFARI.bundle], origin: SITE })]);
    const again = await guarded().execute("secrets.type", { secret: handleIn(done.content), field: "code" });
    expect(again.content).toMatch(/was used already/);
    expect(dbBytes()).not.toContain(CODE);
  });
});

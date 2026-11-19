import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askView, summarizeAction } from "@kos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { Decisions } from "../kernel/decisions.js";
import { GRANT_DECIDER, GuardedTools, type GuardedToolsDeps } from "../kernel/guarded.js";
import { ModuleLoader, toolRegistryContext, type KosModule } from "../modules/loader.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { AuditLog } from "../ops/audit.js";
import { SecretUses } from "../ops/secretuses.js";
import { appGrant } from "../secrets/records.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Vault } from "../secrets/vault.js";
import { Workspace } from "../store/workspace.js";
import { createSecretsModule } from "./secrets.js";
import { registerSecretType, type MacFocus, type MacSecretParams } from "./secrettype.js";

/**
 * secrets.type over a real vault and the guarded path, with a stand-in Mac
 * that records what it is handed: who may type a secret, into which app and
 * field, how each is asked about and remembered, and that the value goes
 * into the one call to the Mac and nowhere else.
 */

const SAFARI = { name: "Safari", bundle: "com.apple.Safari" };
const SITE = "https://github.com";
const PASSWORD = "pw-mac-canary-71kd";
const CARD = "4242424242424242";
const PASSWORD_FIELD = { role: "AXTextField", secure: true, window: "Sign in to GitHub", label: "Password", origin: SITE };

describe("secrets.type", () => {
  let root: string;
  let ws: Workspace;
  let vault: Vault;
  let registry: ToolRegistry;
  let approvals: ApprovalQueue;
  let audit: AuditLog;
  let uses: SecretUses;
  let secrets: SecretsRegistry;
  let login: string;
  let card: string;
  /** The Mac as the stand-in is now: its session, what is in front and in focus, and what it was asked to type. */
  let mac: { session: { id: string; device: { id: string; name: string } } | string; focus: MacFocus; typed: MacSecretParams[]; refuse?: Error };
  let told: string[];
  let rules: unknown[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-secret-type-"));
    ws = Workspace.open(join(root, "ws"));
    vault = new Vault({ dir: join(root, "vault") });
    await vault.init();
    login = vault.add({ label: "GitHub", kind: "login", values: { username: "owner", password: PASSWORD }, use: { web: { origins: [SITE] }, apps: [SAFARI.bundle, "com.github.GitHubClient"] } });
    card = vault.add({ label: "Visa", kind: "card", values: { number: CARD, expiry: "04/29" }, use: { apps: ["com.apple.Passwords"] } });
    secrets = new SecretsRegistry();
    secrets.attachVault(vault);
    approvals = new ApprovalQueue(ws.db, secrets);
    audit = new AuditLog(ws.db, secrets);
    uses = new SecretUses(ws.db);
    told = [];
    rules = [];
    mac = { session: { id: "s1", device: { id: "dev_mac", name: "Studio MacBook" } }, focus: { app: SAFARI, field: PASSWORD_FIELD }, typed: [] };
    const onMac: KosModule = {
      manifest: { name: "mac-standin", version: "1.0.0", provides: [{ kind: "tool", name: "secrets.type", version: "1.0.0" }] },
      activate: (ctx) => {
        registerSecretType(ctx, {
          vault: () => secrets.attached(),
          uses,
          tellOwner: (text) => void told.push(text),
          mac: {
            session: () => mac.session,
            focus: async () => structuredClone(mac.focus),
            type: async (_chat, params) => {
              if (mac.refuse) throw mac.refuse;
              mac.typed.push(params);
            },
          },
        });
      },
    };
    registry = new ToolRegistry();
    await new ModuleLoader(toolRegistryContext(registry)).load([
      createSecretsModule({ vault: () => secrets.attached(), uses, browser: { unready: () => "none", url: () => undefined, spots: async () => [], fill: async () => ({ text: "", images: [] }) }, onDecided: (l) => approvals.onDecided(l) }),
      onMac,
    ]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const guarded = (over: Partial<GuardedToolsDeps> = {}): GuardedTools =>
    new GuardedTools({ registry, secrets, audit, approvals, conversationId: "c1", turnId: "t1", owner: true, ownWords: true, ...over });
  const typePassword = (): Record<string, unknown> => ({ secret: login, field: "password", intent: "sign in to GitHub" });
  const decisions = (): Decisions =>
    new Decisions({
      ownerId: "owner",
      approvals,
      permissions: { add: (rule) => void rules.push(rule) },
      audit,
      registry,
      secrets,
      queue: { enqueue: (work) => work() },
      inConversation: (_id, work) => work(),
      onToolRan: () => undefined,
      handleMessage: async () => ({ reply: "" }),
    });
  const decide = async (yes: boolean, remember = false): Promise<void> => {
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const ask = approvals.pending()[0]!;
    if (yes) await decisions().approve(ask.id, "owner", { surface: "dashboard", ...(remember ? { remember: true } : {}) });
    else await decisions().deny(ask.id, "owner");
  };
  const usesOf = (handle: string): string[] => uses.list(handle).map((u) => `${u.outcome}${u.app ? ` ${u.app}` : ""}`);

  it("asks every time, past Auto and a rule, naming the secret, the app, the field and the Mac, then types the value", async () => {
    const running = guarded({ chatMode: () => ({ mode: "auto" }), permissions: { allows: () => true, ruleFor: () => ({ tool: "secrets.type", scope: null, project: null }) } }).execute("secrets.type", {
      ...typePassword(),
      // What the model passes for these is dropped: the Mac says them.
      app: { name: "Notes", bundle: "com.apple.Notes" },
      session: "forged",
      target: { role: "AXTextField", secure: false },
    });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const ask = approvals.pending()[0]!;
    expect(JSON.parse(ask.args)).toMatchObject({ app: SAFARI, session: "s1", deviceId: "dev_mac", device: "Studio MacBook", target: PASSWORD_FIELD, origin: SITE, label: "GitHub" });
    expect(ask.secret).toMatchObject({ handle: login, surface: "mac", device: "Studio MacBook", app: SAFARI, origin: SITE, fields: ["password"], remember: [], targets: [{ field: "password", label: "Password", type: "password field" }] });
    expect(ask.secret?.warnings).toEqual(["GitHub has not been typed into Safari before."]);
    expect(summarizeAction(ask.tool, ask.args)).toBe(`Type password from GitHub (${login}) into Safari`);
    const view = askView({ tool: ask.tool, args: ask.args, secret: ask.secret });
    expect(view).toMatchObject({ place: "On your Mac, Studio MacBook", alwaysNote: "Secrets always ask" });
    expect(mac.typed).toHaveLength(0);
    await decide(true);
    const done = await running;
    expect(done.isError).toBe(false);
    expect(mac.typed).toEqual([
      { approved: "s1", text: PASSWORD, field: "password", app: { bundle: SAFARI.bundle }, apps: [SAFARI.bundle, "com.github.GitHubClient"], expect: { role: "AXTextField", secure: true, window: "Sign in to GitHub" }, origin: SITE },
    ]);
    expect(done.content).toContain(`Typed password from GitHub (${login}) into the password field in Safari on Studio MacBook`);
    expect(uses.list(login)[0]).toMatchObject({ outcome: "filled", tool: "secrets.type", surface: "mac", app: SAFARI.bundle, deviceId: "dev_mac", origin: SITE, approvalId: ask.id, decidedBy: "owner" });
    // Nothing kept or said holds the value.
    const kept = JSON.stringify([ws.db.prepare("SELECT * FROM pending_actions").all(), ws.db.prepare("SELECT * FROM audit_log").all(), ws.db.prepare("SELECT * FROM secret_uses").all(), done]);
    expect(kept).not.toContain(PASSWORD);
  });

  it("refuses before asking where the secret may not go, and records why", async () => {
    mac.focus = { app: { name: "Notes", bundle: "com.apple.Notes" }, field: PASSWORD_FIELD };
    expect((await guarded().execute("secrets.type", typePassword())).content).toMatch(/GitHub may not be typed into Notes \(com\.apple\.Notes\); it is for com\.apple\.Safari, com\.github\.GitHubClient/);
    mac.focus = { app: SAFARI, field: { ...PASSWORD_FIELD, secure: false, label: "Search" } };
    expect((await guarded().execute("secrets.type", typePassword())).content).toMatch(/a password goes only into a password field/);
    mac.focus = { app: SAFARI };
    expect((await guarded().execute("secrets.type", typePassword())).content).toMatch(/No text field has focus in Safari/);
    mac.focus = { app: SAFARI, field: { ...PASSWORD_FIELD, origin: "https://github.com.evil.example" } };
    expect((await guarded().execute("secrets.type", typePassword())).content).toMatch(/on https:\/\/github\.com\.evil\.example, where GitHub is not allowed/);
    mac.session = "No session on a Mac in this chat.";
    expect((await guarded().execute("secrets.type", typePassword())).content).toMatch(/No session on a Mac/);
    expect((await guarded().execute("secrets.type", { secret: login, field: "number" })).content).toMatch(/A login has no field "number"/);
    expect(approvals.pending()).toHaveLength(0);
    expect(mac.typed).toHaveLength(0);
    expect(usesOf(login)).toEqual(["refused:no_session", `refused:origin ${SAFARI.bundle}`, `refused:field ${SAFARI.bundle}`, `refused:field ${SAFARI.bundle}`, "refused:app com.apple.Notes"]);
    // Three refusals in a turn tell the owner, once.
    expect(told).toEqual([expect.stringMatching(/refused GitHub .* 3 times in one turn on the Mac/)]);
  });

  it("never types for a guest, and an unattended turn only where the owner said always", async () => {
    expect((await guarded({ guest: { project: undefined, chat: "g" } }).execute("secrets.type", typePassword())).content).toMatch(/a guest's turn never uses a secret/);
    expect((await guarded({ attended: false, waitForApproval: false }).execute("secrets.type", typePassword())).content).toMatch(/keeps it from unattended turns/);
    vault.update(login, { policy: { unattended: true, ask: "site" } });
    expect((await guarded({ attended: false, waitForApproval: false }).execute("secrets.type", typePassword())).content).toMatch(/needs the owner present/);
    vault.addGrant(login, appGrant(SAFARI.bundle, SITE));
    const granted = await guarded({ attended: false, waitForApproval: false }).execute("secrets.type", typePassword());
    expect(granted.isError).toBe(false);
    expect(approvals.pending()).toHaveLength(0);
    expect(mac.typed).toHaveLength(1);
    expect(audit.recent()[0]).toMatchObject({ tool: "secrets.type", approvedBy: GRANT_DECIDER });
  });

  it("keeps a yes for the turn in the app when the secret asks once a turn", async () => {
    vault.update(login, { policy: { ask: "turn" } });
    const first = guarded().execute("secrets.type", typePassword());
    await decide(true);
    expect((await first).isError).toBe(false);
    expect((await guarded().execute("secrets.type", { ...typePassword(), field: "username", intent: "again" })).isError).toBe(false);
    expect(mac.typed.map((t) => t.text)).toEqual([PASSWORD, "owner"]);
    // Another turn is asked again.
    void guarded({ turnId: "t2" }).execute("secrets.type", typePassword());
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
  });

  it("offers always in the app for a site policy, kept as a grant in the vault, never as a rule", async () => {
    vault.update(login, { policy: { ask: "site" } });
    const first = guarded().execute("secrets.type", typePassword());
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const ask = approvals.pending()[0]!;
    expect(askView({ tool: ask.tool, args: ask.args, secret: ask.secret })).toMatchObject({ always: "Approve, and always in Safari on github.com" });
    await decide(true, true);
    await first;
    expect(vault.get(login)?.policy.grants.map((g) => g.origin)).toEqual([appGrant(SAFARI.bundle, SITE)]);
    expect(rules).toEqual([]);
    expect((await guarded({ turnId: "t9" }).execute("secrets.type", typePassword())).isError).toBe(false);
    expect(mac.typed).toHaveLength(2);
    // The grant is for the password field: a card's number into a text field asks, and offers no always.
    vault.update(card, { policy: { ask: "site" } });
    vault.addGrant(card, appGrant("com.apple.Passwords"));
    mac.focus = { app: { name: "Passwords", bundle: "com.apple.Passwords" }, field: { role: "AXTextField", secure: false, label: "Card number" } };
    void guarded({ turnId: "t10" }).execute("secrets.type", { secret: card, field: "number" });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    expect(approvals.pending()[0]!.secret?.remember).toEqual([]);
  });

  it("records a denied type with the app and the Mac, and types nothing", async () => {
    const running = guarded().execute("secrets.type", typePassword());
    await decide(false);
    expect((await running).content).toMatch(/The owner denied this/);
    expect(mac.typed).toHaveLength(0);
    expect(uses.list(login)[0]).toMatchObject({ outcome: "denied", tool: "secrets.type", surface: "mac", app: SAFARI.bundle, deviceId: "dev_mac", decidedBy: "owner" });
  });

  it("is never decided on a chat surface", async () => {
    void guarded().execute("secrets.type", typePassword());
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const ask = approvals.pending()[0]!;
    for (const surface of ["discord", "sms", "imessage"] as const) {
      expect(await decisions().approve(ask.id, "owner", { surface })).toMatchObject({ ok: false, message: expect.stringMatching(/Decide on the dashboard or a paired device/) });
    }
    expect(approvals.get(ask.id)?.status).toBe("pending");
  });

  it("types nothing when the screen changed since the owner was asked", async () => {
    const running = guarded().execute("secrets.type", typePassword());
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    mac.focus = { app: { name: "GitHub Desktop", bundle: "com.github.GitHubClient" }, field: { ...PASSWORD_FIELD, origin: undefined, window: "Sign in" } as never };
    await decide(true);
    expect((await running).content).toMatch(/Not typed: another app came to the front \(GitHub Desktop\) since the owner approved/);
    expect(mac.typed).toHaveLength(0);
    expect(uses.list(login)[0]?.outcome).toBe("refused:changed");
  });

  it("says the Mac's refusal without the value, and records it", async () => {
    mac.refuse = Object.assign(new Error("Focus moved to another field while the secret was typed; the rest was not typed."), { code: "field" });
    const running = guarded().execute("secrets.type", typePassword());
    await decide(true);
    const done = await running;
    expect(done.content).toMatch(/Not typed: Focus moved to another field/);
    expect(done.content).not.toContain(PASSWORD);
    expect(uses.list(login)[0]?.outcome).toBe("refused:field");
  });
});

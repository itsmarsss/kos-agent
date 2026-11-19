import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askView, summarizeAction } from "@kos/shared";
import type { FieldSpot, SecretFill, Seen } from "@kos/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { Decisions } from "../kernel/decisions.js";
import { GRANT_DECIDER, GuardedTools, type GuardedToolsDeps } from "../kernel/guarded.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { AuditLog } from "../ops/audit.js";
import { SecretUses } from "../ops/secretuses.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Vault } from "../secrets/vault.js";
import { Workspace } from "../store/workspace.js";
import { createSecretsModule, type SecretPlace, type SecretsBrowser } from "./secrets.js";

/**
 * The secrets tools over a real vault and the guarded path, with a stand-in
 * browser that records what it is handed: who may use a secret, where, how
 * each fill is asked about and remembered, and that the value goes into
 * the fill and nowhere else.
 */

const SITE = "https://github.com";
const PAY = "https://js.stripe.com";
const PASSWORD = "pw-unit-canary-91zq";
const CARD = "4242424242424242";

describe("the secrets tools", () => {
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
  /** The page the stand-in browser is on, and the frame each ref is in. */
  let page: { url: string; doc: string; frames: Record<string, string>; types: Record<string, string> };
  /** What the module told the owner's Inbox. */
  let told: string[];
  let filled: SecretFill[][];
  let browser: SecretsBrowser;
  /** Which browser the stand-in tab is in. */
  let place: SecretPlace;
  /** Permission rules a decision kept: a secret's yes never makes one. */
  let rules: unknown[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-secrets-tools-"));
    ws = Workspace.open(join(root, "ws"));
    vault = new Vault({ dir: join(root, "vault") });
    await vault.init();
    login = vault.add({ label: "GitHub", kind: "login", values: { username: "owner", password: PASSWORD }, use: { web: { origins: [SITE] } } });
    card = vault.add({ label: "Visa", kind: "card", values: { number: CARD, expiry: "04/29", cvc: "123" }, use: { web: { origins: [SITE], frames: [PAY] } } });
    secrets = new SecretsRegistry();
    secrets.attachVault(vault);
    approvals = new ApprovalQueue(ws.db, secrets);
    audit = new AuditLog(ws.db, secrets);
    uses = new SecretUses(ws.db);
    page = { url: `${SITE}/login`, doc: "doc-1", frames: {}, types: { "@e4": "password" } };
    told = [];
    filled = [];
    rules = [];
    place = { surface: "kos-browser" };
    browser = {
      unready: () => undefined,
      where: () => place,
      url: () => page.url,
      spots: async (refs) =>
        refs.map((ref): FieldSpot => ({ origin: new URL(page.url).origin, frameOrigin: page.frames[ref] ?? new URL(page.url).origin, doc: page.doc, field: { label: `Field ${ref}`, type: page.types[ref] ?? "text", action: `${SITE}/session`, method: "post" } })),
      fill: async (fills): Promise<Seen> => {
        filled.push(fills);
        return { text: 'textbox "Password" = "(hidden)" @e4', images: [] };
      },
    };
    registry = new ToolRegistry();
    await new ModuleLoader(toolRegistryContext(registry)).load([
      createSecretsModule({ vault: () => secrets.attached(), uses, browser: { unready: () => browser.unready(), where: () => browser.where(), url: () => browser.url(), spots: (r) => browser.spots(r), fill: (f, t) => browser.fill(f, t) }, onDecided: (l) => approvals.onDecided(l), tellOwner: (text) => void told.push(text) }),
    ]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const guarded = (over: Partial<GuardedToolsDeps> = {}): GuardedTools =>
    new GuardedTools({ registry, secrets, audit, approvals, conversationId: "c1", turnId: "t1", owner: true, ownWords: true, ...over });
  const fillLogin = { secret: "", fields: [{ field: "username", target: "@e3" }, { field: "password", target: "@e4" }], intent: "sign in" };
  const loginFill = (): Record<string, unknown> => ({ ...fillLogin, secret: login });
  const decide = async (yes: boolean, remember = false): Promise<void> => {
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const ask = approvals.pending()[0]!;
    const decisions = new Decisions({
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
    if (yes) await decisions.approve(ask.id, "owner", { surface: "dashboard", ...(remember ? { remember: true } : {}) });
    else await decisions.deny(ask.id, "owner");
  };
  const usesOf = (handle: string): string[] => uses.list(handle).map((u) => `${u.outcome}${u.origin ? ` ${u.origin}` : ""}`);

  describe("secrets.list", () => {
    it("names each secret by handle with where it may go, and never a value", async () => {
      const said = (await guarded().execute("secrets.list", {})).content;
      const listed = JSON.parse(said) as { handle: string; usableHere: boolean; fields: string[]; frames?: string[] }[];
      expect(listed.map((s) => s.handle).sort()).toEqual([login, card].sort());
      expect(listed.every((s) => s.usableHere)).toBe(true);
      expect(listed.find((s) => s.handle === card)?.frames).toEqual([PAY]);
      for (const value of [PASSWORD, CARD, "owner\"", "123"]) expect(said).not.toContain(value);
      page.url = "https://example.com/";
      expect((JSON.parse((await guarded().execute("secrets.list", {})).content) as { usableHere: boolean }[]).some((s) => s.usableHere)).toBe(false);
    });

    it("shows a guest nothing, an unattended turn only what allows it, and a chat only what it is for", async () => {
      expect((await guarded({ guest: { project: undefined, chat: "g" } }).execute("secrets.list", {})).content).toBe("No secrets: a guest's turn uses none.");
      expect((await guarded({ attended: false }).execute("secrets.list", {})).content).toMatch(/No saved secrets/);
      vault.update(card, { policy: { unattended: true } });
      vault.update(login, { policy: { chats: ["c2"] } });
      const unattended = JSON.parse((await guarded({ attended: false, conversationId: "c2" }).execute("secrets.list", {})).content) as { handle: string }[];
      expect(unattended.map((s) => s.handle)).toEqual([card]);
      const here = JSON.parse((await guarded().execute("secrets.list", {})).content) as { handle: string }[];
      expect(here.map((s) => s.handle)).toEqual([card]);
    });
  });

  describe("secrets.fill", () => {
    it("asks every time, past Auto and a remembered rule, and names the secret, its fields and the real origin", async () => {
      const running = guarded({ chatMode: () => ({ mode: "auto" }), permissions: { allows: () => true, ruleFor: () => ({ tool: "secrets.fill", scope: null, project: null }) } }).execute("secrets.fill", { ...loginFill(), origin: "https://evil.example", frameOrigins: ["https://evil.example"], doc: "forged", targets: [{ label: "x", type: "password" }] });
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      const ask = approvals.pending()[0]!;
      expect(ask.rule).toBeNull();
      expect(ask.secret).toMatchObject({ handle: login, label: "GitHub", kind: "login", fields: ["username", "password"], origin: SITE, frameOrigins: [], surface: "kos-browser", remember: [] });
      // The origin the model passed is overwritten by the tab's.
      expect(JSON.parse(ask.args)).toMatchObject({ origin: SITE, label: "GitHub", doc: "doc-1", frameOrigins: [SITE, SITE], targets: [{ label: "Field @e3", type: "text" }, { label: "Field @e4", type: "password" }] });
      expect(ask.secret).toMatchObject({ targets: [{ field: "username", label: "Field @e3", type: "text" }, { field: "password", label: "Field @e4", type: "password" }], formAction: `${SITE}/session` });
      expect(summarizeAction(ask.tool, ask.args)).toBe(`Fill username and password from GitHub (${login})`);
      const view = askView({ tool: ask.tool, args: ask.args, secret: ask.secret });
      expect(view).toMatchObject({ alwaysNote: "Secrets always ask", secret: { origin: SITE } });
      expect(view.always).toBeUndefined();
      expect(filled).toHaveLength(0);
      await decide(true);
      const done = await running;
      expect(done.isError).toBe(false);
      expect(filled[0]!.map((f) => [f.ref, f.value, f.expect.slot, f.expect.origin])).toEqual([
        ["@e3", "owner", "username", SITE],
        ["@e4", PASSWORD, "password", SITE],
      ]);
      expect(done.content).toContain(`Filled username and password from GitHub (${login}) on ${SITE}`);
      const [use] = uses.list(login);
      expect(use).toMatchObject({ outcome: "filled", origin: SITE, surface: "kos-browser", fields: ["username", "password"], approvalId: ask.id, decidedBy: "owner" });
      // Nothing kept or said holds the value.
      const kept = JSON.stringify([ws.db.prepare("SELECT * FROM pending_actions").all(), ws.db.prepare("SELECT * FROM audit_log").all(), ws.db.prepare("SELECT * FROM secret_uses").all(), done]);
      expect(kept).not.toContain(PASSWORD);
    });

    it("refuses before asking where the secret may not go, and records why", async () => {
      page.url = "https://github.com.evil.example/login";
      const off = await guarded().execute("secrets.fill", loginFill());
      expect(off).toMatchObject({ isError: true });
      expect(off.content).toMatch(/GitHub is not allowed on https:\/\/github\.com\.evil\.example; it is for https:\/\/github\.com.*secrets\.allow_site/);
      page.url = `${SITE}/pay`;
      page.frames = { "@e9": "https://evil-pay.example" };
      const framed = await guarded().execute("secrets.fill", { secret: card, fields: [{ field: "number", target: "@e9" }] });
      expect(framed.content).toMatch(/@e9 is in a frame from https:\/\/evil-pay\.example/);
      page.frames = { "@e9": PAY };
      const wrong = await guarded().execute("secrets.fill", { secret: login, fields: [{ field: "number", target: "@e9" }] });
      expect(wrong.content).toMatch(/A login has no field "number"/);
      expect(approvals.pending()).toHaveLength(0);
      expect(usesOf(login)).toEqual(["refused:origin https://github.com.evil.example"]);
      expect(usesOf(card)).toEqual(["refused:origin https://github.com"]);
      expect(filled).toHaveLength(0);
    });

    it("never fills for a guest, and an unattended turn only on a site the owner said always for", async () => {
      const guest = await guarded({ guest: { project: undefined, chat: "g" } }).execute("secrets.fill", loginFill());
      expect(guest.content).toMatch(/a guest's turn never uses a secret/);
      vault.update(login, { policy: { unattended: true, ask: "site" } });
      const alone = await guarded({ attended: false, waitForApproval: false }).execute("secrets.fill", loginFill());
      expect(alone.content).toMatch(/needs the owner present/);
      expect(approvals.pending()).toHaveLength(0);
      vault.addGrant(login, SITE);
      const granted = await guarded({ attended: false, waitForApproval: false }).execute("secrets.fill", loginFill());
      expect(granted.isError).toBe(false);
      expect(filled).toHaveLength(1);
      expect(usesOf(login)).toEqual([`filled ${SITE}`, `refused:unattended ${SITE}`, "refused:policy"]);
    });

    it("keeps a yes for the turn when the secret asks once a turn", async () => {
      vault.update(login, { policy: { ask: "turn" } });
      const first = guarded().execute("secrets.fill", loginFill());
      await decide(true);
      expect((await first).isError).toBe(false);
      expect((await guarded().execute("secrets.fill", { ...loginFill(), intent: "again" })).isError).toBe(false);
      expect(filled).toHaveLength(2);
      expect(audit.recent()[0]).toMatchObject({ tool: "secrets.fill", approvedBy: GRANT_DECIDER });
      // Another turn is asked again.
      void guarded({ turnId: "t2" }).execute("secrets.fill", loginFill());
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    });

    it("offers always on the site for a site policy, kept as a grant in the vault, never as a rule", async () => {
      vault.update(login, { policy: { ask: "site" } });
      const first = guarded().execute("secrets.fill", loginFill());
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      const ask = approvals.pending()[0]!;
      expect(askView({ tool: ask.tool, args: ask.args, secret: ask.secret })).toMatchObject({ always: "Approve, and always on github.com" });
      await decide(true, true);
      await first;
      expect(vault.get(login)?.policy.grants.map((g) => g.origin)).toEqual([SITE]);
      expect(rules).toEqual([]);
      expect((await guarded({ turnId: "t9" }).execute("secrets.fill", loginFill())).isError).toBe(false);
      expect(filled).toHaveLength(2);
      expect(audit.recent()[0]).toMatchObject({ approvedBy: GRANT_DECIDER });
    });

    it("records a denied fill and fills nothing", async () => {
      const running = guarded().execute("secrets.fill", loginFill());
      await decide(false);
      expect((await running).content).toMatch(/The owner denied this/);
      expect(filled).toHaveLength(0);
      expect(uses.list(login)[0]).toMatchObject({ outcome: "denied", origin: SITE, decidedBy: "owner" });
    });

    it("is never decided on a chat surface", async () => {
      void guarded().execute("secrets.fill", loginFill());
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      const ask = approvals.pending()[0]!;
      const decisions = new Decisions({ ownerId: "owner", approvals, permissions: { add: () => undefined }, audit, registry, secrets, queue: { enqueue: (w) => w() }, inConversation: (_i, w) => w(), onToolRan: () => undefined, handleMessage: async () => ({ reply: "" }) });
      expect(await decisions.approve(ask.id, "owner", { surface: "discord" })).toMatchObject({ ok: false, message: expect.stringMatching(/Decide on the dashboard or a paired device/) });
      expect(approvals.get(ask.id)?.status).toBe("pending");
    });

    it("fills in the owner's Chrome with the same ask, decided beside it, and records the device", async () => {
      place = { surface: "chrome", device: { id: "dev_chrome", name: "Chrome on macOS" } };
      const running = guarded().execute("secrets.fill", { ...loginFill(), surface: "kos-browser", device: "forged" });
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      const ask = approvals.pending()[0]!;
      // Where it goes is read from the tab, never the model.
      expect(ask.secret).toMatchObject({ handle: login, origin: SITE, surface: "chrome", device: "Chrome on macOS" });
      expect(JSON.parse(ask.args)).toMatchObject({ surface: "chrome", device: "Chrome on macOS" });
      const decisions = new Decisions({ ownerId: "owner", approvals, permissions: { add: () => undefined }, audit, registry, secrets, queue: { enqueue: (w) => w() }, inConversation: (_i, w) => w(), onToolRan: () => undefined, handleMessage: async () => ({ reply: "" }) });
      for (const chat of ["discord", "sms", "imessage"]) expect(await decisions.approve(ask.id, "owner", { surface: chat })).toMatchObject({ ok: false });
      await decisions.approve(ask.id, "dev_chrome", { surface: "chrome" });
      const done = await running;
      expect(done.content).toContain(`on ${SITE}, in the owner's Chrome (Chrome on macOS).`);
      expect(filled[0]!.map((f) => f.value)).toEqual(["owner", PASSWORD]);
      expect(uses.list(login)[0]).toMatchObject({ outcome: "filled", surface: "chrome", deviceId: "dev_chrome", origin: SITE });
    });

    it("refuses a fill approved in one browser once the tab is in the other", async () => {
      place = { surface: "chrome", device: { id: "dev_chrome", name: "Chrome on macOS" } };
      const running = guarded().execute("secrets.fill", loginFill());
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      place = { surface: "kos-browser" };
      await decide(true);
      expect((await running).content).toMatch(/the page changed since you approved/);
      expect(filled).toHaveLength(0);
      expect(uses.list(login)[0]?.outcome).toBe("refused:changed");
    });

    it("refuses a fill approved for one Chrome once the session is on another device", async () => {
      place = { surface: "chrome", device: { id: "dev_chrome", name: "Chrome on macOS" } };
      const running = guarded().execute("secrets.fill", { ...loginFill(), deviceId: "forged" });
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      // The approved device is stamped from the tab, never the model's.
      expect(JSON.parse(approvals.pending()[0]!.args)).toMatchObject({ deviceId: "dev_chrome" });
      place = { surface: "chrome", device: { id: "dev_other", name: "Chrome on Linux" } };
      await decide(true);
      expect((await running).content).toMatch(/another Chrome now/);
      expect(filled).toHaveLength(0);
      expect(uses.list(login)[0]).toMatchObject({ outcome: "refused:changed", deviceId: "dev_other" });
    });

    it("splits a card's expiry for two fields and goes into a payment frame the card allows", async () => {
      page.url = `${SITE}/pay`;
      page.frames = { "@e9": PAY, "@e10": PAY, "@e11": PAY };
      const running = guarded().execute("secrets.fill", { secret: card, fields: [{ field: "number", target: "@e9" }, { field: "expiry.month", target: "@e10" }, { field: "expiry.year", target: "@e11" }] });
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      expect(approvals.pending()[0]!.secret).toMatchObject({ frameOrigins: [PAY], fields: ["number", "expiry"] });
      await decide(true);
      await running;
      expect(filled[0]!.map((f) => [f.value, f.expect.slot, f.expect.frameOrigin])).toEqual([
        [CARD, "card-number", PAY],
        ["04", "card-exp-month", PAY],
        ["29", "card-exp-year", PAY],
      ]);
      expect(uses.list(card)[0]).toMatchObject({ outcome: "filled", origin: SITE, frameOrigin: PAY });
    });

    it("says a refused fill without its value, and records it", async () => {
      browser.fill = async () => {
        throw Object.assign(new Error("@e4: a search field does not take a password"), { code: "field" });
      };
      const running = guarded().execute("secrets.fill", loginFill());
      await decide(true);
      const done = await running;
      expect(done.content).toMatch(/Not filled: @e4: a search field does not take a password/);
      expect(done.content).not.toContain(PASSWORD);
      expect(uses.list(login)[0]?.outcome).toBe("refused:field");
    });
  });

  describe("secrets.allow_site", () => {
    it("asks with the tab's real origin and adds it on a yes", async () => {
      page.url = "https://gist.github.com/new";
      const running = guarded().execute("secrets.allow_site", { secret: login, why: "the gist page signs in on its own host" });
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      const ask = approvals.pending()[0]!;
      expect(summarizeAction(ask.tool, ask.args)).toBe(`Allow GitHub (${login}) on https://gist.github.com`);
      expect(askView({ tool: ask.tool, args: ask.args, secret: ask.secret }).always).toBeUndefined();
      await decide(true);
      expect((await running).isError).toBe(false);
      expect(vault.get(login)?.use.web.origins).toEqual([SITE, "https://gist.github.com"]);
      expect((await guarded().execute("secrets.allow_site", { secret: login, why: "x" })).content).toMatch(/already allowed/);
    });

    it("asks about the tab's origin and the vault's label, whatever the model passed for them", async () => {
      page.url = "https://gist.github.com/new";
      void guarded().execute("secrets.allow_site", { secret: login, why: "x", origin: "https://github.com", label: "Your bank", frameOrigins: ["https://evil.example"] });
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      const args = JSON.parse(approvals.pending()[0]!.args) as Record<string, unknown>;
      expect(args).toMatchObject({ origin: "https://gist.github.com", label: "GitHub" });
      expect(args).not.toHaveProperty("frameOrigins");
    });
  });

  describe("secrets.request", () => {
    it("hands back the secret the owner saved after the ask", async () => {
      const running = guarded().execute("secrets.request", { kind: "apikey", label: "Stripe", why: "to read your balance" });
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      expect(summarizeAction("secrets.request", approvals.pending()[0]!.args)).toBe("Add an API key KOS calls “Stripe”, for KOS to use without seeing it");
      const handle = vault.add({ label: "Stripe", kind: "apikey", values: { token: "sk_test_unit_0000000000000000" } });
      await decide(true);
      const done = await running;
      expect(done.content).toContain(`The owner saved Stripe as ${handle}`);
      expect(done.content).not.toContain("sk_test_unit");
    });
  });

  describe("what a grant and a turn are held to", () => {
    it("covers a site's grant only for secrets going into password boxes", async () => {
      vault.update(login, { policy: { ask: "site" } });
      vault.addGrant(login, SITE);
      page.types = { "@e4": "text" };
      void guarded().execute("secrets.fill", loginFill());
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      // Nor does the card offer to keep one there.
      expect(approvals.pending()[0]!.secret?.remember).toEqual([]);
      expect(filled).toHaveLength(0);
    });

    it("tells the owner once when a turn is refused a secret again and again", async () => {
      page.url = "https://elsewhere.example/";
      for (let i = 0; i < 4; i++) await guarded().execute("secrets.fill", { ...loginFill(), intent: `try ${i}` });
      expect(told).toHaveLength(1);
      expect(told[0]).toMatch(/refused GitHub .* 3 times in one turn/);
    });

    it("lets a turn ask to allow new sites three times at most", async () => {
      const asked: string[] = [];
      for (const host of ["a", "b", "c", "d"]) {
        page.url = `https://${host}.example/`;
        const tools = guarded({ waitForApproval: false });
        asked.push((await tools.execute("secrets.allow_site", { secret: login, why: host })).content);
      }
      expect(asked.slice(0, 3).every((a) => a.startsWith("Queued for approval"))).toBe(true);
      expect(asked[3]).toMatch(/asked to allow secrets on new sites 3 times already/);
      expect(told).toEqual([expect.stringMatching(/asked to allow GitHub .* more than 3 times in one turn, the last on https:\/\/d\.example/)]);
    });
  });
});


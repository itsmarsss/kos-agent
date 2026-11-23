import { describe, expect, it } from "vitest";

import { DETACHED_WORDS } from "@kos/shared";

import { approvalButtons, approvalCard, settledText } from "./askcard.js";
import { DiscordAdapter } from "./discord.js";
import { approvalLines } from "./imessage.js";
import type { ApprovalRequest } from "./types.js";

interface Button {
  label?: string;
  style: number;
  custom_id?: string;
  url?: string;
}

const buttons = (req: ApprovalRequest, url?: string): Button[] => approvalButtons(req, url).toJSON().components as unknown as Button[];

const browserAsk: ApprovalRequest = {
  id: "40",
  text: "x",
  tool: "browser.act",
  args: { intent: "submit the form", url: "https://docs.google.com/forms/x", steps: [{ click: "@e1" }, { press: "Enter" }] },
  reason: "Clicks, types or fills on the page",
  rule: { tool: "browser.act", scope: "site:docs.google.com", project: null },
};

describe("an approval card drawn from the ask view", () => {
  it("is titled by what it acts on, with KOS's words small, the place, numbered steps and the risk", () => {
    const lines = approvalCard(browserAsk).content.split("\n");
    expect(lines).toEqual([
      "**Needs your OK** · Act on the page",
      "-# KOS says: “submit the form”",
      "-# In KOS's browser on docs.google.com",
      "1. Click element e1",
      "2. Press `⏎`",
      "-# ⚠ Clicks, types or fills on the page · browser.act · #40",
    ]);
  });

  it("counts down to its lapse with Discord's own relative time, which Discord keeps current", () => {
    const at = Date.UTC(2026, 10, 19, 12, 0, 0);
    const card = approvalCard({ ...browserAsk, expiresAt: at });
    expect(card.content.split("\n").at(-1)).toBe(`-# ⚠ Clicks, types or fills on the page · browser.act · #40 · lapses <t:${at / 1000}:R>`);
  });

  it("offers Approve, Deny and the remembered yes by its site, in that order, only where the rule allows", () => {
    expect(buttons(browserAsk).map((b) => b.label)).toEqual(["Approve", "Deny", "Always allow on docs.google.com"]);
    // No rule, or Auto never covers it: no remembered yes, and the card says why.
    expect(buttons({ ...browserAsk, rule: undefined }).map((b) => b.label)).toEqual(["Approve", "Deny"]);
    const beyond = { ...browserAsk, beyondAuto: true };
    expect(buttons(beyond).map((b) => b.label)).toEqual(["Approve", "Deny"]);
    expect(approvalCard(beyond).content).toContain("Auto never covers this");
  });

  it("warns before any yes when no turn waits on the result, and the text surfaces say so too", () => {
    const later: ApprovalRequest = { id: "43", text: "x", tool: "sql", args: { sql: "DELETE FROM notes" }, detached: "unwaited" };
    expect(approvalCard(later).content).toContain(`⚠ ${DETACHED_WORDS.unwaited}`);
    expect(approvalLines(later)).toContain(DETACHED_WORDS.unwaited);
    expect(approvalCard({ ...later, detached: undefined }).content).not.toContain("⚠ Nothing is waiting");
  });

  it("attaches the whole call as call.json when a step is cut", () => {
    const typed = "y".repeat(500);
    const card = approvalCard({ id: "41", text: "x", tool: "computer.act", args: { actions: [{ action: "type", text: typed }] } });
    expect(card.content).toContain("the whole call is in call.json");
    const call = card.files?.find((f) => f.name === "call.json");
    expect(JSON.parse(call!.attachment.toString("utf8"))).toEqual({ actions: [{ action: "type", text: typed }] });
  });

  it("puts steps that do not fit in steps.txt and the whole call in call.json", () => {
    const steps = Array.from({ length: 60 }, (_, i) => ({ fill: { target: `@e${i}`, text: `${i} ${"x".repeat(120)}` } }));
    const card = approvalCard({ id: "42", text: "x", tool: "browser.act", args: { steps } });
    expect(card.content.length).toBeLessThanOrEqual(1900);
    expect(card.files?.map((f) => f.name)).toEqual(["steps.txt", "call.json"]);
  });
});

describe("a secret's card", () => {
  const secretAsk: ApprovalRequest = {
    id: "77",
    text: "x",
    tool: "secrets.fill",
    args: { handle: "github", fields: ["password"] },
    secret: {
      handle: "github",
      label: "GitHub",
      kind: "login",
      fields: ["password"],
      origin: "https://github.com",
      frameOrigins: [],
      surface: "browser",
      warnings: ["Never used on this site before"],
      remember: ["turn"],
    } as unknown as NonNullable<ApprovalRequest["secret"]>,
  };

  it("has no Approve, and links to the exact ask on the dashboard", () => {
    const shown = buttons(secretAsk, "https://kos.example.com");
    expect(shown.map((b) => b.label)).toEqual(["Decide on the dashboard", "Deny"]);
    expect(shown[0]?.url).toBe("https://kos.example.com/#/inbox/77");
    const card = approvalCard(secretAsk, { dashboardUrl: "https://kos.example.com" });
    expect(card.secret).toBe(true);
    expect(card.content).toContain("**KOS asks to use a secret** · GitHub");
    expect(card.content).toContain("-# On github.com · fills password");
    expect(card.content).toContain("-# ⚠ Never used on this site before");
    expect(card.content).not.toContain("call.json");
  });

  it("says where to decide in words when the dashboard is only on this machine", () => {
    expect(buttons(secretAsk, "http://localhost:4317").map((b) => b.label)).toEqual(["Deny"]);
    expect(approvalCard(secretAsk, { dashboardUrl: "http://localhost:4317" }).content).toContain("the dashboard's Inbox, #77");
  });

  it("is a secret's card for any call that places one, whatever it is called", () => {
    const ref = { id: "78", text: "x", tool: "shell.run", args: { command: "curl -u me:{{secret:github}} https://api.github.com" } };
    expect(buttons(ref, "https://kos.example.com").map((b) => b.label)).toEqual(["Decide on the dashboard", "Deny"]);
  });

  it("is posted with no Approve button", async () => {
    const payloads: { components: { toJSON(): { components: Button[] } }[] }[] = [];
    const adapter = new DiscordAdapter({ token: "t", dashboardUrl: "https://kos.example.com" });
    (adapter as unknown as { client: { users: unknown } }).client = {
      users: { fetch: async () => ({ send: async (p: (typeof payloads)[number]) => (payloads.push(p), { id: "m", edit: async () => undefined }) }) },
    };
    await adapter.requestApproval("owner-id", secretAsk);
    const labels = payloads[0]!.components[0]!.toJSON().components.map((b) => b.label);
    expect(labels).toEqual(["Decide on the dashboard", "Deny"]);
  });
});

describe("a settled card", () => {
  it("says who decided and when", () => {
    const at = Date.UTC(2026, 10, 19, 9, 30);
    expect(settledText("approved", "Run: rm -rf build", "12", false, false, { by: "you", at })).toBe(`-# ✅ Approved by you <t:${at / 1000}:t> · Run \`rm -rf build\``);
    expect(settledText("approved", undefined, "12", false, false, { by: "auto mode", at })).toBe(`-# ✅ Approved by auto mode <t:${at / 1000}:t> · #12`);
    // A lapse was nobody's.
    expect(settledText("expired", undefined, "12", false, false, { by: "you", at })).toBe(`-# ⌛ Lapsed <t:${at / 1000}:t> · #12`);
  });

  it("is edited to the outcome when the ask was decided somewhere else", async () => {
    const edits: { content: string }[] = [];
    const adapter = new DiscordAdapter({ token: "t" });
    (adapter as unknown as { client: { users: unknown } }).client = {
      users: { fetch: async () => ({ send: async () => ({ id: "m", edit: async (p: { content: string }) => void edits.push(p) }) }) },
    };
    await adapter.requestApproval("owner-id", browserAsk);
    await adapter.settleApproval("40", "denied", { by: "you", at: 1_700_000_000_000 });
    expect(edits[0]?.content).toBe("-# ❌ Denied by you <t:1700000000:t> · Submit the form");
  });

  it("names the member who pressed", async () => {
    const adapter = new DiscordAdapter({ token: "t" });
    adapter.setAuthorizer(() => true);
    adapter.onApproval(() => ({ outcome: "approved" }));
    const edits: { content: string }[] = [];
    const press = {
      isButton: () => true,
      customId: "kos:approve:9",
      user: { id: "owner", username: "kenny", globalName: "Kenny" },
      deferUpdate: async () => undefined,
      editReply: async (p: { content: string }) => void edits.push(p),
      reply: async () => undefined,
    };
    await adapter.receiveInteraction(press as never);
    expect(edits[0]?.content).toMatch(/^-# ✅ Approved by Kenny <t:\d+:t> · #9$/);
  });
});

